/**
 * Calendar sync, for every provider: pulling, pushing, and the rules that make
 * it safe to run unattended.
 *
 * The adapters speak protocols and know nothing about us; the reconciler
 * decides what a result means and knows nothing about a database. This module
 * is where they meet, and it owns the rules:
 *
 *   - A CURSOR IS SAVED IN THE SAME TRANSACTION AS THE BATCH IT DESCRIBES.
 *     Saved separately, a crash between the two would advance past changes
 *     that were never applied — and they would never be offered again.
 *
 *   - A WRITE LEAVES THROUGH THE OUTBOX, NEVER DIRECTLY. Every outbound change
 *     is a row with a unique idempotency key, retried until it lands. With the
 *     adapters' idempotent creates, at-least-once becomes effectively-once.
 *
 *   - OUR OWN BLOCKS COMING BACK ARE NOT MEETINGS. A pull that returns a block
 *     we created is matched to it (by provider id, or by our UID if the create
 *     response was lost) instead of being stored as an external event. If the
 *     user moved it in their calendar app, that is intent: the new time is
 *     adopted and the session pinned, so the scheduler will not move it back.
 *     If they deleted it, the session goes too, and is not recreated.
 *
 * Provider differences live in `adapterFor` and nowhere else.
 */
import 'server-only';
import {
  reconcile,
  type LocalEvent as ReconcilableEvent,
  type RemoteChange,
} from '@fluid/core';
import { features } from '@fluid/env';
import { openSecret } from '@fluid/crypto';
import { prisma, type CalendarConnection, type Db, type Event, type Prisma } from '@fluid/db';
import {
  appBlockUid,
  createAppBlock,
  softDeleteAppBlock,
  updateAppBlock,
  upsertFromRemote,
} from '@fluid/db/repositories';
import {
  AuthenticationError,
  CalendarError,
  NotFoundError,
  PreconditionFailedError,
  type CalendarAdapter,
  type CalendarRef,
  type ConnectionRef,
  type RemoteCalendar,
  type RemoteEvent,
} from '@fluid/calendar';
import { CalDavAdapter } from '@fluid/calendar/adapters/caldav';
import { googleAdapter, openGoogleCredentials, revokeGoogle } from './google';

/** Bound into the AAD, so a credential row cannot be moved between users. */
export const CALDAV_CREDENTIAL_PURPOSE = 'caldav-credentials';

/** Attempts before an outbound write is parked for a human to look at. */
const MAX_OUTBOX_ATTEMPTS = 5;

export interface SyncSummary {
  calendars: number;
  created: number;
  updated: number;
  deleted: number;
  pushed: number;
  /** Blocks the user moved or deleted in their calendar app. */
  adopted: number;
  /** Set when the deletion circuit breaker halted the sync. */
  halted?: string;
  /** Set when the sync failed outright. */
  error?: string;
}

const emptySummary = (): SyncSummary => ({ calendars: 0, created: 0, updated: 0, deleted: 0, pushed: 0, adopted: 0 });

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * Every adapter is built here, so provider-specific wiring — the CalDAV
 * localhost exemption, Google's token refresh — is decided in one place.
 */
export function adapterFor(provider: CalendarConnection['provider']): CalendarAdapter {
  switch (provider) {
    case 'CALDAV':
      return new CalDavAdapter({ allowLocalhost: features.caldavLocalhost });
    case 'GOOGLE':
      return googleAdapter();
    default:
      throw new CalendarError(`${provider} calendars are not supported yet.`, false);
  }
}

export function connectionRef(connection: Pick<CalendarConnection, 'id' | 'userId' | 'provider' | 'encryptedCredentials'>): ConnectionRef {
  if (connection.provider === 'GOOGLE') {
    // The access token is fetched (and refreshed) per request by the adapter;
    // only the refresh token's presence matters here.
    const { refreshToken } = openGoogleCredentials(connection);
    return { id: connection.id, userId: connection.userId, provider: 'GOOGLE', credentials: { refreshToken } };
  }

  const credentials = JSON.parse(
    openSecret(connection.encryptedCredentials, { userId: connection.userId, purpose: CALDAV_CREDENTIAL_PURPOSE }),
  ) as { serverUrl: string; username: string; password: string };
  return { id: connection.id, userId: connection.userId, provider: 'CALDAV', credentials };
}

/**
 * Record the calendars a connection exposes. New calendars count as busy time
 * if the user shows them in their own calendar app; the first writable one
 * becomes the place blocks are written, unless the user already has one.
 */
export async function storeRemoteCalendars(
  userId: string,
  connectionId: string,
  remoteCalendars: RemoteCalendar[],
): Promise<void> {
  const existing = await prisma.calendar.count({ where: { userId, isWriteTarget: true } });
  let claimedWriteTarget = existing > 0;

  // The provider's primary calendar is the best default write target.
  const ordered = [...remoteCalendars].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));

  for (const remote of ordered) {
    const isWriteTarget = !claimedWriteTarget && remote.canWrite;
    if (isWriteTarget) claimedWriteTarget = true;

    await prisma.calendar.upsert({
      where: { connectionId_externalId: { connectionId, externalId: remote.externalId } },
      create: {
        connectionId,
        userId,
        externalId: remote.externalId,
        name: remote.name,
        timeZone: remote.timeZone,
        ...(remote.color ? { color: remote.color } : {}),
        canWrite: remote.canWrite,
        isSelected: remote.selected ?? true,
        isWriteTarget,
      },
      update: { name: remote.name, timeZone: remote.timeZone, canWrite: remote.canWrite },
    });
  }
}

export async function disconnectCalendar(userId: string, connectionId: string): Promise<void> {
  const connection = await prisma.calendarConnection.findFirst({
    where: { id: connectionId, userId },
    include: { calendars: true },
  });
  if (!connection) return;

  if (connection.provider === 'GOOGLE') {
    // Stop push channels and give the grant back; both best effort.
    const adapter = adapterFor('GOOGLE');
    for (const calendar of connection.calendars) {
      if (calendar.watchChannelId && calendar.watchResourceId) {
        await adapter
          .unwatch?.(connectionRef(connection), {
            channelId: calendar.watchChannelId,
            resourceId: calendar.watchResourceId,
            expiresAt: calendar.watchExpiresAt ?? new Date(),
            token: '',
          })
          .catch(() => {});
      }
    }
    await revokeGoogle(connection);
  }

  // Marked disconnected rather than deleted: the events and the sync history
  // stay readable, and a reconnect does not look like a first-time link.
  await prisma.$transaction([
    prisma.calendarConnection.update({
      where: { id: connection.id },
      data: { status: 'DISCONNECTED', statusDetail: 'Disconnected in Settings.' },
    }),
    prisma.calendar.updateMany({
      where: { connectionId: connection.id },
      data: { isWriteTarget: false, watchChannelId: null, watchResourceId: null, watchExpiresAt: null, watchTokenDigest: null },
    }),
  ]);
}

export async function setWriteTarget(userId: string, calendarId: string): Promise<void> {
  const target = await prisma.calendar.findFirst({ where: { id: calendarId, userId } });
  if (!target) throw new NotFoundError(calendarId);
  if (!target.canWrite) {
    throw new CalendarError('That calendar is read-only, so blocks cannot be written to it.', false);
  }

  // One statement pair, one transaction: a partial unique index enforces
  // "at most one write target per user", so these cannot be separated.
  await prisma.$transaction([
    prisma.calendar.updateMany({ where: { userId, isWriteTarget: true }, data: { isWriteTarget: false } }),
    prisma.calendar.update({ where: { id: calendarId }, data: { isWriteTarget: true } }),
  ]);
}

// ---------------------------------------------------------------------------
// Pulling
// ---------------------------------------------------------------------------

export async function syncAllConnections(userId: string): Promise<SyncSummary> {
  const connections = await prisma.calendarConnection.findMany({ where: { userId, status: 'ACTIVE' } });
  const total = emptySummary();

  for (const connection of connections) {
    const summary = await syncConnection(connection.id);
    total.calendars += summary.calendars;
    total.created += summary.created;
    total.updated += summary.updated;
    total.deleted += summary.deleted;
    total.pushed += summary.pushed;
    total.adopted += summary.adopted;
    if (summary.halted) total.halted = summary.halted;
    if (summary.error) total.error = summary.error;
  }

  return total;
}

/**
 * Pull every selected calendar on a connection, then push queued writes.
 *
 * Never throws for a provider failure: it records what happened where a
 * person can see it (the sync log, the connection's status) and returns. A
 * background job that throws on a revoked token would retry forever.
 */
export async function syncConnection(connectionId: string): Promise<SyncSummary> {
  const connection = await prisma.calendarConnection.findUniqueOrThrow({
    where: { id: connectionId },
    include: { calendars: true },
  });
  const summary = emptySummary();
  if (connection.status !== 'ACTIVE') return summary;

  const startedAt = new Date();

  try {
    const adapter = adapterFor(connection.provider);
    const ref = connectionRef(connection);

    for (const calendar of connection.calendars) {
      // Calendars that are not busy time are still pulled when they hold our
      // blocks — otherwise edits to blocks there would never be seen.
      if (!calendar.isSelected && !calendar.isWriteTarget) continue;

      const result = await pullCalendar(adapter, ref, calendar);
      summary.calendars += 1;
      summary.created += result.created;
      summary.updated += result.updated;
      summary.deleted += result.deleted;
      summary.adopted += result.adopted;

      if (result.halted) {
        summary.halted = result.halted;
        // Halt the whole connection, not just this calendar. Whatever produced a
        // mass disappearance is unlikely to be limited to one collection.
        await prisma.calendarConnection.update({
          where: { id: connection.id },
          data: { status: 'NEEDS_ATTENTION', statusDetail: result.halted },
        });
        await prisma.syncLog.create({
          data: {
            connectionId: connection.id,
            direction: 'PULL',
            outcome: 'CIRCUIT_BROKEN',
            message: result.halted,
            startedAt,
            finishedAt: new Date(),
          },
        });
        return summary;
      }
    }

    await prisma.syncLog.create({
      data: {
        connectionId: connection.id,
        direction: 'PULL',
        outcome: 'SUCCESS',
        eventsCreated: summary.created,
        eventsUpdated: summary.updated,
        eventsDeleted: summary.deleted,
        message:
          `Pulled ${summary.calendars} calendar(s).` +
          (summary.adopted > 0 ? ` Kept ${summary.adopted} change(s) you made to Fluid blocks in your calendar app.` : ''),
        startedAt,
        finishedAt: new Date(),
      },
    });
    await prisma.calendarConnection.update({
      where: { id: connection.id },
      data: { lastSyncAt: new Date(), lastSyncError: null },
    });

    // Outbound work runs after the pull, so a block we are about to push is
    // reconciled against the freshest view of the calendar.
    await mirrorScheduledBlocks(connection.userId);
    summary.pushed = await drainOutbox(connectionId);
  } catch (error) {
    summary.error = await recordSyncFailure(connection.id, startedAt, error);
  }

  return summary;
}

async function recordSyncFailure(connectionId: string, startedAt: Date, error: unknown): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  const needsUser = error instanceof AuthenticationError || (error instanceof CalendarError && !error.retryable);

  await prisma.syncLog.create({
    data: { connectionId, direction: 'PULL', outcome: 'FAILED', message: message.slice(0, 500), startedAt, finishedAt: new Date() },
  });
  await prisma.calendarConnection.update({
    where: { id: connectionId },
    data: {
      lastSyncError: message.slice(0, 500),
      // A revoked grant or a refused permission will not fix itself; stop and
      // say so. Network trouble just waits for the next attempt.
      ...(needsUser ? { status: 'NEEDS_ATTENTION' as const, statusDetail: message.slice(0, 500) } : {}),
    },
  });
  return message;
}

interface CalendarPullResult {
  created: number;
  updated: number;
  deleted: number;
  adopted: number;
  halted?: string;
}

async function pullCalendar(
  adapter: CalendarAdapter,
  connection: ConnectionRef,
  calendar: { id: string; externalId: string; timeZone: string; syncCursor: string | null; needsFullResync: boolean },
): Promise<CalendarPullResult> {
  const ref: CalendarRef = { id: calendar.id, externalId: calendar.externalId, timeZone: calendar.timeZone };

  let result = await adapter.pull(connection, ref, calendar.needsFullResync ? undefined : (calendar.syncCursor ?? undefined));

  if (result.fullResyncRequired) {
    // The provider rejected our cursor. Start again from a snapshot — under the
    // circuit breaker, which is the only reason a resync is safe to do at all.
    result = await adapter.pull(connection, ref, undefined);
  }

  const local = await prisma.event.findMany({
    where: { calendarId: calendar.id },
    select: { id: true, externalId: true, origin: true, startsAt: true, deletedAt: true, iCalUid: true },
  });

  const plan = reconcile({
    changes: result.changes.map((event): RemoteChange => ({ externalId: event.externalId, isDeleted: event.isDeleted })),
    local: local as ReconcilableEvent[],
    isFullSnapshot: result.isFullSnapshot,
    ...(result.snapshotWindow ? { snapshotWindow: result.snapshotWindow } : {}),
  });

  if (plan.circuitBroken) {
    // The cursor is deliberately not advanced: the next attempt must see the
    // same state, so nothing is skipped once a person has looked at it.
    return { created: 0, updated: 0, deleted: 0, adopted: 0, halted: plan.reason ?? 'Sync halted.' };
  }

  const known = new Set(local.map((event) => event.externalId).filter(Boolean) as string[]);
  const byExternalId = new Map(result.changes.map((event) => [event.externalId, event]));
  const ownByUid = new Map(
    local.filter((event) => event.origin === 'APP_BLOCK' && event.iCalUid).map((event) => [event.iCalUid!, event]),
  );
  const ownByExternalId = new Map(
    local.filter((event) => event.origin === 'APP_BLOCK' && event.externalId).map((event) => [event.externalId!, event]),
  );

  let created = 0;
  let updated = 0;
  let adopted = 0;

  // One transaction for the batch and its cursor together. A crash rolls both
  // back, so the next run re-reads the same changes rather than skipping them.
  await prisma.$transaction(
    async (tx) => {
      for (const change of plan.upserts) {
        const event = byExternalId.get(change.externalId);
        if (!event) continue;

        const own = ownByExternalId.get(event.externalId) ?? (event.iCalUid ? ownByUid.get(event.iCalUid) : undefined);
        if (own) {
          if (await adoptOwnBlock(tx, own.id, event)) adopted += 1;
          continue;
        }

        await writeRemoteEvent(tx, calendar.id, event);
        if (known.has(change.externalId)) updated += 1;
        else created += 1;
      }

      if (plan.tombstones.length > 0) {
        // A Fluid block deleted in the calendar app: the user removed that
        // session. Drop it rather than push it back.
        const removedBlocks = await tx.scheduledBlock.findMany({
          where: { eventId: { in: plan.tombstones }, event: { origin: 'APP_BLOCK' } },
          select: { id: true, eventId: true },
        });
        const pending = await tx.pendingRemoteOp.findMany({
          where: { eventId: { in: removedBlocks.map((block) => block.eventId!) }, status: { in: ['PENDING', 'IN_FLIGHT'] } },
          select: { eventId: true },
        });
        const busy = new Set(pending.map((op) => op.eventId));
        const toDelete = removedBlocks.filter((block) => !busy.has(block.eventId));
        if (toDelete.length > 0) {
          await tx.scheduledBlock.deleteMany({ where: { id: { in: toDelete.map((block) => block.id) } } });
          adopted += toDelete.length;
        }

        await tx.event.updateMany({
          where: { id: { in: plan.tombstones }, deletedAt: null },
          data: { deletedAt: new Date() },
        });
      }

      await tx.calendar.update({
        where: { id: calendar.id },
        data: { syncCursor: result.nextCursor ?? null, needsFullResync: false },
      });
    },
    { timeout: 60_000 },
  );

  return { created, updated, deleted: plan.tombstones.length, adopted };
}

/**
 * One of our blocks, as the provider now has it.
 *
 * Returns true when the user changed it in their calendar app and we adopted
 * the change. An outbound write still queued for this event means *we* moved
 * it and the provider has not heard yet — the remote copy is stale, not a
 * decision, so it is left alone and the outbox's ETag check settles it.
 */
async function adoptOwnBlock(tx: Prisma.TransactionClient, eventId: string, remote: RemoteEvent): Promise<boolean> {
  const local = await tx.event.findUniqueOrThrow({ where: { id: eventId }, include: { scheduledBlock: true } });

  // First sight of a create whose response was lost: link it, change nothing else.
  if (!local.externalId || local.externalId !== remote.externalId) {
    await tx.event.update({
      where: { id: local.id },
      data: { externalId: remote.externalId, ...(remote.etag ? { etag: remote.etag } : {}) },
    });
  }

  const moved =
    local.startsAt.getTime() !== remote.startsAt.getTime() || local.endsAt.getTime() !== remote.endsAt.getTime();
  if (!moved) {
    if (remote.etag && remote.etag !== local.etag) {
      await tx.event.update({ where: { id: local.id }, data: { etag: remote.etag } });
    }
    return false;
  }

  const queued = await tx.pendingRemoteOp.count({
    where: { eventId: local.id, status: { in: ['PENDING', 'IN_FLIGHT'] } },
  });
  if (queued > 0) return false;

  await updateAppBlock(
    local.id,
    { startsAt: remote.startsAt, endsAt: remote.endsAt },
    tx,
  );
  await tx.event.update({ where: { id: local.id }, data: { ...(remote.etag ? { etag: remote.etag } : {}) } });

  if (local.scheduledBlock) {
    await tx.scheduledBlock.update({
      where: { id: local.scheduledBlock.id },
      // Pinned: a time the person chose by hand is not the scheduler's to undo.
      data: { startsAt: remote.startsAt, endsAt: remote.endsAt, isPinned: true },
    });
  }

  await tx.syncConflict.create({
    data: {
      calendarId: local.calendarId,
      eventId: local.id,
      resolution: 'ACCEPTED_AS_INTENT',
      localVersion: { startsAt: local.startsAt.toISOString(), endsAt: local.endsAt.toISOString() },
      remoteVersion: { startsAt: remote.startsAt.toISOString(), endsAt: remote.endsAt.toISOString() },
      explanation: 'You moved this block in your calendar app, so Fluid kept your time and pinned it.',
      resolvedAt: new Date(),
    },
  });
  return true;
}

async function writeRemoteEvent(db: Db, calendarId: string, event: RemoteEvent): Promise<Event> {
  return upsertFromRemote(
    calendarId,
    event.externalId,
    {
      calendarId,
      externalId: event.externalId,
      iCalUid: event.iCalUid ?? null,
      etag: event.etag ?? null,
      sequence: event.sequence ?? null,
      title: event.title,
      description: event.description ?? null,
      location: event.location ?? null,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      isAllDay: event.isAllDay,
      timeZone: event.timeZone,
      // Verbatim, straight through. We never re-emit a rule we did not author.
      rrule: event.rrule ?? null,
      recurringEventId: event.recurringEventId ?? null,
      originalStartsAt: event.originalStartsAt ?? null,
      status: event.status,
      transparency: event.transparency,
      remoteUpdatedAt: event.remoteUpdatedAt ?? null,
      // The provider authored it, so the provider is the authority for it —
      // and the repository will never let the scheduler write to it.
      origin: 'EXTERNAL',
    },
    db,
  );
}

// ---------------------------------------------------------------------------
// Pushing
// ---------------------------------------------------------------------------

/**
 * Mirror accepted blocks into calendar events, and queue the writes.
 *
 * A `ScheduledBlock` is our own idea of a work session; the `Event` is its
 * shadow on a real calendar. Keeping them separate is what lets the app work
 * perfectly well with no calendar connected at all.
 */
export async function mirrorScheduledBlocks(userId: string): Promise<void> {
  const target = await prisma.calendar.findFirst({
    where: { userId, isWriteTarget: true, canWrite: true },
    include: { connection: true },
  });
  if (!target || target.connection.status !== 'ACTIVE') return;

  const blocks = await prisma.scheduledBlock.findMany({
    where: { task: { userId }, state: 'ACCEPTED' },
    include: { task: { select: { title: true } }, event: true },
  });

  for (const block of blocks) {
    if (!block.event) {
      const event = await createAppBlock({
        calendarId: target.id,
        iCalUid: appBlockUid(block.id),
        title: block.task.title,
        startsAt: block.startsAt,
        endsAt: block.endsAt,
        timeZone: target.timeZone,
      });

      await prisma.scheduledBlock.update({ where: { id: block.id }, data: { eventId: event.id } });
      await enqueue(target.connection.id, target.id, 'CREATE', event.id, `create:${event.id}`);
      continue;
    }

    const moved =
      block.event.startsAt.getTime() !== block.startsAt.getTime() ||
      block.event.endsAt.getTime() !== block.endsAt.getTime() ||
      block.event.title !== block.task.title;

    if (!moved || block.event.deletedAt) continue;

    await updateAppBlock(block.event.id, { title: block.task.title, startsAt: block.startsAt, endsAt: block.endsAt });

    // The key includes the times, so re-queueing the same move collapses into
    // one row while a genuinely new move gets its own.
    await enqueue(
      target.connection.id,
      target.id,
      'UPDATE',
      block.event.id,
      `update:${block.event.id}:${block.startsAt.getTime()}-${block.endsAt.getTime()}:${block.task.title.length}`,
    );
  }

  // A block that no longer exists leaves an orphaned event behind. Removing it
  // is the only deletion this module performs, and it only ever targets an
  // event we created.
  const orphans = await prisma.event.findMany({
    where: { calendarId: target.id, origin: 'APP_BLOCK', deletedAt: null, scheduledBlock: null },
  });

  for (const orphan of orphans) {
    await softDeleteAppBlock(orphan.id, new Date());
    await enqueue(target.connection.id, target.id, 'DELETE', orphan.id, `delete:${orphan.id}`);
  }
}

async function enqueue(
  connectionId: string,
  calendarId: string,
  kind: 'CREATE' | 'UPDATE' | 'DELETE',
  eventId: string,
  idempotencyKey: string,
): Promise<void> {
  await prisma.pendingRemoteOp.upsert({
    where: { idempotencyKey },
    create: { connectionId, calendarId, kind, eventId, idempotencyKey },
    // Already queued. Re-queuing must not reset the attempt count, or a
    // failing write would retry forever instead of parking itself.
    update: {},
  });
}

/**
 * Send queued writes to the provider.
 *
 * Every failure mode gets its own answer: a version conflict means someone
 * edited the event elsewhere and our copy is stale, a missing event means it
 * was deleted at the source, and a network error simply means "later".
 */
export async function drainOutbox(connectionId: string): Promise<number> {
  const connection = await prisma.calendarConnection.findUniqueOrThrow({ where: { id: connectionId } });
  if (connection.status !== 'ACTIVE') return 0;

  const ops = await prisma.pendingRemoteOp.findMany({
    where: { connectionId, status: 'PENDING', nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' },
    take: 50,
    include: { calendar: true },
  });
  if (ops.length === 0) return 0;

  const adapter = adapterFor(connection.provider);
  const ref = connectionRef(connection);
  let pushed = 0;

  for (const op of ops) {
    const calendar: CalendarRef = { id: op.calendar.id, externalId: op.calendar.externalId, timeZone: op.calendar.timeZone };

    try {
      await prisma.pendingRemoteOp.update({
        where: { id: op.id },
        data: { status: 'IN_FLIGHT', attempts: { increment: 1 } },
      });

      const event = op.eventId ? await prisma.event.findUnique({ where: { id: op.eventId } }) : null;

      if (!event) {
        await prisma.pendingRemoteOp.update({
          where: { id: op.id },
          data: { status: 'SUCCEEDED', completedAt: new Date(), lastError: 'Event no longer exists.' },
        });
        continue;
      }

      if (op.kind === 'CREATE') {
        const remote = await adapter.createEvent(ref, calendar, {
          iCalUid: event.iCalUid ?? appBlockUid(event.id),
          title: event.title,
          ...(event.description ? { description: event.description } : {}),
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          timeZone: event.timeZone,
          transparency: event.transparency,
        });
        await prisma.event.update({
          where: { id: event.id },
          data: { externalId: remote.externalId, etag: remote.etag ?? null },
        });
      } else if (op.kind === 'UPDATE' && event.externalId) {
        const remote = await adapter.updateEvent(
          ref,
          calendar,
          { externalId: event.externalId, ...(event.etag ? { etag: event.etag } : {}) },
          { title: event.title, startsAt: event.startsAt, endsAt: event.endsAt },
        );
        await prisma.event.update({ where: { id: event.id }, data: { etag: remote.etag ?? null } });
      } else if (op.kind === 'DELETE' && event.externalId) {
        await adapter.deleteEvent(ref, calendar, {
          externalId: event.externalId,
          ...(event.etag ? { etag: event.etag } : {}),
        });
      }

      await prisma.pendingRemoteOp.update({
        where: { id: op.id },
        data: { status: 'SUCCEEDED', completedAt: new Date(), lastError: null },
      });
      pushed += 1;
    } catch (error) {
      await recordFailure(op.id, op.attempts + 1, error);
      // A revoked grant fails every remaining op the same way; stop here.
      if (error instanceof AuthenticationError) throw error;
    }
  }

  return pushed;
}

async function recordFailure(opId: string, attempts: number, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  // Someone edited our block in their own calendar app. That is user intent,
  // not a fault: the next pull adopts their version and pins it, so retrying
  // our stale copy would undo a deliberate change.
  if (error instanceof PreconditionFailedError) {
    await prisma.pendingRemoteOp.update({
      where: { id: opId },
      data: {
        status: 'FAILED',
        lastError: 'The event was changed in another calendar app; their version was kept.',
        completedAt: new Date(),
      },
    });
    return;
  }

  // Already gone at the provider. Retrying a delete that has happened would
  // only ever produce the same answer.
  if (error instanceof NotFoundError) {
    await prisma.pendingRemoteOp.update({
      where: { id: opId },
      data: { status: 'SUCCEEDED', completedAt: new Date(), lastError: 'Already gone at the server.' },
    });
    return;
  }

  const retryable = !(error instanceof CalendarError) || error.retryable;
  const exhausted = attempts >= MAX_OUTBOX_ATTEMPTS;

  await prisma.pendingRemoteOp.update({
    where: { id: opId },
    data: {
      // Parked, never dropped. A write that cannot be delivered is something a
      // person needs to see, not something to discard quietly.
      status: !retryable || exhausted ? 'DEAD_LETTER' : 'PENDING',
      lastError: message.slice(0, 500),
      // Exponential backoff, so a provider having a bad afternoon is not hammered.
      nextAttemptAt: new Date(Date.now() + Math.min(2 ** attempts, 60) * 30_000),
    },
  });
}
