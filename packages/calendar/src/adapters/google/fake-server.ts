/**
 * An in-memory Google Calendar API, enough of it to exercise the adapter.
 *
 * It models the behaviours the adapter's safety depends on, rather than the
 * whole API: client-chosen ids with 409 on reuse, ETags with 412 on a stale
 * `If-Match`, sync tokens that return only later changes (deletions as
 * `status: cancelled`), 410 for an expired token, pagination, and 401 for a
 * bad access token. Every version bump is global, so a sync token is simply
 * "the version I last saw".
 */
import type { GoogleEvent } from './index';

export const VALID_TOKEN = 'good-access-token';
export const EXPIRED_SYNC_TOKEN = 'expired-sync-token';

interface Stored {
  event: GoogleEvent;
  version: number;
}

export interface FakeGoogleOptions {
  /** Tokens the server accepts. The first call with any other token gets 401. */
  validTokens?: string[];
  calendars?: Array<{ id: string; summary: string; timeZone: string; accessRole: string; primary?: boolean; selected?: boolean }>;
}

export class FakeGoogleCalendar {
  readonly events = new Map<string, Map<string, Stored>>();
  readonly requests: Array<{ method: string; url: string; ifMatch?: string | null }> = [];
  readonly channels = new Map<string, { resourceId: string; address: string; token: string; calendarId: string }>();
  private version = 1;
  private readonly validTokens: Set<string>;
  readonly calendars: NonNullable<FakeGoogleOptions['calendars']>;

  constructor(options: FakeGoogleOptions = {}) {
    this.validTokens = new Set(options.validTokens ?? [VALID_TOKEN]);
    this.calendars = options.calendars ?? [
      { id: 'primary-cal', summary: 'Alice', timeZone: 'Europe/London', accessRole: 'owner', primary: true, selected: true },
      { id: 'team-cal', summary: 'Team', timeZone: 'Europe/London', accessRole: 'reader', selected: false },
    ];
    for (const calendar of this.calendars) this.events.set(calendar.id, new Map());
  }

  private bump(): number {
    this.version += 1;
    return this.version;
  }

  private etag(version: number): string {
    return `"${version}"`;
  }

  /** Create or replace an event as though made in Google's own UI. */
  seed(calendarId: string, event: GoogleEvent): GoogleEvent {
    const version = this.bump();
    const stored: GoogleEvent = { status: 'confirmed', ...event, etag: this.etag(version), updated: new Date().toISOString() };
    this.events.get(calendarId)!.set(event.id, { event: stored, version });
    return stored;
  }

  /** Delete as though in Google's own UI: kept as cancelled, visible to sync tokens. */
  remove(calendarId: string, id: string): void {
    const stored = this.events.get(calendarId)?.get(id);
    if (!stored) return;
    const version = this.bump();
    stored.event = { id, status: 'cancelled', etag: this.etag(version), ...(stored.event.recurringEventId ? { recurringEventId: stored.event.recurringEventId } : {}) };
    stored.version = version;
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    this.requests.push({ method, url: url.toString(), ifMatch: headers.get('If-Match') });

    const token = headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
    if (!this.validTokens.has(token)) return this.error(401, 'authError', 'Invalid Credentials');

    const path = url.pathname.replace(/^.*\/calendar\/v3/, '');
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (method === 'GET' && path === '/users/me/calendarList') {
      return this.json(200, {
        items: this.calendars.map((calendar) => ({ ...calendar })),
      });
    }

    if (method === 'POST' && path === '/channels/stop') {
      this.channels.delete(String(body.id));
      return new Response(null, { status: 204 });
    }

    const watch = /^\/calendars\/([^/]+)\/events\/watch$/.exec(path);
    const match = watch ? ([watch[0], watch[1], undefined, '/watch'] as const) : /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?()$/.exec(path);
    if (!match) return this.error(404, 'notFound', 'Not Found');
    const calendarId = decodeURIComponent(match[1]!);
    const eventId = match[2] ? decodeURIComponent(match[2]) : undefined;
    const store = this.events.get(calendarId);
    if (!store) return this.error(404, 'notFound', 'Calendar not found');
    const calendar = this.calendars.find((candidate) => candidate.id === calendarId)!;

    if (match[3] && method === 'POST') {
      const resourceId = `resource-${calendarId}`;
      this.channels.set(String(body.id), { resourceId, address: String(body.address), token: String(body.token), calendarId });
      return this.json(200, { id: body.id, resourceId, expiration: String(Date.now() + 7 * 86_400_000) });
    }

    const writable = calendar.accessRole === 'owner' || calendar.accessRole === 'writer';

    if (!eventId && method === 'GET') return this.list(store, url, calendar.timeZone);

    if (!eventId && method === 'POST') {
      if (!writable) return this.error(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.');
      const id = String(body.id ?? `gen${this.version}`);
      if (store.has(id)) return this.error(409, 'duplicate', 'The requested identifier already exists.');
      return this.json(200, this.seed(calendarId, { ...(body as unknown as GoogleEvent), id }));
    }

    const stored = eventId ? store.get(eventId) : undefined;

    if (method === 'GET') {
      return stored ? this.json(200, stored.event) : this.error(404, 'notFound', 'Not Found');
    }

    if (!stored) return this.error(404, 'notFound', 'Not Found');
    if (!writable) return this.error(403, 'requiredAccessLevel', 'Read-only calendar.');
    const ifMatch = headers.get('If-Match');
    if (ifMatch && ifMatch !== stored.event.etag) return this.error(412, 'conditionNotMet', 'Precondition Failed');

    if (method === 'PATCH') {
      if (stored.event.status === 'cancelled' && body.status !== 'confirmed') return this.error(410, 'deleted', 'Resource has been deleted');
      return this.json(200, this.seed(calendarId, { ...stored.event, ...(body as Partial<GoogleEvent>), id: stored.event.id }));
    }

    if (method === 'DELETE') {
      if (stored.event.status === 'cancelled') return this.error(410, 'deleted', 'Resource has been deleted');
      this.remove(calendarId, stored.event.id);
      return new Response(null, { status: 204 });
    }

    return this.error(405, 'methodNotAllowed', 'Method not allowed');
  };

  private list(store: Map<string, Stored>, url: URL, timeZone: string): Response {
    const syncToken = url.searchParams.get('syncToken');
    if (syncToken === EXPIRED_SYNC_TOKEN) return this.error(410, 'fullSyncRequired', 'Sync token is no longer valid');

    const since = syncToken ? Number(syncToken.replace(/^v/, '')) : 0;
    const all = [...store.values()]
      .filter((stored) => (syncToken ? stored.version > since : stored.event.status !== 'cancelled' || stored.event.recurringEventId))
      .sort((a, b) => a.version - b.version);

    const pageSize = Number(url.searchParams.get('maxResults') ?? 250);
    const offset = Number(url.searchParams.get('pageToken') ?? 0);
    const page = all.slice(offset, offset + pageSize);
    const more = offset + pageSize < all.length;

    return this.json(200, {
      timeZone,
      items: page.map((stored) => stored.event),
      ...(more ? { nextPageToken: String(offset + pageSize) } : { nextSyncToken: `v${this.version}` }),
    });
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  private error(status: number, reason: string, message: string): Response {
    return this.json(status, { error: { code: status, message, errors: [{ reason, message }] } });
  }
}
