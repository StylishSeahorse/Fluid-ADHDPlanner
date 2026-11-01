/**
 * Replanning on its own (§13.C triggers), on BullMQ.
 *
 *   replan        one user, debounced: a burst of edits inside a few seconds
 *                 becomes one replan.
 *   auto-accept   Assisted mode's optional countdown, if the user turned it on.
 *   sweep         every five minutes: pinned sessions that ended untouched
 *                 become MISSED, and each gets a recovery proposal (always
 *                 asks); plus the overnight rebuild for users whose day just
 *                 started.
 *
 * If Redis is unreachable the replan runs inline instead — slower, never lost.
 * Manual mode skips automatic triggers entirely: it plans only when asked.
 */
import 'server-only';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '@fluid/env';
import { prisma } from '@fluid/db';
import { startOfLocalDay } from '@fluid/core';
import { acceptPlan, replan, type ReplanTrigger } from '../services/planning';
import { markMissedSessions } from '../services/missed';
import { notifyCalendarChange } from '../live-notify';
import { requestPushForUser } from './calendar-jobs';

const QUEUE_NAME = 'fluid-replan';
const SWEEP_EVERY_MS = 5 * 60_000;

/** How long to wait for more edits before replanning, per trigger. */
const DEBOUNCE_MS: Partial<Record<ReplanTrigger, number>> = {
  commitment_changed: 0,
  task_completed: 0,
  task_overran: 0,
  calendar_synced: 30_000,
  external_event_conflict: 30_000,
};
const DEFAULT_DEBOUNCE_MS = 5_000;
/** Triggers inside one window share a replan. */
const DEDUPE_WINDOW_MS = 5_000;

type JobData =
  | { kind: 'replan'; userId: string; trigger: ReplanTrigger; userInitiated: boolean; requested?: boolean; forcePropose?: boolean }
  | { kind: 'auto-accept'; userId: string; planVersionId: string }
  | { kind: 'sweep' };

declare global {
  var __fluidReplanQueue: Queue<JobData> | undefined;
  var __fluidReplanWorker: Worker<JobData> | undefined;
}

function redis(): IORedis {
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: false });
  connection.on('error', (error) => {
    if (process.uptime() > 5) console.warn('[replan] redis:', error.message);
  });
  return connection;
}

function queue(): Queue<JobData> {
  globalThis.__fluidReplanQueue ??= new Queue<JobData>(QUEUE_NAME, { connection: redis() });
  return globalThis.__fluidReplanQueue;
}

/** Run a replan and tell open tabs and the calendar what happened. */
export async function runReplan(
  userId: string,
  trigger: ReplanTrigger,
  options: { userInitiated?: boolean; requested?: boolean; forcePropose?: boolean } = {},
) {
  const outcome = await replan(userId, { trigger, ...options });
  if (outcome.status === 'applied') await requestPushForUser(userId, `replan-${trigger}`);
  if (outcome.status === 'applied' || outcome.status === 'proposed') await notifyCalendarChange(userId);
  if (outcome.status === 'proposed' && outcome.decision?.autoAcceptAt && outcome.planVersionId) {
    await scheduleAutoAccept(userId, outcome.planVersionId, outcome.decision.autoAcceptAt);
  }
  return outcome;
}

/**
 * Something that may affect the schedule happened. Never throws, and never
 * blocks the request that caused it.
 */
export async function requestReplan(
  userId: string,
  trigger: ReplanTrigger,
  options: { userInitiated?: boolean; delayMs?: number } = {},
): Promise<void> {
  try {
    const preferences = await prisma.userPreferences.findUnique({ where: { userId }, select: { schedulingMode: true } });
    if ((preferences?.schedulingMode ?? 'ASSISTED') === 'MANUAL') return;
  } catch {
    return;
  }
  const delay = options.delayMs ?? DEBOUNCE_MS[trigger] ?? DEFAULT_DEBOUNCE_MS;
  try {
    await queue().add(
      'replan',
      { kind: 'replan', userId, trigger, userInitiated: options.userInitiated ?? false },
      // Deduplicated per user within a short window, not by a fixed id: BullMQ
      // ignores a job whose id matches one still running, so a fixed id would
      // drop any trigger that arrives mid-replan. Two overlapping replans are
      // safe — the advisory lock and the epoch check serialize their writes.
      // Failed jobs are not kept, for the same reason.
      {
        jobId: `replan-${userId}-${Math.floor((Date.now() + delay) / DEDUPE_WINDOW_MS)}`,
        delay,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  } catch (error) {
    console.warn('[replan] queue unavailable, replanning inline:', error instanceof Error ? error.message : error);
    void runReplan(userId, trigger, { userInitiated: options.userInitiated ?? false }).catch((inline) =>
      console.error('[replan] inline replan failed', inline),
    );
  }
}

async function scheduleAutoAccept(userId: string, planVersionId: string, at: Date): Promise<void> {
  try {
    await queue().add(
      'auto-accept',
      { kind: 'auto-accept', userId, planVersionId },
      { jobId: `accept-${planVersionId}`, delay: Math.max(0, at.getTime() - Date.now()), removeOnComplete: true, removeOnFail: true },
    );
  } catch {
    // No Redis, no countdown: the proposal simply waits for an answer.
  }
}

/** Missed sessions, and the overnight rebuild for users whose day just began. */
export async function sweep(now = new Date()): Promise<{ missed: number; rollovers: number }> {
  const missedUsers = await markMissedSessions(now);
  for (const userId of missedUsers) {
    // A missed session placed by hand gets a recovery *proposal* in every
    // mode, Manual included: Fluid asks rather than moving it (REQ-SCH-LOCK).
    await runReplan(userId, 'missed_session', { requested: true, forcePropose: true }).catch((error) =>
      console.error('[replan] recovery failed', error),
    );
  }

  // Overnight rebuild: users whose local time is within the first sweep
  // window after midnight, so the new day starts with a fresh plan.
  let rollovers = 0;
  const users = await prisma.user.findMany({
    where: { preferences: { schedulingMode: { not: 'MANUAL' } } },
    select: { id: true, timeZone: true },
  });
  for (const user of users) {
    const sinceMidnight = now.getTime() - startOfLocalDay(now, user.timeZone).getTime();
    if (sinceMidnight >= 5 * 60_000 && sinceMidnight < 5 * 60_000 + SWEEP_EVERY_MS) {
      await requestReplan(user.id, 'daily_rollover', { delayMs: 0 });
      rollovers += 1;
    }
  }
  return { missed: missedUsers.length, rollovers };
}

async function runJob(job: Job<JobData>): Promise<unknown> {
  const data = job.data;
  switch (data.kind) {
    case 'replan':
      return runReplan(data.userId, data.trigger, data);
    case 'auto-accept': {
      const accepted = await acceptPlan(data.userId, data.planVersionId, 'countdown').catch(() => false);
      if (accepted) {
        await requestPushForUser(data.userId, 'plan-auto-accepted');
        await notifyCalendarChange(data.userId);
      }
      return { accepted };
    }
    case 'sweep':
      return sweep();
  }
}

export async function startReplanWorker(): Promise<void> {
  if (globalThis.__fluidReplanWorker) return;
  const worker = new Worker<JobData>(QUEUE_NAME, runJob, { connection: redis(), concurrency: 2 });
  worker.on('failed', (job, error) => console.error(`[replan] ${job?.name} failed:`, error.message));
  worker.on('error', (error) => console.warn('[replan] worker:', error.message));
  globalThis.__fluidReplanWorker = worker;
  try {
    await queue().upsertJobScheduler('sweep', { every: SWEEP_EVERY_MS }, { name: 'sweep', data: { kind: 'sweep' } });
  } catch (error) {
    console.warn('[replan] could not register the sweep (is Redis running?):', error instanceof Error ? error.message : error);
  }
}
