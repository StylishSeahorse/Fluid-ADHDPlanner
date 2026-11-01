/**
 * The replan orchestrator (§13.C–D): the bridge between stored rows and the
 * pure scheduler, and the only code that decides what a plan may change.
 *
 *   1. Read the world: eligible tasks (one function), busy time, pinned and
 *      running sessions, the plan in force, the user's mode.
 *   2. Run the engine. Its output is checked against the hard constraints; a
 *      plan that fails the check is discarded, loudly, and never stored.
 *   3. Diff it against the plan in force, and let the mode gate decide:
 *      apply it (with undo), propose it, or — when nothing changed — drop it
 *      without a trace (no plan version for an unchanged input).
 *   4. Write it in one transaction under a per-user advisory lock, and only if
 *      nobody else changed the plan since step 1 (`planEpoch`); otherwise
 *      start again from fresh inputs.
 *
 * Nothing here writes to a calendar. Accepted sessions reach it through the
 * sync outbox.
 */
import 'server-only';
import { createHash } from 'node:crypto';
import {
  describeExplanation,
  diffPlans,
  gatePlan,
  plan as runScheduler,
  PlanInvariantError,
  summarizeChanges,
  type GateChange,
  type GateDecision,
  type PlannedBlock,
  type SchedulingInput,
} from '@fluid/core';
import { prisma, type Prisma } from '@fluid/db';
import { applyAiOrderingHint, consentFrom } from './ai-scheduler';
import { eligibleTasks } from './eligibility';
import { externalEvents } from './external-events';

/** A calendar that has not synced for this long makes the plan "stale". */
const STALE_CALENDAR_MS = 6 * 60 * 60_000;
const MAX_HORIZON_DAYS = 90;

export type ReplanTrigger =
  | 'manual'
  | 'schedule_day'
  | 'task_changed'
  | 'task_completed'
  | 'task_skipped'
  | 'task_overran'
  | 'new_urgent_task'
  | 'commitment_changed'
  | 'external_event_conflict'
  | 'calendar_synced'
  | 'settings_changed'
  | 'missed_session'
  | 'undo'
  | 'overtime_approved'
  | 'daily_rollover';

export interface ReplanOptions {
  trigger: ReplanTrigger;
  /** A person pressed a button for this ("Schedule my day", "Find the time"). */
  requested?: boolean;
  /** Caused by the user's own action just now: it disrupts them less. */
  userInitiated?: boolean;
  /** Ask, whatever the mode would do (undo's knock-on effects). */
  forcePropose?: boolean;
}

export interface Issues {
  unscheduled: Array<{ taskId: string; title: string; reason: string; explanation: string; shortfallMinutes: number; hard: boolean }>;
  spilled: Array<{ taskId: string; title: string; explanation: string; spilledMinutes: number; committedDay: string }>;
}

export interface StoredOvertime {
  taskId: string;
  title: string;
  intervals: Array<{ start: string; end: string }>;
  minutes: number;
  shortfallMinutes: number;
  explanation: string;
  status: 'pending' | 'approved' | 'dismissed';
}

export interface ReplanOutcome {
  status: 'applied' | 'proposed' | 'unchanged' | 'busy' | 'invalid';
  planVersionId: string | null;
  summary: string;
  decision: GateDecision | null;
}

class EpochChanged extends Error {}

/** A JSON column read back as a list, whatever was (or was not) stored. */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

type Tx = Prisma.TransactionClient;

const json = (value: unknown) => value as Prisma.InputJsonValue;

/** Number each task's sessions 1..n by start, the identity the diff matches on. */
function numberByTask<T extends { taskId: string; start: Date }>(blocks: T[]): Array<T & { chunkIndex: number; chunkCount: number }> {
  const byTask = new Map<string, T[]>();
  for (const block of [...blocks].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    byTask.set(block.taskId, [...(byTask.get(block.taskId) ?? []), block]);
  }
  return [...byTask.values()].flatMap((list) => list.map((block, index) => ({ ...block, chunkIndex: index + 1, chunkCount: list.length })));
}

/**
 * Replan for one user. Safe to call from anywhere — a button, a queued
 * trigger, a sweep — because the write is serialized and epoch-checked.
 */
export async function replan(userId: string, options: ReplanOptions, attempt = 0): Promise<ReplanOutcome> {
  try {
    return await replanOnce(userId, options);
  } catch (error) {
    if (error instanceof EpochChanged && attempt < 2) return replan(userId, options, attempt + 1);
    if (error instanceof EpochChanged) return { status: 'busy', planVersionId: null, summary: 'Your plan is changing elsewhere — try again in a moment.', decision: null };
    throw error;
  }
}

async function replanOnce(userId: string, options: ReplanOptions): Promise<ReplanOutcome> {
  const now = new Date();
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { preferences: true, aiSetting: true },
  });
  const preferences = user.preferences;
  const mode = preferences?.schedulingMode ?? 'ASSISTED';
  const horizonDays = Math.min(MAX_HORIZON_DAYS, Math.max(1, preferences?.horizonDays ?? 14));
  const epoch = user.planEpoch;

  const [eligibility, workingHours, energyWindows, protectedTimes, busyEvents, liveBlocks, connections] = await Promise.all([
    eligibleTasks(userId, { now, timeZone: user.timeZone, horizonDays, mode }),
    prisma.workingHours.findMany({ where: { userId } }),
    prisma.energyWindow.findMany({ where: { userId } }),
    prisma.protectedTime.findMany({ where: { userId } }),
    externalEvents(userId, { from: now, to: new Date(now.getTime() + (horizonDays + 1) * 86_400_000) }),
    prisma.scheduledBlock.findMany({
      where: { task: { userId }, state: 'ACCEPTED', endsAt: { gt: now } },
      include: { task: { select: { timerStartedAt: true, title: true } } },
    }),
    prisma.calendarConnection.findMany({
      where: { userId, status: 'ACTIVE', calendars: { some: { isSelected: true } } },
      select: { lastSyncAt: true, createdAt: true },
    }),
  ]);

  // A session being worked right now is as fixed as a pinned one: the engine
  // may not move what someone is in the middle of.
  const running = (block: (typeof liveBlocks)[number]) => block.startsAt <= now && block.task.timerStartedAt !== null;
  const fixed = liveBlocks.filter((block) => block.isPinned || running(block));
  const inForce = numberByTask(
    liveBlocks
      .filter((block) => !block.isPinned && !running(block))
      .map((block) => ({ ...block, start: block.startsAt, end: block.endsAt })),
  );
  const previous: PlannedBlock[] = inForce.map((block) => ({
    taskId: block.taskId,
    start: block.startsAt,
    end: block.endsAt,
    isPinned: false,
    chunkIndex: block.chunkIndex,
    chunkCount: block.chunkCount,
    ...(block.committedDay ? { committedDay: block.committedDay } : {}),
  }));

  const staleSince = connections
    .map((connection) => connection.lastSyncAt ?? connection.createdAt)
    .filter((at) => now.getTime() - at.getTime() > STALE_CALENDAR_MS)
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

  const input: SchedulingInput = {
    now,
    timeZone: user.timeZone,
    horizonDays,
    tasks: eligibility.schedulable,
    busy: busyEvents.map((event) => ({ start: event.startsAt, end: event.endsAt, id: event.id, title: event.title })),
    pinned: fixed.map((block) => ({ taskId: block.taskId, blockId: block.id, start: block.startsAt, end: block.endsAt })),
    workingHours,
    energyWindows,
    protectedTimes,
    preferences: {
      bufferMinutes: preferences?.bufferMinutes ?? 10,
      slotGranularityMinutes: 15,
      maxDailyWorkMinutes: preferences?.maxDailyWorkMinutes ?? null,
    },
    previous,
    quietHours:
      preferences?.quietHoursStart && preferences.quietHoursEnd
        ? { start: preferences.quietHoursStart, end: preferences.quietHoursEnd }
        : null,
  };

  // --- AI ordering hint, if allowed: a tie-break inside a rank tier only ----
  const ordering = await applyAiOrderingHint({
    userId,
    now,
    timeZone: user.timeZone,
    workingHoursCount: workingHours.length,
    tasks: eligibility.schedulable,
    rawTasks: eligibility.rows,
    consent: consentFrom(user.aiSetting),
  });

  // --- The deterministic engine decides, always -----------------------------
  let result: ReturnType<typeof runScheduler>;
  try {
    result = runScheduler({ ...input, tasks: ordering.tasks });
  } catch (error) {
    if (error instanceof PlanInvariantError) {
      // Never store a plan that breaks a hard constraint. This is a bug in the
      // engine, not something the user did; say so in the log, keep the plan
      // in force, and tell them nothing changed.
      console.error('[planning] engine produced an invalid plan for', userId, error.violations);
      return { status: 'invalid', planVersionId: null, summary: 'Fluid could not make a safe plan just now. Your current plan stands.', decision: null };
    }
    throw error;
  }

  const titles = new Map(eligibility.rows.map((task) => [task.id, task.title]));
  for (const block of fixed) titles.set(block.taskId, block.task.title);
  const next = result.blocks.filter((block) => !block.isPinned);
  const changes = diffPlans(previous, next, {
    timeZone: user.timeZone,
    now,
    taskTitles: titles,
    trigger: options.trigger,
    assumedEstimates: new Set(eligibility.rows.filter((task) => task.estimateAssumed).map((task) => task.id)),
    displacedFor: new Map(result.displaced.map((entry) => [entry.taskId, entry.forTaskId])),
  });

  // --- The gate --------------------------------------------------------------
  const inForceByKey = new Map(inForce.map((block) => [`${block.taskId}@${block.startsAt.getTime()}`, block]));
  const gateChanges: GateChange[] = changes.map((change) => ({
    ...change,
    previousAccepted: true,
    loggedMinutes: change.previous ? (inForceByKey.get(`${change.taskId}@${change.previous.start.getTime()}`)?.actualMinutes ?? 0) : 0,
  }));
  // Pushing committed work off its day counts only when a replan does it: the
  // first placement of an over-full day is the commitment itself.
  const spillsCommitment = result.spilled.some((spill) => {
    const before = inForce.filter((block) => block.taskId === spill.taskId);
    return before.length > 0 && before.every((block) => block.startsAt >= spill.committedTo.start && block.endsAt <= spill.committedTo.end);
  });
  let decision = gatePlan({
    mode,
    changes: gateChanges,
    now,
    timeZone: user.timeZone,
    requested: options.requested ?? false,
    userInitiated: options.userInitiated ?? false,
    hybridThreshold: preferences?.hybridThreshold ?? 4,
    maxDailyReshuffles: preferences?.maxDailyReshuffles ?? 3,
    autoAcceptSeconds: preferences?.autoAcceptSeconds ?? 0,
    overtimeProposals: result.overtimeProposals.length,
    spillsCommitment,
    recoversMissedPin: options.trigger === 'missed_session',
    staleCalendar: staleSince !== null,
    granularityMinutes: 15,
  });
  if (options.forcePropose && decision.action === 'APPLY') {
    decision = { ...decision, action: 'PROPOSE', autoAcceptAt: null, reason: 'Undoing a change always asks before moving anything else.' };
  }

  const issues: Issues = {
    unscheduled: result.unscheduled.map((entry) => ({
      taskId: entry.taskId,
      title: titles.get(entry.taskId) ?? 'Task',
      reason: entry.reason,
      explanation: entry.explanation,
      shortfallMinutes: entry.shortfallMinutes,
      hard: eligibility.rows.find((task) => task.id === entry.taskId)?.deadlineKind === 'HARD',
    })),
    spilled: result.spilled.map((entry) => ({
      taskId: entry.taskId,
      title: titles.get(entry.taskId) ?? 'Task',
      explanation: entry.explanation,
      spilledMinutes: entry.spilledMinutes,
      committedDay: entry.committedTo.start.toISOString(),
    })),
  };
  const overtime: StoredOvertime[] = result.overtimeProposals.map((proposal) => ({
    taskId: proposal.taskId,
    title: titles.get(proposal.taskId) ?? 'Task',
    intervals: proposal.intervals.map((interval) => ({ start: interval.start.toISOString(), end: interval.end.toISOString() })),
    minutes: proposal.minutes,
    shortfallMinutes: proposal.shortfallMinutes,
    explanation: proposal.explanation,
    status: 'pending',
  }));

  if (decision.action === 'DISCARD') {
    // Nothing to show or ask. Keep the resolve tray honest, though: the
    // problems may have changed even when the sessions did not.
    const latest = await prisma.planVersion.findFirst({
      where: { userId, status: { in: ['PROPOSED', 'ACCEPTED'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (latest) await prisma.planVersion.update({ where: { id: latest.id }, data: { issues: json(issues), staleCalendarSince: staleSince } });
    return { status: 'unchanged', planVersionId: null, summary: 'Nothing needed to change.', decision };
  }

  // --- Explanations, rendered once, stored with the sessions -----------------
  const explainContext = {
    timeZone: user.timeZone,
    now,
    tasks: new Map(
      eligibility.rows.map((task) => [
        task.id,
        { title: task.title, priority: task.priority, deadline: task.deadline, deadlineKind: task.deadlineKind },
      ]),
    ),
  };
  for (const block of fixed) {
    if (!explainContext.tasks.has(block.taskId)) explainContext.tasks.set(block.taskId, { title: block.task.title, priority: 'MEDIUM', deadline: null, deadlineKind: 'SOFT' });
  }

  const inputDigest = createHash('sha256').update(JSON.stringify({ ...input, tasks: ordering.tasks })).digest('hex');
  const apply = decision.action === 'APPLY';

  const planVersionId = await prisma.$transaction(
    async (tx) => {
      await lockUser(tx, userId);
      const current = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { planEpoch: true } });
      if (current.planEpoch !== epoch) throw new EpochChanged();

      await supersedeProposals(tx, userId, now);

      const version = await tx.planVersion.create({
        data: {
          userId,
          trigger: options.trigger,
          usedAi: ordering.usedAi,
          status: 'PROPOSED',
          disruptionScore: decision.disruption,
          gateReason: decision.reason,
          issues: json(issues),
          // Left out when empty rather than Prisma.DbNull: under Next's dev
          // bundler a second copy of that sentinel can arrive as `{}`.
          ...(overtime.length > 0 ? { overtimeProposals: json(overtime) } : {}),
          staleCalendarSince: staleSince,
          inputDigest,
          changes: {
            create: changes.map((change) => ({
              kind: change.kind,
              taskId: change.taskId,
              previousStartsAt: change.previous?.start ?? null,
              previousEndsAt: change.previous?.end ?? null,
              newStartsAt: change.next?.start ?? null,
              newEndsAt: change.next?.end ?? null,
              reason: change.reason,
            })),
          },
        },
      });

      if (next.length > 0) {
        await tx.scheduledBlock.createMany({
          data: next.map((block) => ({
            taskId: block.taskId,
            userId,
            startsAt: block.start,
            endsAt: block.end,
            state: 'PROPOSED' as const,
            planVersionId: version.id,
            committedDay: block.committedDay ?? null,
            ...(block.explanation ? { explanation: json(block.explanation) } : {}),
            explanationText: block.explanation ? describeExplanation(block.taskId, block.start, block.explanation, explainContext) : null,
          })),
        });
      }

      if (apply) await acceptInTx(tx, userId, version.id, now, 'gate');
      await tx.user.update({ where: { id: userId }, data: { planEpoch: { increment: 1 } } });
      return version.id;
    },
    { timeout: 20_000, maxWait: 10_000 },
  );

  return {
    status: apply ? 'applied' : 'proposed',
    planVersionId,
    summary: summarizeChanges(changes, options.trigger),
    decision,
  };
}

/** Serialize plan writes per user (§13.D). Held until the transaction ends. */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  // $executeRaw, not $queryRaw: the function returns void, which the client cannot decode.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`replan:${userId}`}))`;
}

/** Anything still awaiting a decision is superseded by a newer plan. */
async function supersedeProposals(tx: Tx, userId: string, now: Date): Promise<void> {
  await tx.planVersion.updateMany({
    where: { userId, status: 'PROPOSED' },
    data: { status: 'SUPERSEDED', respondedAt: now },
  });
  await tx.scheduledBlock.deleteMany({ where: { task: { userId }, state: 'PROPOSED', isPinned: false } });
}

/**
 * Make a proposal the plan in force.
 *
 * The proposal is a complete schedule, not a patch: the stability pass
 * re-emits every session it kept. So the sessions it replaces are retired
 * here — or each replan-and-accept cycle would leave duplicates behind. Spared:
 *   - sessions already over, which are history, not plan;
 *   - pinned sessions, which the engine never owns;
 *   - the session being worked right now (its timer is running);
 *   - this version's own sessions, still PROPOSED at this point.
 */
async function acceptInTx(tx: Tx, userId: string, planVersionId: string, now: Date, how: 'user' | 'countdown' | 'gate'): Promise<boolean> {
  const version = await tx.planVersion.findFirst({ where: { id: planVersionId, userId, status: 'PROPOSED' } });
  if (!version) return false;

  await tx.scheduledBlock.deleteMany({
    where: {
      task: { userId },
      state: 'ACCEPTED',
      isPinned: false,
      planVersionId: { not: version.id },
      endsAt: { gt: now },
      NOT: { startsAt: { lte: now }, task: { timerStartedAt: { not: null } } },
    },
  });
  await tx.planVersion.update({
    where: { id: version.id },
    data: {
      status: 'ACCEPTED',
      respondedAt: now,
      ...(how === 'countdown' ? { autoAcceptedAt: now } : {}),
      ...(how === 'gate' ? { autoApplied: true } : {}),
    },
  });
  await tx.scheduledBlock.updateMany({ where: { planVersionId: version.id, state: 'PROPOSED' }, data: { state: 'ACCEPTED' } });
  return true;
}

/** Postgres's "conflicting key value violates exclusion constraint". */
function isOverlapError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes('scheduled_blocks_no_overlap') || text.includes('23P01');
}

export class StalePlanError extends Error {
  constructor() {
    super('That plan is out of date — something changed since it was made. A fresh one is on its way.');
  }
}

/** Accept a proposal. Throws `StalePlanError` if it no longer fits the calendar. */
export async function acceptPlan(userId: string, planVersionId: string, how: 'user' | 'countdown' = 'user'): Promise<boolean> {
  const now = new Date();
  try {
    return await prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const accepted = await acceptInTx(tx, userId, planVersionId, now, how);
      if (accepted) await tx.user.update({ where: { id: userId }, data: { planEpoch: { increment: 1 } } });
      return accepted;
    });
  } catch (error) {
    // The database refused an overlap: something was placed by hand into
    // this proposal's time after it was made. Drop the proposal, never force it.
    if (isOverlapError(error)) {
      await rejectPlan(userId, planVersionId);
      throw new StalePlanError();
    }
    throw error;
  }
}

/** Reject a proposal: its sessions are discarded, the previous plan stands. */
export async function rejectPlan(userId: string, planVersionId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const version = await tx.planVersion.findFirst({ where: { id: planVersionId, userId, status: 'PROPOSED' } });
    if (!version) return;
    await tx.planVersion.update({ where: { id: version.id }, data: { status: 'REJECTED', respondedAt: new Date() } });
    await tx.scheduledBlock.deleteMany({ where: { planVersionId: version.id, state: 'PROPOSED' } });
    await tx.user.update({ where: { id: userId }, data: { planEpoch: { increment: 1 } } });
  });
}

/**
 * Undo an applied plan, or one change of it.
 *
 * Undo is a decision, so whatever is put back comes back *pinned* at its old
 * time (and acknowledged, since it may now overlap what replaced it). The
 * knock-on effects are then worked out by a fresh plan that always asks
 * (§13.C, AC-3.6).
 */
export async function undoPlan(userId: string, planVersionId: string, changeId?: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const version = await tx.planVersion.findFirst({
      where: { id: planVersionId, userId, status: 'ACCEPTED' },
      include: { changes: true },
    });
    if (!version) return;
    const selected = version.changes.filter(
      (change) => (changeId ? change.id === changeId : true) && change.kind !== 'UNCHANGED',
    );
    for (const change of selected) {
      if (change.newStartsAt) {
        await tx.scheduledBlock.deleteMany({
          where: { taskId: change.taskId, state: 'ACCEPTED', isPinned: false, startsAt: change.newStartsAt, planVersionId: version.id },
        });
      }
      if (change.previousStartsAt && change.previousEndsAt && change.previousEndsAt > new Date()) {
        await tx.scheduledBlock.create({
          data: {
            taskId: change.taskId,
            userId,
            startsAt: change.previousStartsAt,
            endsAt: change.previousEndsAt,
            state: 'ACCEPTED',
            isPinned: true,
            overlapAck: true,
            explanationText: 'You put this back here by undoing a change. Fluid will not move it again.',
          },
        });
      }
      await tx.planChange.update({ where: { id: change.id }, data: { reason: `${change.reason} (undone)` } });
    }
    if (!changeId) await tx.planVersion.update({ where: { id: version.id }, data: { status: 'REVERTED', respondedAt: new Date() } });
    await tx.user.update({ where: { id: userId }, data: { planEpoch: { increment: 1 } } });
  });
  await replan(userId, { trigger: 'undo', requested: true, userInitiated: true, forcePropose: true });
}

/**
 * Say yes to an overtime proposal: its slots become pinned sessions — the
 * one way work ever lands outside working hours, and only by a person's yes.
 */
export async function decideOvertime(userId: string, planVersionId: string, taskId: string, approve: boolean): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const version = await tx.planVersion.findFirst({ where: { id: planVersionId, userId }, select: { overtimeProposals: true } });
    const proposals = asArray<StoredOvertime>(version?.overtimeProposals);
    const proposal = proposals.find((entry) => entry.taskId === taskId && entry.status === 'pending');
    if (!proposal) return;
    if (approve) {
      for (const interval of proposal.intervals) {
        await tx.scheduledBlock.create({
          data: {
            taskId,
            userId,
            startsAt: new Date(interval.start),
            endsAt: new Date(interval.end),
            state: 'ACCEPTED',
            isPinned: true,
            explanationText: 'Outside your working hours, because you approved it to meet a hard deadline.',
          },
        });
      }
    }
    await tx.planVersion.update({
      where: { id: planVersionId },
      data: { overtimeProposals: json(proposals.map((entry) => (entry === proposal ? { ...entry, status: approve ? 'approved' : 'dismissed' } : entry))) },
    });
    await tx.user.update({ where: { id: userId }, data: { planEpoch: { increment: 1 } } });
  });
  if (approve) await replan(userId, { trigger: 'overtime_approved', userInitiated: true });
}

/** The latest plan's problems and pending overtime, for the resolve tray. */
export async function currentIssues(userId: string) {
  const latest = await prisma.planVersion.findFirst({
    where: { userId, status: { in: ['PROPOSED', 'ACCEPTED'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, issues: true, overtimeProposals: true, staleCalendarSince: true, status: true },
  });
  const missed = await prisma.scheduledBlock.findMany({
    where: { task: { userId, completedAt: null }, state: 'MISSED', endsAt: { gt: new Date(Date.now() - 3 * 86_400_000) } },
    orderBy: { startsAt: 'desc' },
    take: 10,
    select: { id: true, startsAt: true, endsAt: true, task: { select: { id: true, title: true } } },
  });
  const issues = (latest?.issues ?? { unscheduled: [], spilled: [] }) as unknown as Issues;
  const overtime = asArray<StoredOvertime>(latest?.overtimeProposals).filter((entry) => entry.status === 'pending');
  return {
    planVersionId: latest?.id ?? null,
    unscheduled: issues.unscheduled ?? [],
    spilled: issues.spilled ?? [],
    overtime,
    missed,
    staleCalendarSince: latest?.staleCalendarSince ?? null,
  };
}

/** The most recent plan Fluid applied on its own, for the "undo" banner. */
export async function recentAutoApplied(userId: string, withinMs = 60 * 60_000) {
  return prisma.planVersion.findFirst({
    where: { userId, autoApplied: true, status: 'ACCEPTED', createdAt: { gt: new Date(Date.now() - withinMs) } },
    orderBy: { createdAt: 'desc' },
    include: { changes: { where: { kind: { not: 'UNCHANGED' } } } },
  });
}

/** Kept for callers that only want "plan now, ask me". */
export async function buildPlan(userId: string, trigger: ReplanTrigger = 'manual'): Promise<ReplanOutcome> {
  return replan(userId, { trigger, requested: true, userInitiated: true });
}

