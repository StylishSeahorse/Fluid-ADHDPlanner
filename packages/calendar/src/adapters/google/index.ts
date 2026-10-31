/**
 * Google Calendar, over the Calendar API v3.
 *
 * The adapter speaks HTTP and translates; it never touches the database, never
 * refreshes tokens itself and never decides what a sync result means. Three
 * Google-specific details carry the safety properties the contract demands:
 *
 *   IDEMPOTENT CREATES. Google lets the client choose an event's id (base32hex,
 *   5–1024 chars). We derive it from the block's iCalendar UID with SHA-256,
 *   whose hex digits are all valid base32hex. A retried create therefore hits
 *   409 Conflict and adopts the existing event — a lost response can never
 *   become a duplicate on someone's calendar.
 *
 *   NO SILENT OVERWRITES. Updates and deletes send the ETag we last saw as
 *   `If-Match`; a 412 means someone changed the event in Google since, and is
 *   surfaced as PreconditionFailedError rather than retried.
 *
 *   DELETION IS EXPLICIT. A full sync asks for live events only; an incremental
 *   sync (syncToken) reports deletions as `status: cancelled`. Only that marks
 *   an event deleted. An expired token (410 Gone) asks the engine for a full
 *   resync, which it runs under the deletion circuit breaker.
 *
 * Recurring series are fetched as series (`singleEvents=false`) with their
 * RRULE lines verbatim; the planner expands them (see @fluid/core recurrence).
 * A single occurrence cancelled inside a series arrives as a cancelled
 * exception and is kept as such, so expansion removes just that occurrence.
 */
import { createHash, randomUUID } from 'node:crypto';
import { fromLocal } from '@fluid/core';
import type { CalendarAdapter } from '../../adapter';
import {
  AuthenticationError,
  CalendarError,
  NotFoundError,
  PreconditionFailedError,
  RateLimitError,
  ReadOnlyCalendarError,
  type AdapterCapabilities,
  type CalendarRef,
  type ConnectionRef,
  type EventDraft,
  type EventPatch,
  type EventRef,
  type PullResult,
  type RemoteCalendar,
  type RemoteEvent,
  type Subscription,
} from '../../types';

export const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GoogleAdapterOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  /**
   * A current access token for this connection. The server supplies this, so
   * the adapter never sees the client secret or writes credentials anywhere.
   * `forceRefresh` is set after a 401, once, to recover from a token that
   * expired early.
   */
  accessToken?: (connection: ConnectionRef, options: { forceRefresh: boolean }) => Promise<string>;
  /** Page size for event listings. Google's maximum is 2500. */
  pageSize?: number;
}

/** Google's own shapes, reduced to what we read. */
interface GoogleDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  etag?: string;
  iCalUID?: string;
  sequence?: number;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleDateTime;
  end?: GoogleDateTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GoogleDateTime;
  transparency?: 'opaque' | 'transparent';
  updated?: string;
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  extendedProperties?: { private?: Record<string, string> };
}

/** The Google event id for one of our blocks: SHA-256 hex is valid base32hex. */
export function googleEventId(iCalUid: string): string {
  return createHash('sha256').update(iCalUid).digest('hex');
}

function dateOnly(value: string, timeZone: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return fromLocal({ year: year!, month: month!, day: day!, hour: 0, minute: 0, second: 0 }, timeZone);
}

/** Translate a Google event into the normalized vocabulary. */
export function fromGoogle(item: GoogleEvent, calendarTimeZone: string): RemoteEvent {
  const timeZone = item.start?.timeZone ?? item.originalStartTime?.timeZone ?? calendarTimeZone;
  const instant = (value: GoogleDateTime | undefined): Date | undefined =>
    value?.dateTime ? new Date(value.dateTime) : value?.date ? dateOnly(value.date, timeZone) : undefined;

  const originalStartsAt = instant(item.originalStartTime);
  // Cancelled items carry no times. Anchor them on the occurrence they cancel.
  const startsAt = instant(item.start) ?? originalStartsAt ?? new Date(0);
  const endsAt = instant(item.end) ?? startsAt;

  const declined = item.attendees?.some((attendee) => attendee.self && attendee.responseStatus === 'declined') ?? false;
  const cancelled = item.status === 'cancelled';

  return {
    externalId: item.id,
    ...(item.extendedProperties?.private?.fluidUid
      ? { iCalUid: item.extendedProperties.private.fluidUid }
      : item.iCalUID
        ? { iCalUid: item.iCalUID }
        : {}),
    ...(item.etag ? { etag: item.etag } : {}),
    ...(typeof item.sequence === 'number' ? { sequence: item.sequence } : {}),
    title: item.summary ?? '(no title)',
    ...(item.description ? { description: item.description } : {}),
    ...(item.location ? { location: item.location } : {}),
    startsAt,
    endsAt,
    isAllDay: Boolean(item.start?.date ?? item.originalStartTime?.date),
    timeZone,
    // Verbatim, joined the way the CalDAV adapter joins its lines.
    ...(item.recurrence?.length ? { rrule: item.recurrence.join('\r\n') } : {}),
    ...(item.recurringEventId ? { recurringEventId: item.recurringEventId } : {}),
    ...(originalStartsAt ? { originalStartsAt } : {}),
    status: cancelled ? 'CANCELLED' : item.status === 'tentative' ? 'TENTATIVE' : 'CONFIRMED',
    // A meeting you declined does not take your time.
    transparency: item.transparency === 'transparent' || declined ? 'FREE' : 'BUSY',
    ...(item.updated ? { remoteUpdatedAt: new Date(item.updated) } : {}),
    // Deleted means "this event is gone". A cancelled *occurrence* of a series
    // is not that: it is an exception the series needs, kept as CANCELLED.
    isDeleted: cancelled && !item.recurringEventId,
  };
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  readonly provider = 'GOOGLE' as const;

  readonly capabilities: AdapterCapabilities = {
    push: true,
    incrementalSync: true,
    etags: true,
    // We only ever write single events (our own blocks); series stay read-only.
    recurrenceEditScopes: [],
    deletionTombstones: true,
    maxPageSize: 2500,
  };

  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly pageSize: number;
  private readonly accessToken: NonNullable<GoogleAdapterOptions['accessToken']>;

  constructor(options: GoogleAdapterOptions = {}) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = options.baseUrl ?? GOOGLE_API;
    this.pageSize = Math.min(options.pageSize ?? 2500, 2500);
    this.accessToken =
      options.accessToken ??
      (async (connection) => {
        if (!connection.credentials.accessToken) throw new AuthenticationError('No Google access token.');
        return connection.credentials.accessToken;
      });
  }

  // --- HTTP ------------------------------------------------------------------

  private async request(
    connection: ConnectionRef,
    method: string,
    path: string,
    options: { query?: Record<string, string | undefined>; body?: unknown; ifMatch?: string } = {},
  ): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const send = async (forceRefresh: boolean) => {
      const token = await this.accessToken(connection, { forceRefresh });
      return this.fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(options.ifMatch ? { 'If-Match': options.ifMatch } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    };

    let response = await send(false);
    // An access token can lapse before its stated expiry. One refresh, then
    // a 401 is the user's credentials, not a timing problem.
    if (response.status === 401) response = await send(true);
    return response;
  }

  /** Turn a failed response into the typed error the sync engine reacts to. */
  private async fail(response: Response, externalId?: string): Promise<never> {
    let reason = '';
    let message = `Google Calendar returned ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
      reason = body.error?.errors?.[0]?.reason ?? '';
      if (body.error?.message) message = `Google Calendar: ${body.error.message}`;
    } catch {
      // Not JSON; keep the status line.
    }

    switch (response.status) {
      case 401:
        throw new AuthenticationError('Google no longer accepts Fluid’s access. Reconnect Google Calendar.');
      case 403:
        if (['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'].includes(reason)) {
          throw new RateLimitError(60_000);
        }
        throw new ReadOnlyCalendarError(message);
      case 404:
      case 410:
        throw new NotFoundError(externalId ?? 'unknown');
      case 412:
        throw new PreconditionFailedError(externalId ?? 'unknown');
      case 429: {
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new RateLimitError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30_000);
      }
      default:
        throw new CalendarError(message, response.status >= 500);
    }
  }

  private async json<T>(response: Response, externalId?: string): Promise<T> {
    if (!response.ok) return this.fail(response, externalId);
    return (await response.json()) as T;
  }

  private eventsPath(calendar: CalendarRef, id?: string): string {
    const base = `/calendars/${encodeURIComponent(calendar.externalId)}/events`;
    return id ? `${base}/${encodeURIComponent(id)}` : base;
  }

  // --- CalendarAdapter -------------------------------------------------------

  async listCalendars(connection: ConnectionRef): Promise<RemoteCalendar[]> {
    const calendars: RemoteCalendar[] = [];
    let pageToken: string | undefined;

    do {
      const page = await this.json<{
        items?: Array<{
          id: string;
          summary?: string;
          summaryOverride?: string;
          timeZone?: string;
          backgroundColor?: string;
          accessRole?: string;
          primary?: boolean;
          selected?: boolean;
          deleted?: boolean;
        }>;
        nextPageToken?: string;
      }>(await this.request(connection, 'GET', '/users/me/calendarList', { query: { pageToken, maxResults: '250' } }));

      for (const item of page.items ?? []) {
        if (item.deleted) continue;
        calendars.push({
          externalId: item.id,
          name: item.summaryOverride ?? item.summary ?? item.id,
          timeZone: item.timeZone ?? 'UTC',
          ...(item.backgroundColor ? { color: item.backgroundColor } : {}),
          canWrite: item.accessRole === 'owner' || item.accessRole === 'writer',
          isPrimary: Boolean(item.primary),
          selected: item.selected ?? Boolean(item.primary),
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    return calendars;
  }

  async pull(connection: ConnectionRef, calendar: CalendarRef, cursor: string | undefined): Promise<PullResult> {
    const changes: RemoteEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;

    do {
      const response = await this.request(connection, 'GET', this.eventsPath(calendar), {
        query: {
          maxResults: String(this.pageSize),
          singleEvents: 'false',
          pageToken,
          // Incremental: Google includes deletions (status cancelled) by itself.
          // Full: live events only — absence there is never a deletion signal.
          ...(cursor ? { syncToken: cursor } : { showDeleted: 'false' }),
        },
      });

      if (response.status === 410 && cursor) {
        // The sync token expired. Start again from a snapshot.
        return { changes: [], fullResyncRequired: true, isFullSnapshot: false, hasMore: false };
      }

      const page = await this.json<{ items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string; timeZone?: string }>(
        response,
      );
      for (const item of page.items ?? []) changes.push(fromGoogle(item, page.timeZone ?? calendar.timeZone));
      pageToken = page.nextPageToken;
      nextSyncToken = page.nextSyncToken ?? nextSyncToken;
    } while (pageToken);

    return {
      changes,
      ...(nextSyncToken ? { nextCursor: nextSyncToken } : {}),
      fullResyncRequired: false,
      isFullSnapshot: !cursor,
      hasMore: false,
    };
  }

  private body(draft: Partial<EventDraft>, timeZone: string) {
    return {
      ...(draft.title !== undefined ? { summary: draft.title } : {}),
      ...(draft.description !== undefined ? { description: draft.description } : {}),
      ...(draft.startsAt ? { start: { dateTime: draft.startsAt.toISOString(), timeZone } } : {}),
      ...(draft.endsAt ? { end: { dateTime: draft.endsAt.toISOString(), timeZone } } : {}),
      ...(draft.transparency ? { transparency: draft.transparency === 'FREE' ? 'transparent' : 'opaque' } : {}),
    };
  }

  async createEvent(connection: ConnectionRef, calendar: CalendarRef, draft: EventDraft): Promise<RemoteEvent> {
    const id = googleEventId(draft.iCalUid);
    const response = await this.request(connection, 'POST', this.eventsPath(calendar), {
      body: {
        id,
        ...this.body(draft, draft.timeZone),
        // Fluid sends its own reminders; Google's default popups would double them.
        reminders: { useDefault: false },
        extendedProperties: { private: { fluidUid: draft.iCalUid } },
      },
    });

    if (response.status === 409) {
      // Already created by an earlier attempt whose response was lost — adopt it.
      const existing = await this.json<GoogleEvent>(
        await this.request(connection, 'GET', this.eventsPath(calendar, id)),
        id,
      );
      if (existing.status !== 'cancelled') return fromGoogle(existing, calendar.timeZone);

      // The id was used by an event since deleted: Google keeps the id
      // reserved, so bring that event back with the new details instead.
      const revived = await this.request(connection, 'PATCH', this.eventsPath(calendar, id), {
        body: { status: 'confirmed', ...this.body(draft, draft.timeZone) },
      });
      return fromGoogle(await this.json<GoogleEvent>(revived, id), calendar.timeZone);
    }

    return fromGoogle(await this.json<GoogleEvent>(response, id), calendar.timeZone);
  }

  async updateEvent(connection: ConnectionRef, calendar: CalendarRef, ref: EventRef, patch: EventPatch): Promise<RemoteEvent> {
    const response = await this.request(connection, 'PATCH', this.eventsPath(calendar, ref.externalId), {
      body: this.body(patch, calendar.timeZone),
      ...(ref.etag ? { ifMatch: ref.etag } : {}),
    });
    const item = await this.json<GoogleEvent>(response, ref.externalId);
    // Patching a deleted event "succeeds" at Google; to us it is gone.
    if (item.status === 'cancelled') throw new NotFoundError(ref.externalId);
    return fromGoogle(item, calendar.timeZone);
  }

  async deleteEvent(connection: ConnectionRef, calendar: CalendarRef, ref: EventRef): Promise<void> {
    const response = await this.request(connection, 'DELETE', this.eventsPath(calendar, ref.externalId), {
      ...(ref.etag ? { ifMatch: ref.etag } : {}),
    });
    if (!response.ok) await this.fail(response, ref.externalId);
  }

  async watch(connection: ConnectionRef, calendar: CalendarRef, callbackUrl: string): Promise<Subscription> {
    const channelId = randomUUID();
    const token = randomUUID() + randomUUID();
    const response = await this.request(connection, 'POST', `${this.eventsPath(calendar)}/watch`, {
      body: { id: channelId, type: 'web_hook', address: callbackUrl, token },
    });
    const channel = await this.json<{ id: string; resourceId: string; expiration?: string }>(response);
    return {
      channelId: channel.id,
      resourceId: channel.resourceId,
      // Google sets the lifetime; without one, assume a day and renew early.
      expiresAt: new Date(channel.expiration ? Number(channel.expiration) : Date.now() + 86_400_000),
      token,
    };
  }

  async unwatch(connection: ConnectionRef, subscription: Subscription): Promise<void> {
    const response = await this.request(connection, 'POST', '/channels/stop', {
      body: { id: subscription.channelId, resourceId: subscription.resourceId },
    });
    // A channel that already expired is as stopped as it needs to be.
    if (!response.ok && response.status !== 404) await this.fail(response);
  }

  async verifyConnection(connection: ConnectionRef): Promise<boolean> {
    try {
      const response = await this.request(connection, 'GET', '/users/me/calendarList', { query: { maxResults: '1' } });
      return response.ok;
    } catch {
      return false;
    }
  }
}
