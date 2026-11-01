# Fluid

**A calendar that negotiates with you.** A planner for ADHD brains that treats a
day as a thing with a size, not a list with no bottom.

You decide which **day** work belongs to. The scheduler works out **when** inside
it, around your real meetings. Neither half overrules the other — the AI never
picks your day, and you never have to hand-place a block.

> Sunsama's shape, Motion's engine.

---

## The loop

The product is a day with a beginning, a middle and an end. Most planners only
give you the middle.

```
  MORNING                     DURING                      EVENING
  ─────────                   ──────                      ───────
  /plan-day                   /today  ·  /focus           shutdown

  Close off yesterday    →    One thing at a time    →    What today added
  Choose today's work         Times re-project from       up to, grouped
  Watch the capacity          the clock as you run        Unfinished work is
  meter while you pick        over or finish early        a decision, not a
                                                          silent rollover
       ▲                                                        │
       └──────────────  tomorrow starts here  ──────────────────┘
```

Three things this gets right that a to-do list cannot:

- **A day has a size.** Capacity is working hours minus meetings, routines,
  personal time and transition buffers. Overcommitment is reported while you can
  still act on it — never silently corrected at 6pm.
- **Plans change, and that is not a failure.** Missed work is surfaced as a
  choice with a count attached ("moved 5 times — usually too big, rarely
  unimportant"), not as a red overdue pile.
- **The schedule stays believable.** A replan moves only what genuinely has to
  move, because a plan that reshuffles wholesale stops working as the external
  structure you were leaning on.

---

## The screens

| Screen | The question it answers | What is on it |
|---|---|---|
| **Today** | What am I doing now? | The day as a list beside the day as a timeline, plus the rituals that bracket it |
| **Week** | Which day does this belong to? | Board, Calendar and Agenda are *lenses* on one page — same seven days, three readings |
| **Boards** | Where is this work in its project? | Kanban boards with your own columns, labels, checklists, comments, files and history, as a board or a table; templates and saved views; plan any card into a day from the card |
| **Tasks** | What exists at all? | Backlog by horizon, projects, braindump capture |
| **Review** | How did that go? | Objectives, estimate calibration, where the time went, what the AI did |
| **Settings** | How should this behave? | Accessibility, areas, routines, focus rhythm, AI autonomy and provider, calendars |

Two full-screen flows sit outside the sidebar, because they are things you
*enter* rather than places you browse: the morning ritual (`/plan-day`) and
focus mode (`/focus`), both reached from Today.

### The Week board

Drag work onto the day you mean to do it. The column header is the argument:

```
  Mon 24 Aug          Tue 25 Aug          Wed 26 Aug
  ▓▓▓▓▓▓▓░░░░         ░░░░░░░░░░░         ▓▓░░░░░░░░░
  4h 40m of 7h        0 min of 6h 45m     1h 10m of 7h
  ─────────────       ─────────────       ─────────────
  ● Reply to Dana     ● Book the          ● Rehearse the
    15m   09:00         dentist             presentation
    due 3 days ago      15m   09:00         1h    09:00
  ● Pull Q3 numbers
    45m   09:30
  ● Write the
    quarterly report
    3h    10:30
```

That is a real board, and Tuesday is the interesting column. The dentist
appointment is in a **Personal** area, so it shrinks the day from 7h to 6h 45m —
it genuinely consumes 9am — while contributing **nothing** to the work the day
owes. Excluding it outright would report free time that does not exist; counting
it as work delivered would be a lie in the other direction.

Monday's 4h 40m is 4h of work plus four 10-minute transition buffers. The report
was split into two sittings, because a 3h block nobody starts is worse than two
that get finished.

A time on a card is where the scheduler put it. An arrow instead — `→ Fri` —
means it could **not** honour the day you picked, because the column was full or
the task cannot start until later. It then says where the work actually went,
rather than showing a time belonging to a different day. Silently relocating it
is the one option not on the table.

Drag is the fast path, never the only one. Every card also carries a "move to"
menu, because native HTML5 dragging is invisible to keyboards and awkward on
touch — and touch is where this app gets used, one-handed, mid-transition.

---

## Quickstart

Requires Node 22+ and Docker.

```bash
npm install
npm run infra:up
```

Copy `.env.example` to `.env`, then generate a key and paste it in as
`ENCRYPTION_KEK`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```bash
npm run db:migrate
npm run db:seed
npm run dev
```

The app is on **http://localhost:3030**. Sign in as `demo@fluid.local` /
`demo-password-1234`.

Postgres listens on **5433** and Redis on **6380** — non-default, so they do not
collide with anything already running locally.

```bash
npm run verify   # lint + typecheck + 501 tests
```

**AI is optional.** With no provider configured the deterministic scheduler runs
on its own and every screen works. Add a key in Settings when you want the AI
ordering hint and the calendar agent; set `AI_DISABLED=1` to switch the whole
surface off.

### Running the built image instead

`npm run dev` is for working on Fluid. To run it the way it actually ships —
production build, `next start`, no dev server:

```bash
docker compose up -d --build
```

This builds the image from the repo root (needed so the workspace packages are
in the build context), then starts Postgres, Redis and the app together. Apply
migrations once against it and you're on **http://localhost:3030**:

```bash
npm run migrate:deploy -w @fluid/db
```

**Subscription sign-in works here too.** The image ships with the `claude` and
`codex` CLIs installed, so the "browser sign-in" AI providers in Settings are
usable in the container, not just on a laptop. Sign in once, as the user the
server actually runs as — a login as root or on the host writes credentials
this server will never see:

```bash
docker compose exec -u nextjs web claude auth login
docker compose exec -u nextjs web codex login --device-auth
```

Both print a URL and take a pasted or device code, so no browser is needed
inside the container. Credentials persist in named volumes across rebuilds.
Settings shows the real state — installed, signed in, or neither — rather than
reciting a command regardless of whether it could work.

---

## On your phone

Fluid is an installable app (a PWA) with push notifications. There is no app
store step: Chrome on Android installs it straight from the site.

**1. Serve it over HTTPS.** Android only installs apps and delivers push to
secure origins. `localhost` counts as secure on the machine itself, but your
phone is a different machine, so it needs a real HTTPS address:

- **To keep it** — put the Docker image behind a reverse proxy with a
  certificate (Caddy does this in two lines) and set `APP_URL` to that address.
- **To try it** — a tunnel such as `cloudflared tunnel --url http://localhost:3030`
  or Tailscale Funnel gives you an HTTPS URL in a minute.

**2. Install.** Open the address in Chrome on the phone and sign in. Tap
**Install** in the top bar (it appears as soon as Chrome says the app is
installable), or use the Chrome menu ⋮ → *Install app*. Fluid then opens
full-screen from its own home-screen icon; long-pressing the icon offers
shortcuts to Today, Plan my day, Focus and adding tasks.

**3. Turn on notifications.** In the installed app go to
**Settings → Notifications → Turn on**, allow the prompt, then **Send a test**.
Notifications are per device; turn them on on each phone or laptop you want
nudged.

What it sends, each one switchable:

| Notification | When |
|---|---|
| **Up next** | A few minutes before each scheduled session (0–30, your choice), with a *Start focus* button |
| **Plan your day** | At the start of your working hours, if the day has not been planned |
| **Time to wrap up** | At the end of your working hours, if the day had work and has not been closed |

Nothing is sent during your quiet hours, and every reminder follows the time
zone in **Settings → Your day** (captured from your device when you sign up).

Offline, the app keeps the last copy of Today, Week, Tasks and Review you
opened, and shows a plain offline screen for anything else. It never caches
writes, and signing out clears the offline copies.

> **Android battery saving** can delay notifications from any app. If reminders
> arrive late, set Chrome (or the installed Fluid app) to *Unrestricted* under
> Android's battery settings.

---

## Connecting Google Calendar

Self-hosting means bringing your own Google OAuth client. It is free and takes
about ten minutes:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project and enable the **Google Calendar API**.
2. Under **APIs & Services → OAuth consent screen**, set up an app (External is
   fine for personal use) and add the scopes
   `…/auth/calendar.calendarlist.readonly` and `…/auth/calendar.events`.
   While the app is in *Testing*, add your own Google address as a test user.
3. Under **Credentials → Create credentials → OAuth client ID**, choose *Web
   application* and add the redirect URI `<APP_URL>/api/calendar/google/callback`
   — for example `https://fluid.example.com/api/calendar/google/callback`.
4. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`, restart, and use **Settings → Calendars → Connect
   Google Calendar**.

Optional: set `GOOGLE_WEBHOOK_URL` to
`https://<your-domain>/api/calendar/google/webhook` and changes made in Google
reach Fluid within seconds. Without it — or on localhost — Fluid checks every
10 minutes. Settings says which one you have.

What syncs, and which way:

| | |
|---|---|
| Meetings in calendars you show in Google | Busy time the scheduler works around. Recurring series included; meetings you declined and events marked *free* are not busy |
| Accepted Fluid blocks | Written to one calendar (your primary, changeable in Settings), without Google's own pop-up reminders — Fluid sends its own |
| You move a Fluid block in Google | Fluid keeps your time and pins the block so the scheduler leaves it alone |
| You delete a Fluid block in Google | That session is removed in Fluid and not put back |
| Google revokes access | Syncing pauses with the reason in Settings; nothing is deleted. Reconnect to resume |

## Files and the API

**Attachments** are stored on disk in `STORAGE_DIR` (default `data/uploads`,
up to `MAX_UPLOAD_MB` each). Docker Compose mounts the `fluid-uploads` volume
there, so files survive rebuilds; back it up along with the database.

**The REST API** lets scripts read and change your boards. Make a token in
**Settings → API tokens**, then:

```bash
curl -H "Authorization: Bearer fluid_pat_…" https://fluid.example.com/api/v1/cards?q=due:week
```

The full reference is in [docs/api.md](docs/api.md).

---

## How it is built

```
packages/env       Validated config — the ONLY module that reads process.env
packages/crypto    Envelope encryption, Argon2id passwords, opaque tokens
packages/db        Prisma schema, migrations, repositories
packages/core      Scheduler, interval algebra, zoned time — pure, no I/O
packages/calendar  CalendarAdapter interface + fake + shared contract suite
packages/ai        AIProvider interface, provider registry, adapters, redaction,
                   validation, SSRF guard
apps/web           Next.js app router, tRPC, server actions
```

`@fluid/core` has no dependencies at all. That is deliberate: the scheduler is
the part that must be right, and a pure function over plain data can be tested
exhaustively in milliseconds.

Three load-bearing ideas, in one line each:

1. **The deterministic scheduler decides; the AI only advises.** The model
   proposes an *ordering*, which the engine then applies every hard constraint
   to. Its suggested times are discarded. So the app works with AI off, and a
   prompt injected through a meeting invite cannot produce an illegal schedule.
2. **The scheduler physically cannot touch a real meeting.** Enforced three
   times over — repository vocabulary, a runtime origin check, and database
   triggers — because a bug that deletes someone's meetings ends the product's
   usefulness permanently, even after the bug is fixed.
3. **A day is a commitment the user makes.** `Task.plannedFor` is a soft
   scheduling window that outranks the engine's own priority ordering, and when
   it cannot be honoured the spill is reported rather than hidden.

The full reasoning — nine decisions, including calendar-sync ownership, AI
autonomy gating, and the capacity ledger — is in
**[docs/architecture.md](docs/architecture.md)**.

Where Fluid goes next — permanent Kanban boards, workspaces and teams on top of
this engine, researched against Sunsama, Motion, Trello and Nextcloud Deck — is
specified in **[docs/blueprint/](docs/blueprint/README.md)**.

---

## Verifying the guarantees

The database guards are checkable directly, against a fixture the script creates
and cleans up:

```bash
docker exec -i fluid-postgres psql -U fluid -d fluid -q < scripts/verify-db-guards.sql
```

Six checks. Five must print an `ERROR` — including *"the scheduler may only own
APP_BLOCK events"* and *"events.origin is immutable"* — and the sixth, binding a
block to an event we created, must succeed. Anything else means a guard has
regressed.

The two suites that matter most:

```bash
npx vitest run packages/core/src/scheduler   # the engine
npx vitest run packages/calendar             # the sync safety net
```

The first covers protected-time inviolability (including against an urgent
deadline), replan stability, day-commitment relaxation order, determinism, and
DST correctness across a real Europe/London transition.

The second runs the adapter contract suite twice — once as a full-capability
provider, once shaped like CalDAV (no push, no ETags, no delta sync) — including
*"never marks an event deleted without an explicit provider signal"*, the
property that stops a full resync becoming mass data loss.

---

## Status

**Running.** Auth, tasks and projects, the scheduler, all five screens, both
full-screen flows, project boards (with files, tables, templates, saved views
and live updates), a REST API, Google Calendar and CalDAV sync with a
background worker, the AI calendar agent, and the installable app with push
notifications work end to end. 501 tests.

<details>
<summary><b>What works</b></summary>

- Signup / login / logout, DB-backed sessions, per-page auth guard
- Deterministic scheduler with the full constraint set, plus a plain-language
  plan diff you accept or reject
- Day commitments (`plannedFor`) as a soft scheduling window, with spill reported
- Week board, calendar grid and agenda; morning ritual; focus mode with
  clock-projected times
- Areas with a split capacity ledger — personal time shrinks the day like a
  meeting does, but is never counted as work delivered
- Daily highlights, break prompts, backlog horizons, weekly objectives, shutdown
- ADHD surfaces: deadline runway, "Just start", AI breakdown, avoidance
  check-ins, estimation coach calibrated from your own logged time
- Accessibility modes applied server-side before first paint
- AI calendar agent: autonomy tiers, action validator, audit log, per-entry undo
- Adapters for Anthropic and every OpenAI-compatible provider (OpenAI,
  OpenRouter, CometAPI, Gemini, Groq, DeepSeek, Together, Mistral, Ollama,
  custom), configurable per user with their own key
- Subscription sign-in (Claude Pro/Max, ChatGPT) via the official `claude` and
  `codex` CLIs — installed in the Docker image itself, so this works the same
  way in the container as on a laptop, using each vendor's own headless login
- Project boards: custom columns with WIP limits, drag-and-drop and a keyboard
  "Move to…" dialog, labels, checklists, comments, activity history, 30-day
  trash with restore, and a search grammar shared by every filter box
  (`label:client due:week -status:done`). A card is the same task row Today
  and Week show — completing it anywhere moves it to Done
- On boards, too: file attachments with image previews, a sortable Table view
  (per board and across every board), saved views, five built-in board
  templates plus your own, and live updates — a change in one tab, from the
  API or from a calendar sync shows up in every other open tab
- A side calendar on every board (`C`): the week beside your columns, with
  each day's load, so dropping a card on Thursday plans it without leaving
  the board
- Work you add without an estimate still gets planned, using your default,
  and shows as `~30m` everywhere until you set a real number. It never skews
  the estimation coach
- Focus mode shows both clocks at once: time until your next break, and the
  total time on the task against its estimate
- Scheduling modes — Manual, Assisted, Hybrid, Automatic. Fluid replans as
  things change and, depending on the mode, asks or applies small changes with
  undo. It always asks before overtime, before moving work off the day you
  chose, or about a missed session you placed yourself
- "Why here?" on every session; "Schedule my day"; a resolve tray with one-tap
  fixes. Hard deadlines may move lower-ranked work aside, and can propose
  overtime — never apply it. Also: a daily work cap, preferred time of day,
  project importance, a 1–90 day horizon
- The engine is checked against the spec's worked examples exactly, and
  against 10,000 random inputs for every hard constraint. The database itself
  refuses two accepted sessions at once
- A REST API with personal access tokens (read only or read & write, with
  expiry and revocation) — see [docs/api.md](docs/api.md)
- Calendar sync with Google Calendar (OAuth, incremental sync tokens, push
  notifications, idempotent writes) and any CalDAV server, through one engine:
  meetings — recurring series included — become busy time; accepted blocks
  appear in your calendar; moving a block there pins it here; deleting it there
  removes the session. A background worker (BullMQ on the bundled Redis) runs
  syncs, a 10-minute safety poll and push-channel renewal
- Installable PWA (manifest, service worker, offline screen, home-screen
  shortcuts) and Web Push: session reminders plus plan/wrap-up prompts, with
  quiet hours, per-kind switches and per-device management

</details>

<details>
<summary><b>What does not</b></summary>

- **Google sync has not run against a live Google account.** It is tested
  against a scripted Google Calendar API (the full adapter contract plus
  Google's own edge cases) and an end-to-end run through the real database,
  and its error path has talked to Google's real endpoints — but no OAuth
  client was available to sign in for real. Expect small surprises on first
  contact (see docs/decisions/0002)
- Microsoft 365 / Outlook calendars (out of scope)
- Body doubling, Gantt view, task import
- Sharing a workspace with other people
- Uploading attachments through the API, and outgoing webhooks
- Booking links, an AI notetaker, and Slack/Teams delivery of the daily summary
  (it copies to the clipboard instead)
- AI settings toggles are enforced server-side but not yet editable in the UI

The Anthropic adapter typechecks against the current API but **has not been run
against the live API** — no key was configured, so only the deterministic path
has been exercised. Expect to shake out real request/response details on first
contact.

</details>

---

## Notes for maintainers

- **npm workspaces, not pnpm.** `corepack enable` needs admin rights on this
  machine.
- **No project references.** Packages export raw TypeScript and are consumed
  directly by Next's `transpilePackages` and Vitest; composite builds would
  demand `.d.ts` outputs nothing produces.
- **Sampling parameters are gone.** Current Anthropic models reject
  `temperature`, `top_p` and `top_k` with a 400. `PromptSpec.reasoning` maps to
  `output_config.effort` instead — do not reintroduce a `temperature` field to
  the neutral interface.
- **Don't disable thinking on Opus 5.** It can emit a tool call as plain text
  (the call silently never runs) and leak internal tags into output. Lower
  `effort` instead.
- **When adding a calendar provider, run `runAdapterContract` against it first.**
  It encodes the data-loss safeguards, and a provider that passes has inherited
  them.
- **If the test suite dies with `cannot allocate memory`**, look for an orphaned
  `next dev` process before suspecting the code — it grows to several GB over a
  long session and starves esbuild.
- **The CLI adapter never inherits `process.env`.** `childEnv()` in
  `packages/ai/src/adapters/cli.ts` is an allowlist, not a filter — anything
  the spawned `claude`/`codex` process should see has to be added to it by
  name. This exists because that process handles attacker-controllable
  calendar text; copying the parent environment would hand it `DATABASE_URL`,
  `ENCRYPTION_KEK` and every provider key. Adding a new env var to the app does
  not require touching this list, and that is deliberate — assume it should
  stay out unless you have a specific reason the CLI needs it.
- **Background jobs run in the web process** (`server/jobs/calendar-jobs.ts`,
  started from `instrumentation-node.ts`) on BullMQ over the compose file's
  Redis. BullMQ gives each job to one worker, so replicas are safe;
  `WORKER_DISABLED=1` keeps one lean. If Redis is down, a requested sync runs
  inline rather than being lost. `bullmq` and `ioredis` are in
  `serverExternalPackages` because BullMQ loads Lua scripts from its own files.
- **Recurring events are expanded when read, never when stored.** Every
  reader of meetings goes through `server/services/external-events.ts`, which
  expands series with `@fluid/core`'s `expandRecurrence` in the event's own
  time zone. Do not query the `events` table directly for busy time — a series
  stored as one row only covers its first occurrence.
- **Notifications are dispatched from the web process**, once a minute, started
  in `apps/web/src/instrumentation.ts`. There is no worker container to run.
  Several replicas are safe: each notification is claimed in
  `notification_deliveries` under a unique key before it is sent, so only one
  replica sends it. Set `NOTIFICATIONS_DISABLED=1` on the extra replicas to
  save them the work. The VAPID key pair is generated on first use and
  stored, envelope-encrypted, in `server_keys` — do not delete that row, or
  every device's subscription stops working.
- **Push endpoints are allowlisted** (`server/services/push-endpoint.ts`). A
  subscription is a URL the browser gives us and the server then POSTs to, so
  accepting any URL would be SSRF. Only the push services real browsers use
  (FCM, Mozilla, Windows, Apple) are accepted.
- **`public/offline.html` is plain HTML on purpose.** A Next.js page cached as
  the offline fallback tries to hydrate as whatever URL was requested, fails
  without its chunks, and shows "Application error".
