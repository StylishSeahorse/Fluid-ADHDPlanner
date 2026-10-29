/**
 * The notification dispatcher.
 *
 * Runs inside the web server process, once a minute, started from
 * `instrumentation.ts`. That is deliberately modest: there is no background
 * worker yet, and a reminder system that needs one more container to deploy
 * is one most self-hosters would never switch on.
 *
 * Correctness does not depend on there being exactly one process. Every send
 * first claims a row in `notification_deliveries` under a unique key, so two
 * replicas ticking at the same instant race on an insert and only one wins.
 * A process that dies between claim and send loses that one notification —
 * acceptable for a reminder, and far better than a duplicate buzz.
 */
import 'server-only';
import { Prisma, prisma } from '@fluid/db';
import { dueNotifications, startOfLocalDay } from '@fluid/core';
import { sendToUser, type DeliveryResult, type PushPayload } from './push';

const TICK_MS = 60_000;
/** Look a little behind and an hour ahead — `dueNotifications` narrows it. */
const LOOKBEHIND_MS = 5 * 60_000;
const LOOKAHEAD_MS = 65 * 60_000;
const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * Claim a notification. Returns false when someone (another tick, another
 * replica) already has — the unique index is the lock.
 */
async function claim(userId: string, kind: string, refKey: string): Promise<boolean> {
  try {
    await prisma.notificationDelivery.create({ data: { userId, kind, refKey } });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
    throw error;
  }
}

/**
 * Release a claim so the next tick retries. Only when nothing was delivered
 * and at least one device might succeed later — a notification that reached
 * one phone is done, even if a second phone was offline.
 */
async function releaseIfUndelivered(
  userId: string,
  kind: string,
  refKey: string,
  result: DeliveryResult,
): Promise<void> {
  if (result.sent === 0 && result.retryable > 0) {
    await prisma.notificationDelivery
      .delete({ where: { userId_kind_refKey: { userId, kind, refKey } } })
      .catch(() => {});
  }
}

/** One pass over everyone who has a device subscribed. */
export async function runNotificationTick(now = new Date()): Promise<number> {
  const users = await prisma.user.findMany({
    where: { pushSubscriptions: { some: {} } },
    select: {
      id: true,
      timeZone: true,
      preferences: true,
      workingHours: { select: { dayOfWeek: true, startTime: true, endTime: true } },
    },
  });

  let sent = 0;

  for (const user of users) {
    const prefs = user.preferences;
    if (prefs && !prefs.nudgesEnabled) continue;

    const dayStart = startOfLocalDay(now, user.timeZone);
    const dayEnd = startOfLocalDay(now, user.timeZone, 1);

    const [blocks, dayLog, blocksToday, committedToday] = await Promise.all([
      prisma.scheduledBlock.findMany({
        where: {
          task: { userId: user.id, status: { notIn: ['DONE', 'CANCELLED'] } },
          state: 'ACCEPTED',
          startsAt: {
            gte: new Date(now.getTime() - LOOKBEHIND_MS),
            lte: new Date(now.getTime() + LOOKAHEAD_MS),
          },
        },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          task: {
            select: { title: true, timerStartedAt: true, project: { select: { name: true } } },
          },
        },
      }),
      prisma.dayLog.findUnique({ where: { userId_day: { userId: user.id, day: dayStart } } }),
      prisma.scheduledBlock.count({
        where: {
          task: { userId: user.id },
          state: { in: ['ACCEPTED', 'COMPLETED'] },
          startsAt: { gte: dayStart, lt: dayEnd },
        },
      }),
      prisma.task.count({ where: { userId: user.id, plannedFor: dayStart } }),
    ]);

    const due = dueNotifications({
      now,
      timeZone: user.timeZone,
      prefs: {
        enabled: prefs?.nudgesEnabled ?? true,
        blockReminders: prefs?.pushBlockReminders ?? true,
        dayPrompts: prefs?.pushDayPrompts ?? true,
        leadMinutes: prefs?.reminderLeadMinutes ?? 5,
        quietHoursStart: prefs?.quietHoursStart,
        quietHoursEnd: prefs?.quietHoursEnd,
      },
      workingHours: user.workingHours,
      blocks: blocks.map((block) => ({
        id: block.id,
        taskTitle: block.task.title,
        startsAt: block.startsAt,
        endsAt: block.endsAt,
        projectName: block.task.project?.name ?? null,
        timerRunning: block.task.timerStartedAt !== null,
      })),
      day: { plannedAt: dayLog?.plannedAt, shutdownAt: dayLog?.shutdownAt },
      hasWorkToday: blocksToday + committedToday > 0,
    });

    for (const notification of due) {
      if (!(await claim(user.id, notification.kind, notification.refKey))) continue;

      const payload: PushPayload = {
        title: notification.title,
        body: notification.body,
        url: notification.url,
        tag: notification.tag,
        ...(notification.actions ? { actions: notification.actions } : {}),
      };

      try {
        const result = await sendToUser(user.id, payload);
        sent += result.sent;
        await releaseIfUndelivered(user.id, notification.kind, notification.refKey, result);
      } catch (error) {
        await prisma.notificationDelivery
          .delete({
            where: {
              userId_kind_refKey: { userId: user.id, kind: notification.kind, refKey: notification.refKey },
            },
          })
          .catch(() => {});
        console.error('[notifications] delivery failed', { userId: user.id, kind: notification.kind, error });
      }
    }
  }

  // The ledger only needs to outlive the windows it guards; prune it hourly.
  if (now.getUTCMinutes() === 0) {
    await prisma.notificationDelivery.deleteMany({
      where: { sentAt: { lt: new Date(now.getTime() - LEDGER_RETENTION_MS) } },
    });
  }

  return sent;
}

declare global {
  // Survives Next's dev-mode module reloads, so a hot reload does not start a
  // second loop beside the first.
  var __fluidNotificationLoop: ReturnType<typeof setInterval> | undefined;
}

export function startNotificationLoop(): void {
  if (globalThis.__fluidNotificationLoop) return;

  let running = false;
  const tick = async () => {
    if (running) return; // A slow pass must not overlap the next one.
    running = true;
    try {
      await runNotificationTick();
    } catch (error) {
      console.error('[notifications] tick failed', error);
    } finally {
      running = false;
    }
  };

  globalThis.__fluidNotificationLoop = setInterval(tick, TICK_MS);
  globalThis.__fluidNotificationLoop.unref?.();
  setTimeout(tick, 5_000).unref?.();
}
