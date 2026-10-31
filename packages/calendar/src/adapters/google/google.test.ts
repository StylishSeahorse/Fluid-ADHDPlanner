/**
 * The Google adapter, against a scripted Calendar API.
 *
 * First the shared contract — the same safety properties every provider must
 * have — then Google's own hazards: the 410 that means "resync", the 409 that
 * makes creates idempotent, a cancelled occurrence inside a series, declined
 * meetings, all-day dates, and the one-shot token refresh after a 401.
 */
import { describe, expect, it } from 'vitest';
import { runAdapterContract } from '../../testing/contract';
import {
  AuthenticationError,
  NotFoundError,
  PreconditionFailedError,
  ReadOnlyCalendarError,
  type CalendarRef,
  type ConnectionRef,
} from '../../types';
import { fromGoogle, GoogleCalendarAdapter, googleEventId } from './index';
import { EXPIRED_SYNC_TOKEN, FakeGoogleCalendar, VALID_TOKEN } from './fake-server';

const connection: ConnectionRef = {
  id: 'conn-g',
  userId: 'user-1',
  provider: 'GOOGLE',
  credentials: { accessToken: VALID_TOKEN, refreshToken: 'refresh' },
};

const calendar: CalendarRef = { id: 'cal-1', externalId: 'primary-cal', timeZone: 'Europe/London' };

function setup(options: { pageSize?: number } = {}) {
  const server = new FakeGoogleCalendar();
  const adapter = new GoogleCalendarAdapter({ fetch: server.fetch, baseUrl: 'https://fake.test/calendar/v3', ...options });
  return { server, adapter };
}

runAdapterContract('Google', () => {
  const { server, adapter } = setup();
  return {
    adapter,
    connection,
    calendar,
    seedRemote: (event) => {
      const stored = server.seed('primary-cal', {
        id: event.externalId,
        summary: event.title ?? 'Event',
        start: { dateTime: (event.startsAt ?? new Date('2026-06-15T09:00:00Z')).toISOString(), timeZone: event.timeZone ?? 'Europe/London' },
        end: { dateTime: (event.endsAt ?? new Date('2026-06-15T10:00:00Z')).toISOString(), timeZone: event.timeZone ?? 'Europe/London' },
        ...(event.rrule ? { recurrence: event.rrule.split(/\r?\n/) } : {}),
      });
      return fromGoogle(stored, 'Europe/London');
    },
    deleteRemote: (externalId) => server.remove('primary-cal', externalId),
  };
});

const draft = {
  iCalUid: 'fluid-block-42@fluid.local',
  title: 'Focus: write the report',
  startsAt: new Date('2026-11-02T09:00:00Z'),
  endsAt: new Date('2026-11-02T10:00:00Z'),
  timeZone: 'Europe/London',
  transparency: 'BUSY' as const,
};

describe('Google specifics', () => {
  it('derives a stable, Google-valid event id from our UID', () => {
    const id = googleEventId(draft.iCalUid);
    expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(googleEventId(draft.iCalUid)).toBe(id);
  });

  it('adopts the existing event when a retried create hits 409', async () => {
    const { server, adapter } = setup();
    const first = await adapter.createEvent(connection, calendar, draft);
    const second = await adapter.createEvent(connection, calendar, draft);

    expect(second.externalId).toBe(first.externalId);
    expect(server.events.get('primary-cal')!.size).toBe(1);
    expect(first.iCalUid).toBe(draft.iCalUid); // read back from the private property
  });

  it('turns off Google’s own reminders on blocks it creates', async () => {
    const { server, adapter } = setup();
    const created = await adapter.createEvent(connection, calendar, draft);
    const stored = server.events.get('primary-cal')!.get(created.externalId)!.event as unknown as { reminders?: { useDefault: boolean } };
    expect(stored.reminders).toEqual({ useDefault: false });
  });

  it('revives a deleted block rather than failing, when its id comes back', async () => {
    const { server, adapter } = setup();
    const created = await adapter.createEvent(connection, calendar, draft);
    server.remove('primary-cal', created.externalId);

    const again = await adapter.createEvent(connection, calendar, draft);
    expect(again.externalId).toBe(created.externalId);
    expect(again.status).toBe('CONFIRMED');
  });

  it('asks for a full resync when the sync token has expired', async () => {
    const { adapter } = setup();
    const result = await adapter.pull(connection, calendar, EXPIRED_SYNC_TOKEN);
    expect(result.fullResyncRequired).toBe(true);
    expect(result.changes).toEqual([]);
  });

  it('follows pages and only then hands back the sync token', async () => {
    const { server, adapter } = setup({ pageSize: 2 });
    for (let index = 0; index < 5; index += 1) {
      server.seed('primary-cal', {
        id: `e${index}`,
        summary: `Event ${index}`,
        start: { dateTime: '2026-11-03T09:00:00Z' },
        end: { dateTime: '2026-11-03T10:00:00Z' },
      });
    }
    const result = await adapter.pull(connection, calendar, undefined);
    expect(result.changes).toHaveLength(5);
    expect(result.nextCursor).toBeTruthy();
  });

  it('keeps a cancelled occurrence of a series as an exception, not a deletion', async () => {
    const { server, adapter } = setup();
    server.seed('primary-cal', {
      id: 'standup',
      summary: 'Standup',
      start: { dateTime: '2026-11-02T09:00:00Z', timeZone: 'Europe/London' },
      end: { dateTime: '2026-11-02T09:15:00Z', timeZone: 'Europe/London' },
      recurrence: ['RRULE:FREQ=DAILY;COUNT=5'],
    });
    const first = await adapter.pull(connection, calendar, undefined);

    server.seed('primary-cal', {
      id: 'standup_20261103T090000Z',
      status: 'cancelled',
      recurringEventId: 'standup',
      originalStartTime: { dateTime: '2026-11-03T09:00:00Z', timeZone: 'Europe/London' },
    });
    const second = await adapter.pull(connection, calendar, first.nextCursor);
    const exception = second.changes.find((event) => event.externalId === 'standup_20261103T090000Z')!;

    expect(exception.isDeleted).toBe(false);
    expect(exception.status).toBe('CANCELLED');
    expect(exception.recurringEventId).toBe('standup');
    expect(exception.originalStartsAt?.toISOString()).toBe('2026-11-03T09:00:00.000Z');
  });

  it('treats a declined meeting as free time', () => {
    const event = fromGoogle(
      {
        id: 'x',
        summary: 'Optional sync',
        start: { dateTime: '2026-11-02T14:00:00Z' },
        end: { dateTime: '2026-11-02T15:00:00Z' },
        attendees: [{ self: true, responseStatus: 'declined' }],
      },
      'UTC',
    );
    expect(event.transparency).toBe('FREE');
  });

  it('reads all-day events as whole local days', () => {
    const event = fromGoogle(
      { id: 'holiday', summary: 'Bank holiday', start: { date: '2026-12-25' }, end: { date: '2026-12-26' }, transparency: 'transparent' },
      'Europe/London',
    );
    expect(event.isAllDay).toBe(true);
    expect(event.startsAt.toISOString()).toBe('2026-12-25T00:00:00.000Z');
    expect(event.endsAt.toISOString()).toBe('2026-12-26T00:00:00.000Z');
    expect(event.transparency).toBe('FREE');
  });

  it('refuses a stale update with the ETag it last saw', async () => {
    const { adapter } = setup();
    const created = await adapter.createEvent(connection, calendar, draft);
    await adapter.updateEvent(connection, calendar, { externalId: created.externalId, etag: created.etag }, { title: 'A' });
    await expect(
      adapter.updateEvent(connection, calendar, { externalId: created.externalId, etag: created.etag }, { title: 'B' }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it('reports a deleted event as gone on update and delete', async () => {
    const { server, adapter } = setup();
    const created = await adapter.createEvent(connection, calendar, draft);
    server.remove('primary-cal', created.externalId);
    await expect(adapter.updateEvent(connection, calendar, { externalId: created.externalId }, { title: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(adapter.deleteEvent(connection, calendar, { externalId: created.externalId })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses writes to a calendar shared read-only', async () => {
    const { adapter } = setup();
    await expect(
      adapter.createEvent(connection, { ...calendar, externalId: 'team-cal' }, draft),
    ).rejects.toBeInstanceOf(ReadOnlyCalendarError);
  });

  it('refreshes the token once after a 401, then succeeds', async () => {
    const server = new FakeGoogleCalendar();
    const calls: boolean[] = [];
    const adapter = new GoogleCalendarAdapter({
      fetch: server.fetch,
      baseUrl: 'https://fake.test/calendar/v3',
      accessToken: async (_connection, { forceRefresh }) => {
        calls.push(forceRefresh);
        return forceRefresh ? VALID_TOKEN : 'stale-token';
      },
    });
    const calendars = await adapter.listCalendars(connection);
    expect(calendars.map((entry) => entry.externalId)).toEqual(['primary-cal', 'team-cal']);
    expect(calls).toEqual([false, true]);
  });

  it('gives up with a non-retryable error when refreshing does not help', async () => {
    const server = new FakeGoogleCalendar();
    const adapter = new GoogleCalendarAdapter({
      fetch: server.fetch,
      baseUrl: 'https://fake.test/calendar/v3',
      accessToken: async () => 'revoked',
    });
    await expect(adapter.listCalendars(connection)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('marks calendars writable by access role and keeps Google’s visibility as the default', async () => {
    const { adapter } = setup();
    const [primary, team] = await adapter.listCalendars(connection);
    expect(primary).toMatchObject({ canWrite: true, isPrimary: true, selected: true });
    expect(team).toMatchObject({ canWrite: false, isPrimary: false, selected: false });
  });

  it('subscribes to push notifications and stops them', async () => {
    const { server, adapter } = setup();
    const subscription = await adapter.watch(connection, calendar, 'https://fluid.example/api/calendar/google/webhook');
    expect(server.channels.get(subscription.channelId)?.address).toBe('https://fluid.example/api/calendar/google/webhook');
    expect(subscription.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await adapter.unwatch(connection, subscription);
    expect(server.channels.size).toBe(0);
  });
});
