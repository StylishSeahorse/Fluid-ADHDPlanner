# 0002 — Phase 2: calendar sync and the background worker

Status: accepted, 31 October 2026. Context: [blueprint §14](../blueprint/04-sync-ai-collaboration.md#14-calendar-integration-and-synchronisation), [roadmap Phase 2](../blueprint/06-delivery.md#phase-2--planning-on-boards-calendar-integrations-worker).

## What was built

- **Google Calendar adapter** (`packages/calendar/src/adapters/google`). It
  passes the shared adapter contract, plus Google-specific tests against a
  scripted Calendar API.
- **One sync engine for every provider** (`apps/web/src/server/services/calendar-sync.ts`),
  extracted from the CalDAV-only service. `caldav.ts` now only connects a CalDAV server.
- **Google sign-in:** OAuth 2.0 with PKCE and offline access, sealed state
  cookie, token refresh, revocation on disconnect, and least-privilege scopes
  (`calendar.calendarlist.readonly`, `calendar.events`).
- **Push notifications from Google:** a webhook receiver checks the channel id
  plus a secret token, stored only as a digest. Channels are renewed hourly
  before they expire.
- **Background worker:** BullMQ on the existing Redis, inside the web process.
  It runs syncs requested by pushes, plan changes and AI actions, a 10-minute
  safety poll, and push-channel renewal.
- **Recurring events become busy time** for every provider (see below).

## Decisions

1. **The worker runs in the web process, not a separate `apps/worker`.** The
   blueprint pictured a separate container. Running it in-process keeps
   self-hosting to one app container. BullMQ already guarantees each job
   runs on one worker, so replicas stay safe, and `WORKER_DISABLED=1` trims a
   replica. A separate process can be added later by importing
   `startCalendarWorker()` from a small entry point. Nothing else changes.

2. **Recurring series are stored verbatim and expanded at read time.** Before
   this phase, nothing expanded recurrence. A weekly meeting blocked only its
   first week, and because planning read only events ending after "now", a
   series that began last month blocked nothing at all. That was true for
   CalDAV too. Asking Google for expanded instances (`singleEvents=true`)
   would have fixed only Google, and it breaks the contract's "rules
   verbatim" property. So:
   - `@fluid/core`'s `expandRecurrence` / `occurrencesInWindow` (15 tests,
     including DST) expand in the event's own zone.
   - `services/external-events.ts` is now the only way the app reads meetings.
   - All six previous direct queries go through it.

3. **A cancelled occurrence inside a series is kept as an exception, not a
   deletion.** Google reports it as a cancelled item with a
   `recurringEventId`. Treating that as "deleted" would have left the
   occurrence blocking time.

4. **Our own blocks coming back from a pull are matched, not stored as
   meetings.** They are matched by provider id, or by our UID when a create
   response was lost. Then:
   - A block **moved** in the calendar app is adopted and pinned, and recorded
     as `ACCEPTED_AS_INTENT`. `architecture.md` described this but it was not
     implemented.
   - A block **deleted** there removes the session.
   - A remote copy with our own outbound write still queued is treated as
     stale, not as a decision.

5. **Idempotent Google creates use client-chosen ids**: a SHA-256 of the block
   UID. A retried create gets 409 and adopts the existing event. If the id
   belongs to an event deleted since, it is revived rather than failing.

6. **Fluid's blocks are created with Google's default reminders off.** Fluid
   sends its own notifications, so leaving Google's on would double them.

7. **Declined meetings and events marked "free" are not busy time.** In Google
   all-day events are "free" by default. That covers the blueprint's all-day
   policy (R-06) without a separate setting.

## Verified, and how

| Claim | Evidence |
|---|---|
| Adapter safety properties (no deletion without a signal, idempotent create, ETag precondition, verbatim RRULE) | Shared contract suite against the scripted Google API — `google.test.ts` |
| End-to-end sync against real Postgres | An integration run (not committed) with Google's HTTP answered by the fake. 14 checks passed: expansion of a month-old series, declined meetings, push, echo matching, move adoption, delete removal, 410 resync, token refresh, revoked grant |
| Sign-in redirect | Real server: Google auth URL, PKCE S256, offline/consent, HttpOnly state cookie scoped to the callback |
| Webhook and worker | Real server and Redis: bad token and unknown channel get 404; a valid notification queues a sync, which the worker runs |
| Error path to real Google | That sync reached Google's real token endpoint. Google rejected the test client, and Fluid recorded it as a paused connection with a readable reason |

## Not verified — needs a real Google OAuth client

- A full sign-in, a real calendar list, and real events. No OAuth client
  was available in this environment.
- How Google's real responses differ from the fake in detail: field
  shapes, `nextSyncToken` placement, push-channel lifetime. The adapter
  follows Google's documented API, but was written without live
  access to it.
- Google's verification requirements for the `calendar.events` scope, if
  Fluid is offered to the public as a hosted service. A self-hosted app in
  *Testing* mode needs no verification.

## Deferred from Phase 2

- **Microsoft 365 / Outlook adapter.** The blueprint allowed this to slip to
  Phase 4.
- **A side calendar on the board**, the **"estimate assumed"** flag for tasks
  without an estimate, and **showing the Pomodoro and task timers together** in
  Focus mode. These are planning-UI items, picked up with the rest of Phase 1's
  remaining work.
