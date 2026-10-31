/**
 * Background calendar work, on BullMQ.
 *
 * Three jobs:
 *
 *   sync           one connection: pull, adopt changes, push queued writes.
 *                  Requested by push notifications, by plan changes, by the
 *                  poll below — deduplicated into five-second windows so a
 *                  burst of webhooks becomes one sync.
 *   poll           every 10 minutes, a sync for every active connection. The
 *                  safety net: CalDAV has no push at all, and Google's push
 *                  needs a public HTTPS address many self-hosters do not have.
 *   renew-watches  hourly, keep Google push channels alive (they expire).
 *
 * The worker runs inside the web server process, started from
 * instrumentation-node.ts. BullMQ hands each job to exactly one worker, so
 * several replicas are fine. If Redis is unreachable, a requested sync runs
 * inline instead — slower, but never lost.
 */
import 'server-only';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '@fluid/env';
import { prisma } from '@fluid/db';
import { syncConnection } from '../services/calendar-sync';
import { renewWatches } from '../services/calendar-watch';

const QUEUE_NAME = 'fluid-calendar';
const POLL_EVERY_MS = 10 * 60_000;
const RENEW_EVERY_MS = 60 * 60_000;
/** Requests inside one window share a job. */
const DEDUPE_WINDOW_MS = 5_000;

type JobData = { connectionId: string; reason: string } | Record<string, never>;

declare global {
  // Survive dev-mode module reloads without opening a second connection.
  var __fluidCalendarQueue: Queue<JobData> | undefined;
  var __fluidCalendarWorker: Worker<JobData> | undefined;
}

function redis(): IORedis {
  const connection = new IORedis(env.REDIS_URL, {
    // Required by BullMQ for blocking commands.
    maxRetriesPerRequest: null,
    // Fail fast when Redis is down, so requestSync can fall back to inline.
    enableOfflineQueue: false,
    lazyConnect: false,
  });
  // Without a listener, every reconnect attempt is an unhandled error event.
  connection.on('error', (error) => {
    if (process.uptime() > 5) console.warn('[jobs] redis:', error.message);
  });
  return connection;
}

function queue(): Queue<JobData> {
  globalThis.__fluidCalendarQueue ??= new Queue<JobData>(QUEUE_NAME, { connection: redis() });
  return globalThis.__fluidCalendarQueue;
}

/**
 * Ask for a connection to be synced soon. Never throws: a missing Redis
 * degrades to an inline sync, not a lost one.
 */
export async function requestSync(connectionId: string, reason: string, delayMs = 0): Promise<void> {
  try {
    await queue().add(
      'sync',
      { connectionId, reason },
      {
        jobId: `sync-${connectionId}-${Math.floor((Date.now() + delayMs) / DEDUPE_WINDOW_MS)}`,
        delay: delayMs,
        removeOnComplete: true,
        removeOnFail: 200,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      },
    );
  } catch (error) {
    console.warn('[jobs] queue unavailable, syncing inline:', error instanceof Error ? error.message : error);
    void syncConnection(connectionId).catch((inline) => console.error('[jobs] inline sync failed', inline));
  }
}

/**
 * The user's plan changed: get it onto their calendar. Only connections that
 * hold their write target have anything to push.
 */
export async function requestPushForUser(userId: string, reason: string): Promise<void> {
  const connections = await prisma.calendarConnection.findMany({
    where: { userId, status: 'ACTIVE', calendars: { some: { isWriteTarget: true } } },
    select: { id: true },
  });
  await Promise.all(connections.map((connection) => requestSync(connection.id, reason)));
}

async function runJob(job: Job<JobData>): Promise<unknown> {
  switch (job.name) {
    case 'sync': {
      const { connectionId } = job.data as { connectionId: string };
      return syncConnection(connectionId);
    }
    case 'poll': {
      const connections = await prisma.calendarConnection.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
      await Promise.all(connections.map((connection) => requestSync(connection.id, 'poll')));
      return { queued: connections.length };
    }
    case 'renew-watches':
      return renewWatches();
    default:
      return null;
  }
}

export async function startCalendarWorker(): Promise<void> {
  if (globalThis.__fluidCalendarWorker) return;

  const worker = new Worker<JobData>(QUEUE_NAME, runJob, {
    connection: redis(),
    // Syncs are I/O-bound; two at a time keeps one slow provider from
    // holding everyone else up without hammering any one of them.
    concurrency: 2,
  });
  worker.on('failed', (job, error) => console.error(`[jobs] ${job?.name} failed:`, error.message));
  worker.on('error', (error) => console.warn('[jobs] worker:', error.message));
  globalThis.__fluidCalendarWorker = worker;

  try {
    // Idempotent: every replica may declare the same schedulers.
    await queue().upsertJobScheduler('poll', { every: POLL_EVERY_MS }, { name: 'poll', data: {} });
    await queue().upsertJobScheduler('renew-watches', { every: RENEW_EVERY_MS }, { name: 'renew-watches', data: {} });
  } catch (error) {
    console.warn('[jobs] could not register schedules (is Redis running?):', error instanceof Error ? error.message : error);
  }
}
