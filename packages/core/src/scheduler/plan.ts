/**
 * The deterministic scheduler.
 *
 * This is the primary engine, not a fallback. The AI proposes; this decides.
 * Two consequences follow from that ordering, and both are deliberate:
 *
 *   - The app keeps working when the AI is slow, down, disabled, or when the
 *     user has opted out of AI entirely.
 *   - An AI proposal is validated by this engine before it can be applied, so a
 *     prompt injected through a calendar invite cannot produce a schedule that
 *     violates protected time or double-books a meeting. The worst it can do is
 *     suggest something the user sees in the diff and rejects.
 *
 * Constraints, in strict priority order:
 *   1. Protected time is inviolable — including live hyperfocus.
 *   2. Never overlap existing busy time.
 *   3. Stay inside working hours (and under the daily work cap, if set).
 *   4. Respect dependencies and earliest-start dates.
 *   5. Meet deadlines — hard ones first, by displacing lower-ranked flexible
 *      work if that is what it takes.
 *   6. Match energy and preferred time of day.
 *   7. Respect chunk sizes and buffers.
 *   8. Minimize churn against the plan already in force.
 *
 * Rule 8 is last in precedence but does the most for the user. A schedule that
 * reshuffles wholesale on every replan stops functioning as external structure,
 * which for someone relying on it to counter time blindness is the entire value
 * of the product.
 *
 * Every block carries an explanation (why here, why not earlier, what was
 * relaxed), and the finished plan is checked against the hard constraints
 * before it is returned. A plan that fails that check throws rather than
 * reaching anyone's calendar.
 */
import { addMinutes, localTimeOnDay, minutesBetween, parseTimeOfDay, startOfLocalDay } from '../time/zoned';
import { buildAvailability, buildEnergyMap, energyAt, energySatisfies, expandLabeledRoutines, type EnergyMap } from './availability';
import {
  alignUp,
  contains,
  durationMinutes,
  intersectIntervals,
  mergeIntervals,
  overlaps,
  subtractIntervals,
  totalMinutes,
} from './intervals';
import type {
  BindingConstraint,
  BlockExplanation,
  BusyInterval,
  DaySummary,
  Displacement,
  Interval,
  OvertimeProposal,
  Plan,
  PlannedBlock,
  Priority,
  RankFactor,
  Relaxation,
  SchedulableTask,
  SchedulingInput,
  SpilledCommitment,
  UnscheduledReason,
  UnscheduledTask,
} from './types';

const PRIORITY_RANK: Record<Priority, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, URGENT: 3 };

/** Far enough out to sort after any real deadline, without using Infinity. */
const NO_DEADLINE_SLACK = 365 * 24 * 60;

/** How far outside working hours an overtime proposal may reach, by default. */
const DEFAULT_OVERTIME_REACH_MINUTES = 180;

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** The rank key's components, in order. The last (id) is a tie-break, not a factor. */
const RANK_FACTORS: Array<RankFactor | null> = [
  'committed_day',
  'hard_deadline_risk',
  'priority',
  'project_importance',
  'slack',
  'ai_hint',
  'age',
  null,
];

function slackOf(task: SchedulableTask, now: Date): number {
  // Slack: how much spare time exists between now and the deadline once the
  // work itself is accounted for. Less slack is more urgent — this is what
  // makes a small task due tomorrow outrank a large one due next month.
  return task.deadline ? minutesBetween(now, task.deadline) - task.remainingMinutes : NO_DEADLINE_SLACK;
}

/** A hard deadline with less than twice the work's length to spare. */
export function isHardDeadlineAtRisk(task: SchedulableTask, now: Date): boolean {
  return task.deadlineKind === 'HARD' && task.deadline !== undefined && slackOf(task, now) < 2 * task.remainingMinutes;
}

/**
 * The lexicographic rank key (§13.B.2). Lexicographic rather than weighted, so
 * every comparison can be explained in one sentence.
 *
 *   1. Committed day — the user's decision about what they are doing outranks
 *      the scheduler's opinion. Uncommitted work sorts last.
 *   2. A hard deadline at risk — the safety valve that stops a LOW-priority
 *      hard cut-off being starved by a pile of HIGH-priority work.
 *   3. Priority — a human statement.
 *   4. Project importance.
 *   5. Slack — arithmetic.
 *   6. A validated AI ordering hint, within everything above.
 *   7. Age — older first, so new work cannot starve old.
 *   8. Id — identical inputs must always produce an identical plan.
 */
export function rankKey(task: SchedulableTask, now: Date): Array<number | string> {
  return [
    task.committedTo ? task.committedTo.start.getTime() : Number.MAX_SAFE_INTEGER,
    isHardDeadlineAtRisk(task, now) ? 0 : 1,
    -PRIORITY_RANK[task.priority],
    -(task.projectImportance ?? 1),
    slackOf(task, now),
    task.aiHintRank ?? Number.MAX_SAFE_INTEGER,
    task.createdAt ? task.createdAt.getTime() : Number.MAX_SAFE_INTEGER,
    task.id,
  ];
}

function compareKeys(a: Array<number | string>, b: Array<number | string>): number {
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left === right) continue;
    if (typeof left === 'string' || typeof right === 'string') return String(left).localeCompare(String(right));
    return left - right;
  }
  return 0;
}

/** Negative when `a` ranks ahead of `b`. */
export function compareTasks(a: SchedulableTask, b: SchedulableTask, now: Date): number {
  return compareKeys(rankKey(a, now), rankKey(b, now));
}

/** What put `task` ahead of the task ranked straight after it, plus the facts that ranked it at all. */
function rankFactorsFor(task: SchedulableTask, next: SchedulableTask | undefined, now: Date): RankFactor[] {
  const factors: RankFactor[] = [];
  if (next) {
    const a = rankKey(task, now);
    const b = rankKey(next, now);
    const index = a.findIndex((value, position) => value !== b[position]);
    const deciding = index >= 0 ? RANK_FACTORS[index] : null;
    if (deciding) factors.push(deciding);
  }
  const add = (factor: RankFactor) => {
    if (!factors.includes(factor)) factors.push(factor);
  };
  if (task.committedTo) add('committed_day');
  if (isHardDeadlineAtRisk(task, now)) add('hard_deadline_risk');
  if (task.priority === 'URGENT' || task.priority === 'HIGH') add('priority');
  if (task.deadline) add('slack');
  return factors;
}

// ---------------------------------------------------------------------------
// Dependency ordering
// ---------------------------------------------------------------------------

interface OrderedTasks {
  ordered: SchedulableTask[];
  /** Tasks in a dependency cycle. Reported, never silently dropped. */
  cyclic: SchedulableTask[];
}

/**
 * Topological sort, with ties broken by the rank key.
 *
 * Kahn's algorithm: repeatedly take tasks whose prerequisites are all placed.
 * Anything still left when nothing is ready is in a cycle.
 */
function orderTasks(tasks: SchedulableTask[], now: Date): OrderedTasks {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const keys = new Map(tasks.map((task) => [task.id, rankKey(task, now)]));
  const remaining = new Set(tasks.map((task) => task.id));
  const ordered: SchedulableTask[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((id) => byId.get(id)!)
      .filter((task) => (task.dependsOn ?? []).every((depId) => !remaining.has(depId) || !byId.has(depId)));

    if (ready.length === 0) break; // Everything left depends on something left.

    ready.sort((a, b) => compareKeys(keys.get(a.id)!, keys.get(b.id)!));
    for (const task of ready) {
      ordered.push(task);
      remaining.delete(task.id);
    }
  }

  return { ordered, cyclic: [...remaining].map((id) => byId.get(id)!) };
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Split a task's remaining work into sittings.
 *
 * Chunks are made as even as possible rather than greedily filling to the
 * maximum. Greedy filling leaves a stub at the end — a 15-minute fragment of a
 * task is the kind of block that gets skipped, and a skipped block feeds the
 * avoidance spiral this product exists to interrupt.
 */
export function chunkTask(task: SchedulableTask): number[] {
  const total = task.remainingMinutes;
  if (total <= 0) return [];

  if (!task.isSplittable || total <= task.maxChunkMinutes) return [total];

  const chunkCount = Math.ceil(total / task.maxChunkMinutes);
  const base = Math.floor(total / chunkCount);
  const remainder = total % chunkCount;

  const chunks = Array.from({ length: chunkCount }, (_, index) => (index < remainder ? base + 1 : base));

  // If evening things out pushed chunks below the useful minimum, fall back to
  // fewer, larger sittings. Better one 40-minute block than two 20s that never
  // get started.
  if (chunks.some((size) => size < task.minChunkMinutes)) {
    const viableCount = Math.max(1, Math.floor(total / task.minChunkMinutes));
    const cappedCount = Math.min(viableCount, chunkCount);
    const evenBase = Math.floor(total / cappedCount);
    const evenRemainder = total % cappedCount;
    return Array.from({ length: cappedCount }, (_, index) => (index < evenRemainder ? evenBase + 1 : evenBase));
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Placement context
// ---------------------------------------------------------------------------

interface Occupant {
  interval: Interval;
  taskId: string;
  countsAsWork: boolean;
}

interface PlacementContext {
  /** Free time before anything was placed. */
  baseFree: Interval[];
  /** Free time now: `baseFree` minus every occupant and its trailing buffer. */
  free: Interval[];
  occupied: Occupant[];
  energy: EnergyMap;
  bufferMinutes: number;
  granularity: number;
  dayAnchor: Date;
  timeZone: string;
  dailyCap: number | null;
  workPerDay: Map<number, number>;
  dayCache: Map<number, Date>;
}

interface Snapshot {
  free: Interval[];
  occupied: Occupant[];
  workPerDay: Map<number, number>;
}

/**
 * The local day an instant falls on, cached. Every zone offset in use is a
 * multiple of 15 minutes, so all instants in one 15-minute bucket share a day.
 */
function dayOf(context: PlacementContext, instant: Date): Date {
  const bucket = Math.floor(instant.getTime() / 900_000);
  let day = context.dayCache.get(bucket);
  if (!day) {
    day = startOfLocalDay(instant, context.timeZone);
    context.dayCache.set(bucket, day);
  }
  return day;
}

/**
 * A session plus the breathing room around it. The buffer is reserved on both
 * sides so two sessions are always a buffer apart, whichever was placed first:
 * placing work *before* an existing session must leave the same gap as placing
 * it after. (Meetings and the edges of the working day are not occupants, so a
 * session may still end exactly when a meeting starts.)
 */
function withBuffer(context: PlacementContext, interval: Interval): Interval {
  return {
    start: addMinutes(interval.start, -context.bufferMinutes),
    end: addMinutes(interval.end, context.bufferMinutes),
  };
}

/** Occupy an interval, plus its buffer. */
function consume(context: PlacementContext, interval: Interval, taskId: string, countsAsWork: boolean): void {
  context.free = subtractIntervals(context.free, [withBuffer(context, interval)]);
  context.occupied.push({ interval, taskId, countsAsWork });
  if (countsAsWork) {
    const day = dayOf(context, interval.start).getTime();
    context.workPerDay.set(day, (context.workPerDay.get(day) ?? 0) + durationMinutes(interval));
  }
}

/**
 * Give an occupied interval back. Free time is rebuilt from the base rather
 * than patched, because the released buffer may overlap something that was
 * never free (a meeting right after it) and must not become free by accident.
 */
function release(context: PlacementContext, interval: Interval, taskId: string): void {
  const index = context.occupied.findIndex(
    (entry) =>
      entry.taskId === taskId &&
      entry.interval.start.getTime() === interval.start.getTime() &&
      entry.interval.end.getTime() === interval.end.getTime(),
  );
  if (index < 0) return;
  const [removed] = context.occupied.splice(index, 1);
  if (removed!.countsAsWork) {
    const day = dayOf(context, interval.start).getTime();
    context.workPerDay.set(day, (context.workPerDay.get(day) ?? 0) - durationMinutes(interval));
  }
  context.free = subtractIntervals(
    context.baseFree,
    context.occupied.map((entry) => withBuffer(context, entry.interval)),
  );
}

function snapshot(context: PlacementContext): Snapshot {
  return { free: context.free, occupied: [...context.occupied], workPerDay: new Map(context.workPerDay) };
}

function restore(context: PlacementContext, saved: Snapshot): void {
  context.free = saved.free;
  context.occupied = [...saved.occupied];
  context.workPerDay = new Map(saved.workPerDay);
}

/** Is this exact interval still entirely unoccupied? */
function isStillFree(free: Interval[], candidate: Interval): boolean {
  return free.some((slot) => contains(slot, candidate));
}

function fitsUnderCap(context: PlacementContext, interval: Interval, countsAsWork: boolean): boolean {
  if (!countsAsWork || context.dailyCap === null) return true;
  const day = dayOf(context, interval.start).getTime();
  return (context.workPerDay.get(day) ?? 0) + durationMinutes(interval) <= context.dailyCap;
}

interface Slot {
  interval: Interval;
  relaxed: Relaxation[];
  /** An earlier slot was passed over only to honour energy or time-of-day. */
  skippedForPreference: boolean;
  /** An earlier slot was passed over because that day already held the daily cap. */
  skippedForCap: boolean;
}

/**
 * Find the earliest slot that fits `minutes` of work.
 *
 * Preferences are relaxed in order: first insisting on both energy and the
 * preferred time of day, then dropping the time of day, then energy. Placing
 * demanding work into a slot the user has told us is low-focus wastes the slot
 * and teaches them the schedule is not worth following — but leaving the task
 * entirely unscheduled is worse.
 */
function findSlot(
  context: PlacementContext,
  task: SchedulableTask,
  minutes: number,
  notBefore: Date,
  options: { notAfter?: Date; within?: Interval; minGap?: number } = {},
): Slot | null {
  // A commitment window narrows both ends. Intersecting here rather than
  // filtering afterwards means the relaxation passes below still get to do
  // their job inside the chosen day.
  let floor = notBefore;
  let ceiling = options.notAfter;
  if (options.within) {
    if (options.within.start > floor) floor = options.within.start;
    if (!ceiling || options.within.end < ceiling) ceiling = options.within.end;
  }
  if (ceiling && floor >= ceiling) return null;

  const window = task.preferredWindow;
  const levels: Array<{ energy: boolean; window: boolean }> = window
    ? [
        { energy: true, window: true },
        { energy: true, window: false },
        { energy: false, window: false },
      ]
    : [
        { energy: true, window: false },
        { energy: false, window: false },
      ];
  const countsAsWork = task.countsAsWork !== false;
  let preferenceSkip = false;
  let capSkip = false;

  for (const [levelIndex, level] of levels.entries()) {
    for (const slot of context.free) {
      if (slot.end <= floor) continue;
      if (ceiling && slot.start >= ceiling) break;

      let earliest = slot.start < floor ? floor : slot.start;
      let windowEnd: Date | null = null;
      if (window && level.window) {
        const day = dayOf(context, earliest);
        const windowStart = localTimeOnDay(day, window.startMinute, context.timeZone);
        windowEnd = localTimeOnDay(day, window.endMinute, context.timeZone);
        if (earliest < windowStart) earliest = windowStart;
      }

      const start = alignUp(earliest, context.granularity, context.dayAnchor);
      const end = addMinutes(start, minutes);
      if (end > slot.end) continue;
      if (ceiling && end > ceiling) continue;
      if (options.minGap && minutesBetween(start, ceiling && ceiling < slot.end ? ceiling : slot.end) < options.minGap) continue;

      if (windowEnd && end > windowEnd) {
        if (levelIndex === 0) preferenceSkip = true;
        continue;
      }
      const energyMatched = energySatisfies(energyAt(context.energy, start), task.energy);
      if (level.energy && !energyMatched) {
        if (levelIndex === 0) preferenceSkip = true;
        continue;
      }
      const interval = { start, end };
      if (!fitsUnderCap(context, interval, countsAsWork)) {
        capSkip = true;
        continue;
      }

      const relaxed: Relaxation[] = [];
      if (window && !level.window) relaxed.push('preferred_window');
      if (!energyMatched) relaxed.push('energy');
      return {
        interval,
        relaxed,
        skippedForPreference: levelIndex === 0 && preferenceSkip,
        skippedForCap: capSkip,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Explanations: why not earlier?
// ---------------------------------------------------------------------------

interface Marker {
  end: Date;
  constraint: BindingConstraint;
  /** Busy and protected time explain better than "other work", on a tie. */
  weight: number;
}

/**
 * The thing that stops a block starting earlier, found by looking at what
 * ends closest before it: a meeting, protected time, other work, or the start
 * of the working day — or, failing those, the floor the task could not start
 * before (now, a dependency, its earliest start, its committed day).
 */
function whyNotEarlier(
  context: PlacementContext,
  markers: Marker[],
  workable: Interval[],
  start: Date,
  floor: Date,
  floorReason: BindingConstraint,
  slot: Slot,
  taskId: string,
): BindingConstraint[] {
  const granularityMs = context.granularity * 60_000;
  // Within a buffer and a grid step of the floor, the floor is the reason:
  // a session after a prerequisite starts one buffer later, not "for no reason".
  if (start.getTime() - floor.getTime() < granularityMs + context.bufferMinutes * 60_000) return [floorReason];
  if (slot.skippedForCap) return [{ kind: 'daily_cap' }];
  if (slot.skippedForPreference) return [{ kind: 'preference' }];

  let best: Marker | null = null;
  const consider = (marker: Marker) => {
    if (marker.end > start || marker.end <= floor) return;
    if (!best || marker.end > best.end || (marker.end.getTime() === best.end.getTime() && marker.weight > best.weight)) {
      best = marker;
    }
  };
  for (const marker of markers) consider(marker);
  for (const occupant of context.occupied) {
    if (occupant.taskId === taskId) continue;
    consider({
      end: occupant.interval.end,
      constraint: { kind: 'earlier_work', taskId: occupant.taskId, endsAt: occupant.interval.end },
      weight: 0,
    });
  }

  const day = workable.find((interval) => interval.start <= start && start < interval.end);
  const nearestEnd = (best as Marker | null)?.end ?? floor;
  if (day && day.start >= nearestEnd && start.getTime() - day.start.getTime() < granularityMs) {
    return [{ kind: 'working_hours' }];
  }

  const slackMs = (context.bufferMinutes + context.granularity) * 60_000;
  if (best && start.getTime() - (best as Marker).end.getTime() <= slackMs) return [(best as Marker).constraint];
  return [{ kind: 'gap_too_short' }];
}

// ---------------------------------------------------------------------------
// Overtime
// ---------------------------------------------------------------------------

/** Quiet hours as instants across a span, handling a window that wraps midnight. */
function expandQuietHours(
  quiet: { start: string; end: string } | null | undefined,
  span: Interval,
  timeZone: string,
): Interval[] {
  if (!quiet) return [];
  const startMinute = parseTimeOfDay(quiet.start);
  const endMinute = parseTimeOfDay(quiet.end);
  const intervals: Interval[] = [];
  for (let offset = -1; ; offset += 1) {
    const day = startOfLocalDay(span.start, timeZone, offset);
    if (day >= span.end) break;
    const start = localTimeOnDay(day, startMinute, timeZone);
    const end = localTimeOnDay(day, endMinute, timeZone, endMinute <= startMinute ? 1 : 0);
    intervals.push({ start, end });
    if (offset > 120) break; // A horizon is at most 90 days.
  }
  return intervals;
}

/**
 * Out-of-hours time that would let a hard deadline be met (§13.B.12).
 *
 * Candidates sit in [floor, deadline), outside working hours but within reach
 * of them, never in protected time, busy time or quiet hours, and nearest to
 * the working day first: half an hour after work reads very differently from
 * half an hour before dawn. A proposal is a proposal; nothing here is placed.
 */
function proposeOvertime(
  context: PlacementContext,
  input: SchedulingInput,
  task: SchedulableTask,
  shortfall: number,
  floor: Date,
  deadline: Date,
  workable: Interval[],
  blocked: Interval[],
): OvertimeProposal | null {
  if (floor >= deadline) return null;
  const reach = input.overtimeReachMinutes ?? DEFAULT_OVERTIME_REACH_MINUTES;
  const window: Interval = { start: floor, end: deadline };

  const candidates: Array<Interval & { side: 'after' | 'before'; edge: Date }> = [];
  for (const day of workable) {
    candidates.push({ start: day.end, end: addMinutes(day.end, reach), side: 'after', edge: day.end });
    candidates.push({ start: addMinutes(day.start, -reach), end: day.start, side: 'before', edge: day.start });
  }

  const buffer = context.bufferMinutes;
  const cut = mergeIntervals([
    ...workable,
    ...blocked,
    ...expandQuietHours(input.quietHours, { start: addMinutes(floor, -1440), end: deadline }, input.timeZone),
    // Keep a buffer on both sides of existing work, so overtime never butts up
    // against a session.
    ...context.occupied.map((entry) => ({
      start: addMinutes(entry.interval.start, -buffer),
      end: addMinutes(entry.interval.end, buffer),
    })),
  ]);

  let segments = candidates
    .flatMap((candidate) =>
      subtractIntervals(intersectIntervals([candidate], [window]), cut).map((segment) => ({
        ...segment,
        side: candidate.side,
        distance:
          candidate.side === 'after'
            ? minutesBetween(candidate.edge, segment.start)
            : minutesBetween(segment.end, candidate.edge),
      })),
    )
    .filter((segment) => segment.end > segment.start);

  const chosen: Interval[] = [];
  let need = shortfall;
  while (need > 0) {
    const size = task.isSplittable ? Math.min(task.maxChunkMinutes, Math.max(task.minChunkMinutes, need)) : need;
    segments.sort((a, b) => a.distance - b.distance || a.start.getTime() - b.start.getTime());
    let picked: Interval | null = null;
    for (const segment of segments) {
      // Hugging the working day, not the grid: overtime should be as close to
      // normal hours as it can get, so it starts the moment the buffer ends.
      const start = segment.side === 'after' ? segment.start : addMinutes(segment.end, -size);
      const end = addMinutes(start, size);
      if (start >= segment.start && end <= segment.end) {
        picked = { start, end };
        break;
      }
    }
    if (!picked) break;
    chosen.push(picked);
    need -= size;
    const taken = { start: addMinutes(picked.start, -buffer), end: addMinutes(picked.end, buffer) };
    segments = segments.flatMap((segment) =>
      subtractIntervals([segment], [taken]).map((rest) => ({ ...rest, side: segment.side, distance: segment.distance })),
    );
    if (!task.isSplittable) break;
  }

  if (chosen.length === 0) return null;
  chosen.sort((a, b) => a.start.getTime() - b.start.getTime());
  const minutes = totalMinutes(chosen);
  return {
    taskId: task.id,
    intervals: chosen,
    minutes,
    shortfallMinutes: shortfall,
    explanation:
      `"${task.title}" needs ${shortfall} more minutes than your working hours hold before its hard deadline. ` +
      `${minutes} minutes outside your hours would cover ${minutes >= shortfall ? 'it' : 'part of it'} — ` +
      `only if you say yes.`,
  };
}

// ---------------------------------------------------------------------------
// Post-condition checks
// ---------------------------------------------------------------------------

/** A plan broke a hard constraint. It must never reach anyone's calendar. */
export class PlanInvariantError extends Error {
  constructor(readonly violations: string[]) {
    super(`Scheduler produced an invalid plan: ${violations.slice(0, 5).join('; ')}`);
    this.name = 'PlanInvariantError';
  }
}

/**
 * The hard constraints, checked on the output rather than trusted from the
 * algorithm (§13.D). Returns every violation; empty means the plan is sound.
 */
export function checkPlanInvariants(input: SchedulingInput, result: Pick<Plan, 'blocks'>): string[] {
  const violations: string[] = [];
  const availability = buildAvailability({
    now: input.now,
    timeZone: input.timeZone,
    horizonDays: input.horizonDays,
    workingHours: input.workingHours,
    protectedTimes: [],
    busy: [],
  });
  const protectedIntervals = expandLabeledRoutines(input.protectedTimes, availability.bounds, input.timeZone);
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  const engineBlocks = result.blocks.filter((block) => !block.isPinned);
  const at = (block: PlannedBlock) => `${block.taskId}@${block.start.toISOString()}`;

  for (const block of result.blocks) {
    if (block.end <= block.start) violations.push(`${at(block)} has no length`);
  }

  for (const block of engineBlocks) {
    if (block.start < input.now) violations.push(`${at(block)} starts before now`);
    if (!availability.workable.some((interval) => contains(interval, block))) {
      violations.push(`${at(block)} is outside working hours`);
    }
    for (const busy of input.busy) {
      if (overlaps(busy, block)) violations.push(`${at(block)} overlaps busy time`);
    }
    for (const span of protectedIntervals) {
      if (overlaps(span, block)) violations.push(`${at(block)} overlaps protected time "${span.label}"`);
    }
    for (const pinned of input.pinned) {
      if (overlaps(pinned, block)) violations.push(`${at(block)} overlaps a pinned session`);
    }
    const task = tasks.get(block.taskId);
    if (task?.earliestStart && block.start < task.earliestStart) {
      violations.push(`${at(block)} starts before its earliest start`);
    }
  }

  const sorted = [...result.blocks].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.start < sorted[index - 1]!.end && !(sorted[index]!.isPinned && sorted[index - 1]!.isPinned)) {
      violations.push(`${at(sorted[index]!)} overlaps ${at(sorted[index - 1]!)}`);
    }
  }

  const byTask = new Map<string, PlannedBlock[]>();
  for (const block of result.blocks) byTask.set(block.taskId, [...(byTask.get(block.taskId) ?? []), block]);
  for (const task of input.tasks) {
    const mine = byTask.get(task.id);
    if (!mine) continue;
    const firstStart = Math.min(...mine.map((block) => block.start.getTime()));
    for (const depId of task.dependsOn ?? []) {
      const theirs = byTask.get(depId);
      if (!theirs || !tasks.has(depId)) continue;
      const lastEnd = Math.max(...theirs.map((block) => block.end.getTime()));
      if (firstStart < lastEnd) violations.push(`${task.id} starts before its prerequisite ${depId} ends`);
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

interface PlacedChunk {
  interval: Interval;
  explanation: BlockExplanation;
  /** Placed outside its committed day. */
  leftDay?: boolean;
}

export function plan(input: SchedulingInput): Plan {
  const { now, timeZone, preferences } = input;
  const byId = new Map(input.tasks.map((task) => [task.id, task]));
  const countsAsWork = (taskId: string) => byId.get(taskId)?.countsAsWork !== false;

  const availability = buildAvailability({
    now,
    timeZone,
    horizonDays: input.horizonDays,
    workingHours: input.workingHours,
    protectedTimes: input.protectedTimes,
    // Pinned blocks occupy time exactly like an external meeting does.
    busy: [...input.busy, ...input.pinned.map((p) => ({ start: p.start, end: p.end }))],
  });
  const protectedLabeled = expandLabeledRoutines(input.protectedTimes, availability.bounds, timeZone);
  const energy = buildEnergyMap(input.energyWindows, availability.bounds, timeZone);

  const context: PlacementContext = {
    baseFree: availability.free,
    free: availability.free,
    occupied: [],
    energy,
    bufferMinutes: Math.max(0, preferences.bufferMinutes),
    granularity: Math.max(1, preferences.slotGranularityMinutes),
    dayAnchor: startOfLocalDay(now, timeZone),
    timeZone,
    dailyCap: preferences.maxDailyWorkMinutes && preferences.maxDailyWorkMinutes > 0 ? preferences.maxDailyWorkMinutes : null,
    workPerDay: new Map(),
    dayCache: new Map(),
  };

  // Things that can explain "why not earlier", by when they end.
  const markers: Marker[] = [
    ...input.busy.map((busy: BusyInterval) => ({
      end: busy.end,
      constraint: { kind: 'busy' as const, endsAt: busy.end, ...(busy.id ? { eventId: busy.id } : {}), ...(busy.title ? { title: busy.title } : {}) },
      weight: 1,
    })),
    ...input.pinned.map((pinned) => ({
      end: pinned.end,
      constraint: { kind: 'earlier_work' as const, taskId: pinned.taskId, endsAt: pinned.end },
      weight: 1,
    })),
    ...protectedLabeled.map((span) => ({
      end: span.end,
      constraint: { kind: 'protected' as const, label: span.label, endsAt: span.end },
      weight: 1,
    })),
  ];
  // For overtime: everything that is never available, in or out of hours.
  const blockedForOvertime = mergeIntervals([
    ...input.busy.map((busy) => ({ start: busy.start, end: busy.end })),
    ...input.pinned.map((pinned) => ({ start: pinned.start, end: pinned.end })),
    ...protectedLabeled.map((span) => ({ start: span.start, end: span.end })),
  ]);

  const blocks: PlannedBlock[] = [];
  const unscheduled: UnscheduledTask[] = [];
  const spilled: SpilledCommitment[] = [];
  const overtimeProposals: OvertimeProposal[] = [];
  const displaced: Displacement[] = [];

  // Pinned blocks are decisions the user already made. They enter the plan
  // untouched and their time is already excluded from `free`. Pinned work
  // still counts against the daily cap.
  for (const pinnedBlock of input.pinned) {
    blocks.push({
      taskId: pinnedBlock.taskId,
      start: pinnedBlock.start,
      end: pinnedBlock.end,
      isPinned: true,
      chunkIndex: 1,
      chunkCount: 1,
      explanation: { rankFactors: [], bindingConstraints: [{ kind: 'pinned' }], relaxed: [] },
    });
    if (countsAsWork(pinnedBlock.taskId)) {
      const day = dayOf(context, pinnedBlock.start).getTime();
      context.workPerDay.set(day, (context.workPerDay.get(day) ?? 0) + durationMinutes(pinnedBlock));
    }
  }

  // ---------------------------------------------------------------------
  // Stability pass.
  //
  // Before placing anything new, keep whatever the current plan already has in
  // place — provided the slot is still free and still legal. Only the time that
  // genuinely has to move gets re-planned. A kept block may later be released,
  // but only for higher-ranked work with a real claim on that time: an urgent
  // task, or a hard deadline that cannot otherwise be met.
  // ---------------------------------------------------------------------
  const retained = new Map<string, Interval[]>();

  if (input.previous?.length) {
    const previousByStart = [...input.previous].sort((a, b) => a.start.getTime() - b.start.getTime());

    for (const previousBlock of previousByStart) {
      const task = byId.get(previousBlock.taskId);
      if (!task) continue; // Task completed or deleted since the last plan.
      if (previousBlock.end <= now) continue; // Already in the past.
      if (task.earliestStart && previousBlock.start < task.earliestStart) continue;

      const candidate: Interval = { start: previousBlock.start, end: previousBlock.end };

      // Stability yields to an explicit day commitment. Without this, dragging
      // a task onto another day would be silently undone by the next replan.
      // A block the engine itself spilled off the *same* commitment stays put,
      // though — re-spilling it every time would only churn.
      if (
        task.committedTo &&
        !contains(task.committedTo, candidate) &&
        previousBlock.committedDay?.getTime() !== task.committedTo.start.getTime()
      ) {
        continue;
      }
      if (!isStillFree(context.free, candidate)) continue; // Something else took it.

      // Do not retain more time than the task still needs — it may have shrunk.
      const alreadyRetained = totalMinutes(retained.get(task.id) ?? []);
      if (alreadyRetained + durationMinutes(candidate) > task.remainingMinutes) continue;
      if (!fitsUnderCap(context, candidate, task.countsAsWork !== false)) continue;

      consume(context, candidate, task.id, task.countsAsWork !== false);
      retained.set(task.id, [...(retained.get(task.id) ?? []), candidate]);
    }
  }

  const { ordered, cyclic } = orderTasks(input.tasks, now);

  for (const task of cyclic) {
    unscheduled.push({
      taskId: task.id,
      reason: 'DEPENDENCY_CYCLE',
      explanation:
        `"${task.title}" is part of a loop of tasks that each wait on the other, ` +
        `so none of them can start. Removing one link will free the rest.`,
      shortfallMinutes: task.remainingMinutes,
    });
  }

  /** When each task finishes, so dependents can be placed after it. */
  const finishedAt = new Map<string, Date>();
  for (const pinnedBlock of input.pinned) {
    const existing = finishedAt.get(pinnedBlock.taskId);
    if (!existing || pinnedBlock.end > existing) finishedAt.set(pinnedBlock.taskId, pinnedBlock.end);
  }

  const processed = new Set<string>();

  for (const [orderIndex, task] of ordered.entries()) {
    processed.add(task.id);
    const isWork = task.countsAsWork !== false;
    const rankFactors = rankFactorsFor(task, ordered[orderIndex + 1], now);
    const retainedIntervals = retained.get(task.id) ?? [];
    const retainedMinutes = totalMinutes(retainedIntervals);
    const outstandingMinutes = task.remainingMinutes - retainedMinutes;

    // Chunk only the work the stability pass did not already cover.
    const chunks = outstandingMinutes > 0 ? chunkTask({ ...task, remainingMinutes: outstandingMinutes }) : [];
    if (chunks.length === 0 && retainedIntervals.length === 0) continue;

    // Earliest this task may begin: now, its own earliest-start, and after
    // everything it depends on has finished.
    let notBefore = now;
    let floorReason: BindingConstraint = { kind: 'now' };
    if (task.earliestStart && task.earliestStart > notBefore) {
      notBefore = task.earliestStart;
      floorReason = { kind: 'earliest_start', at: task.earliestStart };
    }

    let blockedByUnplaced: string | null = null;
    for (const depId of task.dependsOn ?? []) {
      const depFinish = finishedAt.get(depId);
      if (!depFinish) {
        // The prerequisite itself could not be scheduled.
        if (byId.has(depId)) blockedByUnplaced = depId;
        continue;
      }
      if (depFinish > notBefore) {
        notBefore = depFinish;
        floorReason = { kind: 'dependency', taskId: depId, endsAt: depFinish };
      }
    }

    if (blockedByUnplaced) {
      const blocker = byId.get(blockedByUnplaced);
      unscheduled.push({
        taskId: task.id,
        reason: 'BLOCKED_BY_DEPENDENCY',
        explanation:
          `"${task.title}" is waiting on "${blocker?.title ?? blockedByUnplaced}", ` +
          `which could not be fitted in yet.`,
        shortfallMinutes: task.remainingMinutes,
      });
      continue;
    }

    if (notBefore >= availability.bounds.end) {
      unscheduled.push({
        taskId: task.id,
        reason: 'STARTS_AFTER_HORIZON',
        explanation:
          `"${task.title}" cannot start until after the end of the planning window, ` +
          `so there is nothing to schedule yet.`,
        shortfallMinutes: task.remainingMinutes,
      });
      continue;
    }

    const deadline = task.deadline;
    const hard = task.deadlineKind === 'HARD' && deadline !== undefined;
    const startCursor = (() => {
      const lastRetainedEnd = retainedIntervals.at(-1)?.end;
      return lastRetainedEnd && lastRetainedEnd > notBefore ? lastRetainedEnd : notBefore;
    })();

    /** Place one chunk: its committed day first, then anywhere before `notAfter`. */
    const placeChunk = (minutes: number, cursor: Date, notAfter: Date | undefined): PlacedChunk | null => {
      // A fragment of a bigger task smaller than a real session (a leftover
      // 15 minutes) only goes where a real session would fit. Otherwise it
      // would fill a gap the first plan rightly left alone, and every replan
      // would find something new to do.
      const minGap = minutes < task.minChunkMinutes && minutes < task.remainingMinutes ? task.minChunkMinutes : undefined;
      let slot: Slot | null = null;
      let usedDay = false;
      if (task.committedTo) {
        slot = findSlot(context, task, minutes, cursor, { notAfter, within: task.committedTo, ...(minGap ? { minGap } : {}) });
        usedDay = slot !== null;
      }
      const leftDay = task.committedTo !== undefined && slot === null;
      if (!slot) slot = findSlot(context, task, minutes, cursor, { notAfter, ...(minGap ? { minGap } : {}) });
      if (!slot) return null;

      let floor = cursor;
      let reason: BindingConstraint = cursor.getTime() === notBefore.getTime() ? floorReason : { kind: 'previous_session' };
      if (usedDay && task.committedTo!.start > floor) {
        floor = task.committedTo!.start;
        reason = { kind: 'committed_day' };
      }
      const relaxed = [...slot.relaxed];
      if (leftDay) relaxed.push('committed_day');
      const explanation: BlockExplanation = {
        rankFactors,
        bindingConstraints: whyNotEarlier(context, markers, availability.workable, slot.interval.start, floor, reason, slot, task.id),
        relaxed,
      };
      consume(context, slot.interval, task.id, isWork);
      return { interval: slot.interval, explanation, leftDay };
    };

    /** Even chunks, in order, before `notAfter`. Stops at the first that will not fit. */
    const placeEven = (minutes: number, cursor: Date, notAfter: Date | undefined) => {
      const placed: PlacedChunk[] = [];
      let unplaced = 0;
      let next = cursor;
      for (const chunk of chunkTask({ ...task, remainingMinutes: minutes })) {
        if (unplaced > 0) {
          unplaced += chunk;
          continue;
        }
        const result = placeChunk(chunk, next, notAfter);
        if (!result) {
          unplaced += chunk;
          continue;
        }
        placed.push(result);
        next = result.interval.end;
      }
      return { placed, unplaced };
    };

    /**
     * Adaptive chunking for a hard deadline (§13.B.6 step 0): fill the free
     * time before the deadline greedily, any slot of at least `minChunk`,
     * each capped at `maxChunk`. Evenness matters less than fitting.
     */
    const placeAdaptive = (minutes: number, until: Date) => {
      const placed: PlacedChunk[] = [];
      let need = minutes;
      // Every pass scans from the floor, not from the last session: a gap
      // passed over early (the day was at its cap for a big session) may
      // still take the small remainder at the end. A forward-only scan would
      // miss it now and find it on the next replan — churn for nothing.
      const cursor = notBefore;
      while (need > 0) {
        let picked: Interval | null = null;
        for (const slot of context.free) {
          if (slot.end <= cursor) continue;
          if (slot.start >= until) break;
          const start = alignUp(slot.start < cursor ? cursor : slot.start, context.granularity, context.dayAnchor);
          const limit = slot.end < until ? slot.end : until;
          const room = Math.floor(minutesBetween(start, limit));
          // Only gaps a real session fits in. A smaller final remainder may go
          // into one, but a gap below the minimum is never used on its own.
          if (room < task.minChunkMinutes) continue;
          // Under a daily work cap, size the session to what the day has left
          // rather than skip the gap: skipping would leave the deadline short
          // while a later replan (with less room) happily used it.
          const capLeft =
            isWork && context.dailyCap !== null
              ? context.dailyCap - (context.workPerDay.get(dayOf(context, start).getTime()) ?? 0)
              : Number.POSITIVE_INFINITY;
          const size = Math.min(task.maxChunkMinutes, room, need, capLeft);
          if (size < Math.min(task.minChunkMinutes, need) || size <= 0) continue;
          picked = { start, end: addMinutes(start, size) };
          break;
        }
        if (!picked) break;
        const explanation: BlockExplanation = {
          rankFactors,
          bindingConstraints: whyNotEarlier(context, markers, availability.workable, picked.start, cursor, cursor.getTime() === notBefore.getTime() ? floorReason : { kind: 'previous_session' }, { interval: picked, relaxed: [], skippedForPreference: false, skippedForCap: false }, task.id),
          relaxed: [],
          adaptive: true,
        };
        consume(context, picked, task.id, isWork);
        const leftDay = task.committedTo !== undefined && !contains(task.committedTo, picked);
        placed.push({ interval: picked, explanation, leftDay });
        need -= durationMinutes(picked);
      }
      return { placed, unplaced: need };
    };

    // --- A: the normal path, before the deadline ---------------------------
    let { placed: onTime, unplaced } = placeEven(outstandingMinutes, startCursor, deadline);
    let adaptive = false;
    const madeRoomBy: string[] = [];

    // --- B: rescue a deadline ----------------------------------------------
    // Only an urgent task or a hard deadline may claim time from other work.
    if (unplaced > 0 && deadline && deadline > notBefore && (hard || task.priority === 'URGENT')) {
      // B.6 step 0: for a hard deadline, try uneven chunks into every usable gap.
      if (hard && task.isSplittable) {
        const before = snapshot(context);
        const evenMinutes = outstandingMinutes - unplaced;
        for (const chunk of onTime) release(context, chunk.interval, task.id);
        const attempt = placeAdaptive(outstandingMinutes, deadline);
        if (outstandingMinutes - attempt.unplaced > evenMinutes) {
          onTime = attempt.placed;
          unplaced = attempt.unplaced;
          adaptive = true;
        } else {
          restore(context, before);
        }
      }

      // B.8 / B.6 step 1: release kept sessions of lower-ranked tasks, the
      // fewest needed — uncommitted work first, then the lowest-ranked, latest
      // first — and re-place them later in the normal way.
      if (unplaced > 0) {
        const need = unplaced;
        const tryPlace = (): PlacedChunk[] | null => {
          const attempt = hard && task.isSplittable ? placeAdaptive(need, deadline) : placeEven(need, startCursor, deadline);
          return attempt.unplaced === 0 ? attempt.placed : null;
        };
        const reach: Interval = { start: notBefore, end: deadline };
        const candidates = [...retained.entries()]
          .filter(([otherId]) => !processed.has(otherId))
          .flatMap(([otherId, intervals]) => {
            const other = byId.get(otherId)!;
            if (compareTasks(task, other, now) >= 0) return [];
            return intervals
              .filter((interval) => overlaps(interval, reach))
              .map((interval) => ({
                taskId: otherId,
                interval,
                committed: other.committedTo ? contains(other.committedTo, interval) : false,
                key: rankKey(other, now),
              }));
          })
          .sort(
            (a, b) =>
              Number(a.committed) - Number(b.committed) ||
              compareKeys(b.key, a.key) ||
              b.interval.start.getTime() - a.interval.start.getTime(),
          );

        const base = snapshot(context);
        const released: typeof candidates = [];
        let fits = false;
        for (const candidate of candidates) {
          release(context, candidate.interval, candidate.taskId);
          released.push(candidate);
          const trial = snapshot(context);
          fits = tryPlace() !== null;
          restore(context, trial);
          if (fits) break;
        }

        if (!fits) {
          restore(context, base);
        } else {
          // Minimality: give back every release the task turns out not to need.
          const needed: typeof candidates = [];
          for (const candidate of released) {
            consume(context, candidate.interval, candidate.taskId, countsAsWork(candidate.taskId));
            const trial = snapshot(context);
            const stillFits = tryPlace() !== null;
            restore(context, trial);
            if (!stillFits) {
              release(context, candidate.interval, candidate.taskId);
              needed.push(candidate);
            }
          }
          const placedNow = tryPlace()!;
          onTime = [...onTime, ...placedNow];
          unplaced = 0;
          adaptive = adaptive || (hard && task.isSplittable);
          for (const candidate of needed) {
            retained.set(
              candidate.taskId,
              (retained.get(candidate.taskId) ?? []).filter((interval) => interval !== candidate.interval),
            );
            displaced.push({ taskId: candidate.taskId, forTaskId: task.id, from: candidate.interval });
            if (!madeRoomBy.includes(candidate.taskId)) madeRoomBy.push(candidate.taskId);
          }
        }
      }
    }

    // --- C: what still does not fit before the deadline ---------------------
    let overtime: OvertimeProposal | null = null;
    if (unplaced > 0 && hard) {
      overtime = proposeOvertime(context, input, task, unplaced, notBefore, deadline, availability.workable, blockedForOvertime);
    }

    let missedDeadline = false;
    const late: PlacedChunk[] = [];
    // With an overtime proposal on the table, late sessions would double-book
    // the same work. Without one, the work still gets a home — after the
    // deadline, said plainly. Refusing to schedule late work helps nobody.
    if (unplaced > 0 && !overtime && deadline) {
      const lastEnd = [...retainedIntervals, ...onTime.map((chunk) => chunk.interval)].reduce<Date>(
        (latest, interval) => (interval.end > latest ? interval.end : latest),
        startCursor,
      );
      const attempt = placeEven(unplaced, lastEnd, undefined);
      for (const chunk of attempt.placed) chunk.explanation.relaxed.push('deadline');
      late.push(...attempt.placed);
      if (attempt.placed.length > 0) missedDeadline = true;
      unplaced = attempt.unplaced;
    }

    // Kept, new and late chunks are merged, so "session 1 of 3" numbers in
    // chronological order regardless of which pass produced them.
    const allChunks: PlacedChunk[] = [
      ...retainedIntervals.map((interval) => ({
        interval,
        explanation: { rankFactors, bindingConstraints: [{ kind: 'retained_from_previous_plan' as const }], relaxed: [] as Relaxation[] },
      })),
      ...onTime,
      ...late,
    ].sort((a, b) => a.interval.start.getTime() - b.interval.start.getTime());

    allChunks.forEach((chunk, index) => {
      blocks.push({
        taskId: task.id,
        start: chunk.interval.start,
        end: chunk.interval.end,
        isPinned: false,
        chunkIndex: index + 1,
        chunkCount: allChunks.length,
        ...(task.committedTo ? { committedDay: task.committedTo.start } : {}),
        explanation: {
          ...chunk.explanation,
          ...(madeRoomBy.length > 0 ? { displaced: madeRoomBy } : {}),
          ...(adaptive && chunk.explanation.adaptive ? { adaptive: true } : {}),
        },
      });
    });

    if (allChunks.length > 0) finishedAt.set(task.id, allChunks[allChunks.length - 1]!.interval.end);

    // Late is late whichever pass placed it, including a kept session.
    if (deadline && allChunks.some((chunk) => chunk.interval.end > deadline)) missedDeadline = true;

    const spilledMinutes = [...onTime, ...late]
      .filter((chunk) => chunk.leftDay)
      .reduce((sum, chunk) => sum + durationMinutes(chunk.interval), 0);
    const placedMinutes = totalMinutes(allChunks.map((chunk) => chunk.interval));
    const shortfall = task.remainingMinutes - placedMinutes;

    if (overtime) {
      overtimeProposals.push(overtime);
      unscheduled.push({
        taskId: task.id,
        reason: 'DEADLINE_UNREACHABLE',
        explanation:
          `${shortfall} minutes of "${task.title}" don't fit before its hard deadline inside your working hours. ` +
          `There's an overtime proposal waiting — nothing goes outside your hours unless you approve it.`,
        shortfallMinutes: shortfall,
      });
    } else if (shortfall > 0) {
      const beyondHorizon = !missedDeadline && deadline !== undefined && deadline >= availability.bounds.end;
      const reason: UnscheduledReason = missedDeadline
        ? 'DEADLINE_UNREACHABLE'
        : beyondHorizon
          ? 'BEYOND_HORIZON'
          : 'NO_AVAILABLE_TIME';
      unscheduled.push({
        taskId: task.id,
        reason,
        explanation: beyondHorizon
          ? `${shortfall} minutes of "${task.title}" don't fit in the planning window yet. ` +
            `It isn't due until after it, so the rest is planned as the window moves forward.`
          : placedMinutes === 0
            ? `There is no free time left in your working hours for "${task.title}".`
            : `Only ${placedMinutes} of ${task.remainingMinutes} minutes of "${task.title}" ` +
              `would fit. ${shortfall} minutes still need a home.`,
        shortfallMinutes: shortfall,
      });
    } else if (missedDeadline) {
      unscheduled.push({
        taskId: task.id,
        reason: 'DEADLINE_UNREACHABLE',
        explanation:
          `"${task.title}" is scheduled, but the last session lands after its deadline. ` +
          `Something needs to give: a later deadline, a smaller scope, or moving something else.`,
        shortfallMinutes: 0,
      });
    }

    if (spilledMinutes > 0 && task.committedTo) {
      spilled.push({
        taskId: task.id,
        committedTo: task.committedTo,
        spilledMinutes,
        explanation:
          `That day was already full, so ${spilledMinutes} minutes of "${task.title}" ` +
          `moved to the next opening. Nothing was dropped.`,
      });
    }
  }

  blocks.sort((a, b) => a.start.getTime() - b.start.getTime() || a.taskId.localeCompare(b.taskId));

  const violations = checkPlanInvariants(input, { blocks });
  if (violations.length > 0) throw new PlanInvariantError(violations);

  return {
    blocks,
    unscheduled,
    spilled,
    changes: [],
    overtimeProposals,
    days: summarizeDays(input, availability.free, blocks, spilled, context),
    displaced,
    stats: {
      availableMinutes: totalMinutes(availability.free),
      scheduledMinutes: blocks.reduce((sum, block) => sum + durationMinutes(block), 0),
      tasksScheduled: new Set(blocks.map((block) => block.taskId)).size,
      tasksUnscheduled: new Set(unscheduled.map((entry) => entry.taskId)).size,
    },
  };
}

/** Per-day capacity (§13.B.5): what was free, what was promised, what landed. */
function summarizeDays(
  input: SchedulingInput,
  free: Interval[],
  blocks: PlannedBlock[],
  spilled: SpilledCommitment[],
  context: PlacementContext,
): DaySummary[] {
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  const isWork = (taskId: string) => tasks.get(taskId)?.countsAsWork !== false;
  const days: DaySummary[] = [];
  for (let offset = 0; offset < input.horizonDays; offset += 1) {
    const day = startOfLocalDay(input.now, input.timeZone, offset);
    const next = startOfLocalDay(input.now, input.timeZone, offset + 1);
    const span: Interval = { start: day, end: next };
    const committed = input.tasks.filter(
      (task) => task.countsAsWork !== false && task.committedTo && task.committedTo.start.getTime() === day.getTime(),
    );
    const availableMinutes = totalMinutes(intersectIntervals(free, [span]));
    const committedMinutes = committed.reduce((sum, task) => sum + task.remainingMinutes, 0);
    const scheduledMinutes = blocks
      .filter((block) => isWork(block.taskId) && block.start >= day && block.start < next)
      .reduce((sum, block) => sum + durationMinutes(block), 0);
    days.push({
      day,
      availableMinutes,
      committedMinutes,
      scheduledMinutes,
      overcommitted: committedMinutes > availableMinutes - committed.length * context.bufferMinutes,
      spilledMinutes: spilled
        .filter((entry) => entry.committedTo.start.getTime() === day.getTime())
        .reduce((sum, entry) => sum + entry.spilledMinutes, 0),
    });
  }
  return days;
}
