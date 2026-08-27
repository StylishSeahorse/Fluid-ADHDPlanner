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

## The five screens

| Screen | The question it answers | What is on it |
|---|---|---|
| **Today** | What am I doing now? | The day as a list beside the day as a timeline, plus the rituals that bracket it |
| **Week** | Which day does this belong to? | Board, Calendar and Agenda are *lenses* on one page — same seven days, three readings |
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
npm run verify   # lint + typecheck + 341 tests
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
full-screen flows and the AI calendar agent work end to end. 341 tests.

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

</details>

<details>
<summary><b>What does not</b></summary>

- **Google Calendar HTTP calls.** The interface, contract suite, outbox table,
  circuit-breaker fields and conflict model are in place; the OAuth flow and the
  actual API requests are not. Blocks stay inside Fluid for now.
- Microsoft Graph adapter
- BullMQ worker — no background sync or nudge delivery yet
- Nudges/notifications, body doubling, Gantt view, task import
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
