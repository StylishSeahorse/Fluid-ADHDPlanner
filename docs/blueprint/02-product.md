# Product: Feature Set, PRD, Journeys and Screens

Sections 8–12 of the blueprint. Everything in this file is a **recommendation [I]**
unless it cites a research finding (R-xx, see
[01-research.md §7](01-research.md#7-verified-feature-gaps-and-user-pain-points)) or
an existing Fluid file.

---

## 8. Recommended unified feature set

### The core concept, in three sentences

1. **All work lives on boards.** A card belongs to exactly one board and column, permanently, until it is moved or archived.
2. **A person commits cards to days.** That is a planning decision and the only thing that puts work "on" a day.
3. **The engine turns commitments and deadlines into calendar sessions.** It does this within rules the user sets, shows a diff, and never touches what it did not create.

```
             WHAT                    WHICH DAY                 WHEN
        ┌──────────────┐         ┌──────────────┐        ┌───────────────┐
        │  Project      │        │  Daily plan   │        │  Scheduled    │
        │  board        │──card──│  (plannedFor, │──task──│  sessions     │──mirror──▶ external
        │  column, pos. │  ref   │   dayOrder)   │  ref   │  (blocks)     │           calendar
        └──────────────┘         └──────────────┘        └───────────────┘
           owned by                 owned by                owned by
           the project              the person              the engine (unless pinned)
```

### Feature set by layer

| Layer | Included (MVP **bold**) | Notes |
|---|---|---|
| **Structure** | **Workspaces**, **projects**, **boards**, **custom columns**, **areas**, board templates, archive | One workspace per user is created at signup. Teams in P5 |
| **Cards** | **Title, markdown description, labels, checklist, attachments, comments, priority, estimate, actual, deadline (soft/hard), earliest start, owner, dependencies, subtasks**, custom fields, recurrence, cover colour | One `tasks` row (D1) |
| **Planning** | **My Day, morning ritual, capacity meter, Week board (days), backlog horizons, shutdown, rollover decisions, daily highlights**, weekly objectives and review | Existing Fluid flows, re-pointed at board cards |
| **Scheduling** | **Deterministic engine, manual timeboxing, pins, plan diff, resolve-issues tray, Manual and Assisted modes**, Automatic and Hybrid modes, overtime proposals, team scheduling | §13 |
| **Views** | **Board, My Day, Week, Calendar, Agenda, List/Table, Backlog, Search results**, saved views, timeline (read-only), workload, project dashboard | One query layer, many layouts |
| **Calendar** | **Google, CalDAV/Nextcloud**, Microsoft 365, iCloud | §14 |
| **Execution** | **Focus mode, timer, break prompts** | Both timers visible (R-17) |
| **Insight** | **Planned vs actual, completion, estimate calibration**, reports §10.R, team workload | No vanity metrics |
| **Automation** | Rules (Butler-style), recurring workflows, webhooks | P4 |
| **AI** | Existing: ordering hint, task breakdown, calendar agent. New: NL assistant, deadline-risk explanations, project breakdown | P5. Always validated |
| **Collaboration** | Invite as viewer or commenter (MVP-lite), roles, board ACL, assignment, mentions, notifications, activity feed | P5 for full teams |
| **Platform** | **Self-hosted Docker**, **activity log**, **undo**, REST API, webhooks, MCP, import | |

---

## 9. Features deliberately excluded

| Excluded | Seen in | Why [I] | Revisit when |
|---|---|---|---|
| Meeting notetaker / transcription | Motion [M16] | A separate product with heavy privacy and compliance load. It doesn't serve the board→day→calendar loop. Integrate via webhooks (an external notetaker POSTs action items) rather than build it | Strong demand plus a provider partnership |
| Booking links / scheduling pages | Motion [M15] | A Calendly-class product with its own abuse surface. Users already have one | Never in core. Possibly a plugin |
| "AI Employees" / autonomous agents doing email or lead gen | Motion [M17] | Outside the domain, and unverifiable outcomes. Conflicts with "AI proposes, engine decides" | — |
| Silent midnight rollover | Sunsama [S8] | Rollover is a decision. Silent rollover hides avoidance (Fluid's `rolloverCount` exists for this) | — |
| Hard deadlines that automatically schedule overtime | Motion [M1] | Violates working hours without consent (R-04) | Replaced by *proposals* |
| Sunsama-style channels | Sunsama [S4] | Redundant with labels, projects and areas (§6 redundancy table) | — |
| Multiple assignees who are all scheduled | Trello members | A shared card has no single calendar. One owner is scheduled; others collaborate (D8) | If "pair sessions" become a real need: P3 *co-scheduled sessions* |
| Map view | Trello [T8] | Niche | — |
| Gamification (streaks, points) | — | Rewards busywork. Streaks punish ADHD users for normal variance | — |
| Time-tracking billing / invoicing | — | Different product | Export CSV is enough |
| Native mobile apps in MVP | All | A responsive web app plus PWA covers MVP. Native costs two codebases | P3, after the API stabilises |

---

## 10. Product requirements document

### 10.1 Goals and non-goals

**Goals:**
- **G1** One place for all work, visually organised (boards).
- **G2** Realistic daily commitments (capacity before commitment).
- **G3** A calendar that stays truthful without manual upkeep (engine plus sync).
- **G4** Every automated change is explainable and reversible.
- **G5** Runs self-hosted with no AI and no external calendar, fully functional.

**Non-goals:** CRM, documents/wiki, chat, notetaking, booking pages, invoicing.

### 10.2 Personas

| Persona | Need | Default mode |
|---|---|---|
| **Solo planner (ADHD)** — the current Fluid user | External structure, no guilt loops, stable schedule | Assisted |
| **Freelancer / IC with several projects** | Boards per client, a realistic week, deadlines visible | Hybrid |
| **Small team lead (2–15)** | Shared boards, who's overloaded, dependencies across people | Assisted for self, read-only workload of others |
| **Self-hoster (Nextcloud user)** | Data ownership, CalDAV, no SaaS | Any |

### 10.3 Glossary (normative)

| Term | Definition | Stored as |
|---|---|---|
| **Card / task** | The same thing. "Card" in board UI, "task" in API and code | `tasks` row |
| **Column** | Workflow position on one board. Has an optional `status_category` | `board_columns` |
| **Status category** | `BACKLOG`, `TODO`, `IN_PROGRESS`, `DONE`. Drives scheduler eligibility and reports | enum on column |
| **Completed** | `tasks.completed_at IS NOT NULL`. Independent of column (D2, R-15) | timestamp |
| **Deadline** | When the work is *due* to someone. Soft or hard | `deadline`, `deadline_kind` |
| **Earliest start** | Do not schedule before this | `earliest_start` |
| **Day commitment** | "I will do this on day D." Set only by a human gesture | `planned_for`, `day_order` |
| **Session / block** | A specific time interval of work on a task | `scheduled_blocks` |
| **Pinned** | A session placed or moved by a human. The engine never moves it | `scheduled_blocks.is_pinned` |
| **Mirror event** | The external calendar event representing a session | `events` (origin `APP_BLOCK`) |
| **External event** | A meeting or appointment from a provider. Read-only to the engine | `events` (origin `EXTERNAL`) |
| **Plan** | One run of the engine, with its diff | `plan_versions`, `plan_changes` |
| **Owner** | The one person whose calendar the task is scheduled on | `tasks.owner_id` |

### 10.4 Functional requirements

Format: **ID — requirement** · *Priority* · *Phase* · *Traces to*. "Shall" is mandatory.

#### Structure and boards (REQ-BRD)

| ID | Requirement | Pri | Ph | Trace |
|---|---|---|---|---|
| REQ-BRD-01 | A user shall belong to ≥1 workspace. One personal workspace is created at signup | P0 | 1 | R-01 |
| REQ-BRD-02 | A workspace shall contain projects. A project shall contain ≥1 board. A board may also exist without a project ("loose board") | P0 | 1 | R-01 |
| REQ-BRD-03 | A board shall have ordered, user-defined columns, each with name, optional `status_category`, optional WIP limit, optional `auto_schedule` flag and optional `on_complete` behaviour (`STAY`, `MOVE_TO:<column>`) | P0 | 1 | R-01, R-15 |
| REQ-BRD-04 | New boards shall default to columns *Backlog (BACKLOG) · To do (TODO) · Doing (IN_PROGRESS) · Done (DONE, on_complete target)* | P0 | 1 | [I] |
| REQ-BRD-05 | Cards shall be reorderable within and across columns and boards by drag-and-drop **and** by an accessible "Move to…" dialog | P0 | 1 | F1 |
| REQ-BRD-06 | Moving a card between boards shall preserve its identity (id, comments, activity, sessions, day commitment). If the target board belongs to another project, `project_id` updates. Area does *not* change unless the user chooses (F2 §9) | P0 | 1 | D1 |
| REQ-BRD-07 | Columns, boards and projects shall be archivable and restorable. Deleting is soft, with a 30-day recovery tab | P0 | 1 | D2, D3 |
| REQ-BRD-08 | Board templates: save a board (columns, labels, optional cards with relative dates) and instantiate it | P1 | 4 | M10, D3 |
| REQ-BRD-09 | A column with a WIP limit shall show over-limit state and shall not block the move (warn, don't prevent) | P2 | 4 | [I] |

#### Cards (REQ-TASK)

| ID | Requirement | Pri | Ph | Trace |
|---|---|---|---|---|
| REQ-TASK-01 | A card shall have: title (≤255), markdown description, priority, estimate (minutes, nullable), deadline + kind, earliest start, owner, area, labels, checklist(s), attachments, comments, parent, dependencies | P0 | 1 | §6 rows 4–21 |
| REQ-TASK-DONE | Completing a card shall set `completed_at`, regardless of column. If the column's board defines an `on_complete` target, the card moves there. Moving a card into a DONE-category column shall complete it. Moving it out shall un-complete it (with a confirmation if it has logged sessions) | P0 | 1 | R-15 |
| REQ-TASK-DATES | Deadline, day commitment and sessions are independent. Changing one shall never silently change another. Scheduling a session shall never alter the deadline | P0 | 1 | R-14, D3 |
| REQ-TASK-EST | A card with no estimate shall be schedulable using a **default estimate** (user setting, default 30 min, matching the current `estimateMinutes @default(30)`). It is flagged "estimate assumed" in every view and in the diff | P0 | 2 | [I] |
| REQ-TASK-CHK | Checklist items shall be promotable to subtasks (preserving text and assignee) | P1 | 1 | [I] |
| REQ-TASK-DEP | Dependencies shall reject cycles at write time with a message naming the cycle | P0 | 1 | F4 (`DEPENDENCY_CYCLE`) |
| REQ-TASK-ACT | Every change to a card shall append an activity event (actor, verb, field diff, source: user / engine / automation / AI / sync) | P0 | 1 | D2 |
| REQ-TASK-UNDO | The last change made by the current user in any view shall be undoable via toast and `Ctrl/Cmd+Z` for 30 s. Older changes can be reverted from activity, per entry | P0 | 1 | F2 §6 |
| REQ-REC-01 | A card may carry a recurrence (RFC 5545 RRULE subset: DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, BYDAY, BYMONTHDAY, COUNT/UNTIL) authored in the user's time zone | P1 | 4 | M21 |
| REQ-REC-NODUP | A recurring series shall materialise **only the next instance** as a real row. Completing or skipping it materialises the following one. Rollover moves an instance and never copies it. Unfinished checklist items stay on the instance | P1 | 4 | R-09 |
| REQ-REC-NONWORK | An instance whose date falls on a non-working day shall follow the series' `on_non_working_day` policy: `SKIP`, `PREVIOUS_WORKING_DAY` (default) or `NEXT_WORKING_DAY` | P1 | 4 | [I] |

#### Daily planning (REQ-DAY)

| ID | Requirement | Pri | Ph | Trace |
|---|---|---|---|---|
| REQ-DAY-01 | Any card in any view shall offer "Plan for… (Today / Tomorrow / pick day)". This sets `planned_for` and appends to that day's order | P0 | 2 | S1 |
| REQ-DAY-02 | The morning ritual shall present, in order: (1) yesterday's unfinished commitments (each needs a decision: today / another day / backlog / drop), (2) today's calendar commitments, (3) cards due within N days (default 3), (4) cards in `auto_schedule` columns, (5) everything else via search. Capacity is shown live throughout | P0 | 2 | S1, F1 |
| REQ-DAY-03 | The capacity meter shall show *available* minutes (working hours − busy − protected − personal-area time − buffers) and *committed* minutes, and shall warn at 100% without preventing commitment | P0 | 2 | S1, F2 §9 |
| REQ-DAY-04 | Daily objectives (1–3 short lines) and a planning note shall be optional fields on the day | P1 | 2 | [I] |
| REQ-DAY-05 | Shutdown shall show completed work grouped by project and area, frozen at shutdown (existing `DayLog`), plus each unfinished commitment as a decision | P1 | 2 | S6, F3 |
| REQ-DAY-06 | If the user does not run shutdown, unfinished commitments shall be shown next morning as "carried, undecided". They are **not** auto-moved, and `rollover_count` is incremented only when a decision is made | P0 | 2 | §6 table |
| REQ-DAY-07 | Every ritual shall be skippable and individually disableable in settings | P0 | 2 | Brief |
| REQ-DAY-08 | Weekly planning: choose up to 5 objectives, see deadline load per day, and drag cards onto days. Weekly review: objectives progress, planned vs actual, reflection (Sunsama's 3-step shape) | P1 | 4 | S5 |

#### Scheduling (REQ-SCH) — full design in [03-scheduler.md](03-scheduler.md)

| ID | Requirement | Pri | Ph | Trace |
|---|---|---|---|---|
| REQ-SCH-DET | Given identical inputs (including `now`), the engine shall produce identical output | P0 | 3 | F4 |
| REQ-SCH-ELIG | Eligible tasks: not completed, not archived or deleted, owner = scheduled user, has estimate or default, not in a BACKLOG column unless committed to a day, all prerequisites completed or scheduled earlier, `auto_schedule` resolved true (task → column → user default) | P0 | 3 | M9 |
| REQ-SCH-HARD | Hard constraints, never violated automatically: no overlap with busy external events, protected time or pinned sessions; inside working hours; not before earliest start or prerequisites | P0 | 3 | R-04 |
| REQ-SCH-LOCK | Pinned sessions shall never be moved or deleted by the engine. A pinned session that ends unfinished generates a *recovery proposal*, never a move | P0 | 3 | R-03 |
| REQ-SCH-STAB | A replan shall keep every existing session that is still valid, unless the user asked for a full replan. The churn per replan is capped (`maxDailyReshuffles`) | P0 | 3 | R-02, F2 §3 |
| REQ-SCH-DIFF | Every replan shall produce a plan version with per-change plain-language reasons. In Assisted mode nothing reaches the calendar until accepted | P0 | 3 | R-02 |
| REQ-SCH-EXPLAIN | Every session shall have a retrievable "why here?" explanation listing the binding constraints and the ranking factors | P0 | 3 | R-18 |
| REQ-SCH-HORIZON | The default horizon shall be 14 days and configurable up to 90. Tasks with deadlines beyond the horizon are reported as "beyond horizon", not as failures | P1 | 3 | R-05 |
| REQ-SCH-DAY | "Schedule my day" shall place all of today's commitments in one action | P0 | 3 | R-07 |
| REQ-SCH-ACTUAL | When a running session overruns, remaining sessions of the day shall be re-projected from the clock (existing `flow.ts`), and the overrun feeds estimate calibration | P1 | 3 | R-08 |
| REQ-SCH-OVERTIME | When a hard deadline cannot be met within working hours, the engine shall emit an *overtime proposal* (specific out-of-hours slots) requiring explicit approval | P1 | 3 | R-04 |
| REQ-SCH-MODES | Users choose Manual, Assisted (default), Automatic or Hybrid (§13.C) | P0/P2 | 3 | D6 |

#### Calendar (REQ-CAL) — design in [04-sync-ai-collaboration.md §14](04-sync-ai-collaboration.md#14-calendar-integration-and-synchronisation)

| ID | Requirement | Pri | Ph | Trace |
|---|---|---|---|---|
| REQ-CAL-GOOGLE | Two-way sync with Google Calendar: read selected calendars, write sessions to one write-target calendar | P0 | 2 | §6 row 35 |
| REQ-CAL-CALDAV | Two-way CalDAV, including Nextcloud (existing adapter) | P0 | 2 | R-10 |
| REQ-CAL-MS | Microsoft 365 via Graph | P1 | 2/4 | §6 row 36 |
| REQ-CAL-ICLOUD | iCloud via CalDAV with an app-specific password | P2 | 4 | C7, C8 |
| REQ-CAL-ALLDAY | All-day external events default to **free** unless marked busy by the provider *and* the user opts the calendar into "all-day events block time" | P0 | 2 | R-06 |
| REQ-CAL-OWN | The engine shall never create, update or delete an `EXTERNAL` event (existing triple enforcement) | P0 | — | F2 §2 |
| REQ-CAL-NC | Optionally expose each board's dated cards as a read-only ICS feed (deadlines as all-day VTODO/VEVENT), matching Deck's Nextcloud integration | P3 | later | R-11 |

#### Views (REQ-VIEW)

| ID | Requirement | Pri | Ph |
|---|---|---|---|
| REQ-VIEW-01 | Board, My Day, Week (day columns), Calendar (day/week), Agenda, List/Table, Backlog and Search shall render from one task query API, with view-local filter, group and sort state | P0 | 1–2 |
| REQ-VIEW-02 | Filters shall use one grammar everywhere (§12.6) | P0 | 1 |
| REQ-VIEW-03 | Saved views (named query + layout + grouping), personal or shared | P1 | 4 |
| REQ-VIEW-04 | Timeline (read-only Gantt: sessions, deadlines, dependencies) | P2 | 4 |
| REQ-VIEW-05 | Workload view: per person per day, available vs scheduled vs committed | P2 | 5 |
| REQ-VIEW-06 | Project dashboard: progress by status category, overdue, at-risk, blocked, upcoming milestones | P1 | 4 |

#### Focus (REQ-FOCUS)

| ID | Requirement | Pri | Ph | Trace |
|---|---|---|---|---|
| REQ-FOCUS-01 | Focus mode shows one card, its checklist, a running timer and the next commitment | P1 | 2 | S17 |
| REQ-FOCUS-TIMERS | Pomodoro interval and total task time shall be visible at the same time | P1 | 2 | R-17 |
| REQ-FOCUS-02 | Breaks stop the task timer (existing behaviour) | P1 | — | F3 |

#### Reports (REQ-RPT) — §10.R

#### Collaboration, automation and AI — REQ-COL, REQ-AUTO, REQ-AI in [04-sync-ai-collaboration.md](04-sync-ai-collaboration.md)

#### API — REQ-API in [05-data-and-architecture.md §19](05-data-and-architecture.md#19-api-endpoint-and-event-specification)

### 10.5 Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| REQ-NFR-PERF-1 | Board with 500 cards renders interactive | < 1.5 s p95 on a mid-range laptop. Virtualised columns |
| REQ-NFR-PERF-2 | Card move round trip (optimistic UI → server ack) | < 300 ms p95 server time |
| REQ-NFR-PERF-3 | Engine run: 300 tasks, 14-day horizon, 200 busy events | < 500 ms p95 (pure function) |
| REQ-NFR-PERF-4 | Workspace scale | 50k tasks, 200 members, without N+1 file queries (R-12) |
| REQ-NFR-AVAIL | Managed hosting | 99.9% monthly. Self-host has no SLA |
| REQ-NFR-DUR | RPO / RTO (managed) | RPO ≤ 5 min (WAL archiving), RTO ≤ 1 h |
| REQ-NFR-A11Y | Accessibility | WCAG 2.2 AA. Every drag has a keyboard and menu equivalent |
| REQ-NFR-I18N | Time zones | All instants stored in UTC with an IANA zone. DST-correct recurrence |
| REQ-NFR-PRIV | AI off | Every feature except the AI ones works with `AI_DISABLED=1` |

### 10.R Reporting and analytics

**Principles:**
1. Report *outcomes and calibration*, not activity volume.
2. Never rank people against each other.
3. Every number has a tooltip explaining exactly how it was computed and what was excluded.

| Report | Definition | Data source | Missing-data rule | Anti-busywork guard |
|---|---|---|---|---|
| **Completion (day/week)** | Cards completed whose `planned_for` was in the period ÷ cards committed to the period. Shown as "x of y commitments", not a percentage score | `tasks`, `day_logs` (frozen) | Commitments changed after shutdown use the frozen `DayLog` snapshot | Unplanned completions are shown separately ("also done"), not as a bonus |
| **Planned vs actual time** | Σ session minutes planned vs Σ timer minutes, per day, project and area | `scheduled_blocks`, timer sessions | Sessions without timer data are counted as *untracked*, not as zero or planned | Show the untracked share. Never infer actuals |
| **Estimate accuracy** | Median and IQR of actual ÷ estimate for completed tasks with ≥80% tracked time, by category | `time_estimate_samples` | Tasks under the tracked threshold are excluded and their count shown | Show the bias direction ("you underestimate writing ×1.6"), not a grade |
| **Estimate changes** | Original vs final estimate is kept. Accuracy uses the estimate **at commitment time** | `activity_events` (field history) | If no history, use the current value and mark it | Avoids "fixing" accuracy by editing estimates afterwards |
| **Workload by day/week** | Available, scheduled and committed-unscheduled minutes | engine snapshot per day | Days without a plan run are computed on demand | Over-100% days are highlighted as risk, never as "productive" |
| **Overdue** | Not completed and `deadline < now` | `tasks` | — | Grouped by "how late" and "rescheduled n times" |
| **Deadline risk** | Engine's latest plan: last session end > deadline, or unscheduled with a deadline in the horizon | `plan_versions` | Requires a plan within 24 h, else "stale" | — |
| **Project progress** | Done ÷ total *estimated minutes* (count shown as secondary). Cards without an estimate use the default and are flagged | `tasks` | — | Minutes-weighted so splitting cards doesn't inflate progress |
| **WIP / blocked** | Counts per column / with incomplete prerequisites; age in column | `tasks`, `activity_events` | — | — |
| **Calendar utilisation** | Meeting minutes ÷ working minutes; focus-session minutes ÷ working minutes | `events`, `scheduled_blocks` | Unselected calendars excluded | No "target" utilisation shown |
| **Focus time** | Minutes in focus mode with a running timer | timer sessions | — | — |
| **Recurring work share** | Minutes on recurring instances ÷ total | `tasks.series_id` | — | — |
| **Scheduling accuracy** | Share of sessions that ran within ±15 min of plan (timer start) | blocks + timer | Untracked sessions excluded | — |
| **Rescheduling frequency** | Engine moves per task per week; user rollovers per task | `plan_changes`, `rollover_count` | — | Tasks moved ≥3 times surface an avoidance check-in (existing), never a red badge |
| **Team capacity** (P5) | Per member: available vs scheduled minutes per day | engine per member | Members without a calendar shown as "unknown availability" | Visible to managers only as aggregate unless the member shares detail |

---

## 11. User journeys

### J1 — First run (solo)

1. Sign up. A personal workspace, an "Inbox" board and default working hours (Mon–Fri 09:00–17:00 in the browser's zone) are created.
2. The onboarding checklist offers 3 *optional* steps: connect a calendar (Google / CalDAV / skip), create a project board from a template (Personal, Client project, Content pipeline), and set working hours.
3. Brain-dump capture: paste a list, which becomes cards in the Inbox board's Backlog column (existing braindump parser).
4. Prompt: "Plan today?" opens the morning ritual. If skipped, the user lands on Home.

**Acceptance:** a user can reach a scheduled day in under 3 minutes without connecting anything.

### J2 — Morning planning with boards

1. 08:55: Home shows "Plan your day" (or it auto-opens if enabled).
2. Step 1, **Yesterday**: 2 unfinished commitments. User chooses Today for one and Backlog for the other. `rollover_count` increments on the first.
3. Step 2, **Calendar**: 3 h of meetings today. Capacity: 7 h − 3 h − buffers ≈ 3 h 20 m available.
4. Step 3, **Due soon**: 4 cards from 3 boards are due within 3 days. User commits 2. Meter: 2 h 30 m of 3 h 20 m.
5. Step 4, **Ready columns**: cards in `auto_schedule` columns across boards. User adds one 1 h card. Meter: 3 h 30 m of 3 h 20 m, amber, "≈10 min over".
6. User removes a 15-minute card and drops it on Thursday.
7. **Schedule my day**: the engine proposes sessions around meetings, and the diff shows 4 added blocks. User accepts. Sessions are written to Google (Assisted mode).
8. The day starts in My Day: list on the left, timeline on the right.

### J3 — Board work, then scheduling from the board

1. On the "Website redesign" board the user creates "Draft homepage copy", 2 h, deadline Fri (soft), in To do.
2. Drags it to **Ready** (column flagged `auto_schedule`).
3. Assisted mode: a toast says "Ready to schedule: 2 h before Fri. Proposed: Wed 10:00–11:00, Thu 14:00–15:00. [Review] [Accept]".
4. The card shows a calendar chip, "Wed 10:00 +1". The card stays in Ready. Its board position is unchanged.
5. The user drags the Wed chip to Tue 15:00 on the side calendar. That session becomes pinned, and the Thu session stays.

### J4 — Interruption and recovery

1. Tue 11:00: an urgent client email arrives. User captures "Fix checkout bug", URGENT, 90 min, due today 17:00.
2. Hybrid mode: fitting 90 contiguous minutes today requires moving one flexible session (urgent preemption, [§13.B.8](03-scheduler.md#b8-a-new-urgent-task-change-preemption)). The disruption score is below the threshold, so it auto-applies, with undo and a notification: "Moved 'Write blog draft' to Wed 09:00 to fit Fix checkout bug (due 17:00 today)."
3. The user taps Undo on the blog move. The blog returns to 11:00, now pinned, because undo is a decision. The bug no longer fits before 17:00, so the resolve tray offers an overtime proposal and alternatives. This is worked through in [§13.G Example 4](03-scheduler.md#example-4--urgent-interruption-tuesday-1100).

### J5 — Overrun

1. A focus session on "Quarterly report" is planned 10:00–11:00. At 11:00 the timer is still running.
2. Flow mode re-projects later sessions from the clock (existing `flow.ts`). The UI says "Running 15 min over. Next: Standup 11:30 (fixed)".
3. At stop (11:25), the remaining estimate is asked: "Done / Need ≈30 min more / Need ≈1 h more". The user chooses 30 min, and the engine places a new session (Assisted: proposal).

### J6 — Shutdown

1. 17:05: shutdown prompt (time chosen in the morning).
2. Shows done (grouped by project and area), time planned vs tracked, and 2 unfinished commitments needing a decision each.
3. Optional reflection line. Frozen into `DayLog`.

### J7 — Team handover (P5)

1. A lead reassigns "Write API docs" from Ana to Ben.
2. Ana's future unpinned sessions for it are removed. Pinned ones are kept and flagged "card reassigned — keep, release?" to Ana. `planned_for` is cleared, because a day commitment belongs to the person who made it.
3. Ben gets a notification. If Ben's mode is Automatic, the engine schedules it against Ben's availability. Otherwise it appears in his "New to you" tray.

### J8 — External calendar edit

1. The user drags a Fluid session in Google Calendar from 10:00 to 13:00.
2. Push notification → incremental sync → the app sees its own `APP_BLOCK` moved. It accepts the time and pins the session (existing `ACCEPTED_AS_INTENT`).
3. If 13:00 now overlaps a meeting, the session is kept as the user placed it, and the conflict badge reads "Overlaps Design review (13:00–13:30)".

### J9 — Offline mobile edit

1. On a train, the user ticks a checklist item and completes a card on their phone.
2. Ops are queued locally with client timestamps and base versions.
3. On reconnect, per-field merge (§12.8). Completion wins over a concurrent column move by someone else, and both are logged.

---

## 12. Information architecture and screen specifications

### 12.1 Navigation

**First-class (sidebar)**, in order:

| Item | Purpose | Notes |
|---|---|---|
| **Home** | Today at a glance: next commitment, capacity, resolve-issues tray, at-risk deadlines, rituals due | Replaces a dashboard of widgets. Answers "what now?" |
| **My Day** | The day as list + timeline (existing Today) | Default landing after planning |
| **Calendar** | Day/week grid, with an unscheduled-card side panel | Existing `/calendar` + panel |
| **Boards** | Board switcher + the active board | Favourites pinned. Grouped by project |
| **Projects** | Project list with progress, deadlines, dashboard | Project → boards |
| **Tasks** | Cross-board List/Table with saved views; includes Backlog as a saved view (`status:backlog`), Inbox as a saved view (`board:inbox`) | |
| **Review** | Reports, weekly review, objectives, AI activity | Existing `/review` + `/activity` |

**Secondary / contextual:**

| Item | Where it lives | Why not first-class |
|---|---|---|
| Inbox / Quick capture | Global `Q` shortcut and a "+" button on every screen; Inbox is a board | Capture must be reachable anywhere, so a page is the wrong unit |
| Week | A tab on My Day ("Day · Week") and on Calendar | Planning lens, not a destination |
| Goals / objectives | Review, plus a strip on Week | Weekly cadence |
| Backlog / Someday | Saved view in Tasks; panel in planning | It's a filter |
| Focus mode | Full-screen flow entered from any card or session | Existing `/focus` |
| Morning planning / shutdown | Full-screen flows entered from Home and My Day | Existing `/plan-day` |
| Integrations | Settings → Calendars, API & webhooks, AI | |
| Settings | Avatar menu | |
| Command palette | `Ctrl/Cmd+K` everywhere | |

### 12.2 Entity relationships (conceptual)

```
Workspace 1─* Project 1─* Board 1─* Column 1─* Task(card)
Workspace 1─* Area                    Task *─1 Area
Workspace 1─* Label *─* Task          Task 1─* Checklist 1─* ChecklistItem
Task 1─* Task (subtasks)              Task *─* Task (dependencies)
Task 1─* ScheduledBlock(session) 0..1─1 Event(APP_BLOCK mirror)
User 1─* DayLog (daily plan state)    Task.planned_for → a day in the owner's plan
Objective(week) 1─* Task              Calendar 1─* Event(EXTERNAL, read-only)
PlanVersion 1─* PlanChange, 1─* ScheduledBlock
```

One task record. The board knows its column and position, the day plan knows its
`planned_for` and order, the calendar knows its sessions. None of them copies title,
estimate or deadline.

### 12.3 One query layer, many views

All views call `tasks.query({ filter, groupBy, sort, include })`. A view is
**layout + default query + local UI state**:

| View | Default query | Group by | Sort | Layout | MVP |
|---|---|---|---|---|---|
| Board | `board:<id> archived:false` | column | position | columns | ✅ |
| My Day | `planned:today owner:me` | — | day_order | list + timeline | ✅ |
| Week | `planned:this-week owner:me` | planned_for | day_order | day columns | ✅ |
| Calendar | sessions in range, plus external events | day | start | grid | ✅ |
| Agenda | sessions + events + deadlines in range | day | start | list | ✅ |
| List / Table | any | any field | any | rows, inline edit | ✅ |
| Backlog | `status:backlog` or `planned:none completed:false` | time bucket | priority, created | list | ✅ |
| Timeline | `project:<id>` with sessions/deadlines | board or owner | start | Gantt | P2 |
| Project dashboard | `project:<id>` | status category | — | cards + charts | P1 |
| Workload | `workspace:<id>` members | owner × day | — | heatmap | P2 |

**Rules:**
- View state (filters, collapsed groups, zoom) is stored per user per view in `saved_views` or local storage. It never writes to tasks.
- *Drag semantics depend on the axis the view groups by*:
  - grouped by column → changes `column_id`
  - grouped by day → changes `planned_for`
  - grouped by owner → changes `owner_id`
  - grouped by label → adds or removes that label
  - Calendar → creates or moves a session
  - Dropping on an axis that is not editable (for example a computed group like "Overdue") is disabled.

### 12.4 Key screens

#### Board

- **Header:** board name, project breadcrumb, filter bar (grammar input + chips), view switch (Board · Table · Timeline), members, "Schedule ready" button (if any column is `auto_schedule`), ⋯ (templates, archive, settings).
- **Columns:** name, card count, WIP indicator, Σ estimate, ⋯ (rename, status category, auto-schedule toggle, on-complete rule, archive). Columns are virtualised beyond 50 cards.
- **Card face:** title, labels (colour bars), owner avatar, priority marker (URGENT/HIGH only, to avoid noise), estimate, deadline chip (red only if overdue, amber within 1 day), checklist progress `3/5`, comment count, dependency icon (blocked = lock icon + "waiting on 1"), **schedule chip** (`Wed 10:00 +1`, or `→ Fri` when spilled, or `⚠ can't fit`), **day chip** if committed (`Today`).
- **Quick add:** at the bottom of each column. Tokens: `#label`, `@owner`, `!high`, `~45m`, `^fri` (deadline), `>today` (plan for).
- **Side calendar panel** (toggle `C`): the current week, droppable. Lets a user timebox from the board without leaving it.

#### Card detail panel

Right-side panel, ~480 px (full screen on mobile). Deep-linkable `/c/<shortId>`.

1. Title (inline edit), board › column breadcrumb (click to move), complete toggle.
2. **Plan strip:** Deadline [soft/hard], Earliest start, Estimate (shows the coach's adjusted estimate beside it when available), Planned for [day], Auto-schedule [inherit/on/off].
3. **Sessions:** list of scheduled sessions with state (proposed/accepted/pinned/done/skipped), actual minutes. "Add session" (manual pick). Each session has "Why here?", which expands the explanation.
4. Description (markdown, with attachments inline).
5. Checklist(s): item → "Make subtask".
6. Subtasks, dependencies ("Blocked by", "Blocks"), links to other cards.
7. Labels, area, owner, collaborators, custom fields.
8. Tabs: Comments · Activity (all sources, filterable: me / engine / automation / AI / sync).

#### My Day

Two panes on desktop (≥1024 px), tabs on mobile.
- **Left list:** ordered commitments (drag to reorder = `day_order`), each with an estimate and a session time or "unscheduled". Then "Also today" (calendar events). Then "Done today".
- **Right timeline:** day grid with external events (read-only, neutral colour), sessions (project colour; pinned sessions show a pin), protected time (hatched), working-hours shading, a now line.
- **Top bar:** capacity meter, "Schedule my day", "Plan" / "Shut down" buttons, mode indicator (Assisted ▾).

#### Calendar

Week grid (day on mobile). Left panel: **Unscheduled** — committed cards without sessions (top), then cards in `auto_schedule` columns, then search. Drag into the grid creates a pinned session. A proposed-plan overlay shows ghost blocks with Accept / Reject.

#### Home

- Next up (current or next session, with Start focus).
- Capacity today.
- **Resolve issues** tray:
  - can't fit (reason + actions: extend hours / lower priority / split / move deadline / defer)
  - spilled commitments
  - deadline at risk
  - sync problems
  - pending proposals
- Rituals due. Recent activity from others (P5).

### 12.5 Behaviour specifications

| Situation | System behaviour |
|---|---|
| **Drag card to a different column** | Optimistic move. `PATCH task {column_id, position}` with `If-Match: <version>`. Status category effects: → DONE completes (REQ-TASK-DONE), DONE → other un-completes (confirm if sessions logged), → BACKLOG removes future *unpinned proposed/accepted* sessions in Assisted/Auto modes (pinned ones kept, with a prompt), → an `auto_schedule` column triggers a scheduling evaluation for the owner. Activity is logged. Undo toast. Other viewers get a realtime update |
| **Drag card to a date (Week, or the date header in Calendar)** | Sets `planned_for` = that local day, appended to its order. Board position unchanged. Engine re-evaluates that day in the current mode. If the day is over capacity, the drop still succeeds and the meter turns amber |
| **Drag card to a time slot** | Creates a `scheduled_block` (pinned, duration = min(remaining estimate, slot until next busy) or the user-resized length), and sets `planned_for` to that day if empty. The mirror event goes to the outbox. If the slot overlaps a busy event, a confirmation appears ("Overlaps X — place anyway?"). If confirmed, it is pinned with an overlap flag |
| **Deadline changes** | Activity is logged. If the task has sessions or the user is in a non-Manual mode, a replan is triggered for that owner (debounced 5 s). If an existing session now falls after a *hard* deadline, it is reported as at risk. If the deadline moves earlier and capacity can't absorb it, the card shows "can't fit before <deadline>" in the resolve tray |
| **Scheduler proposes a different time** | Assisted: ghost blocks + diff panel ("Moved because…") with Accept all / per-line Accept/Reject / auto-accept countdown (existing `autoAcceptSeconds`). Rejecting a move pins the original session for that task (the user's rejection is a decision) |
| **External event conflicts with a task session** | Sync detects a new busy event overlapping an *unpinned* session → replan for that owner (moves the session; diff reason "A meeting was added: Design review"). Overlapping a *pinned* session → no move, conflict badge plus a resolve-tray item with actions (keep both / move my session / skip session) |
| **Task completed** | `completed_at` set. Future sessions: unpinned ones deleted (mirrors deleted via outbox), pinned future ones become "released" (deleted, with a notice in the undo toast). Current running session truncated at now, with actual minutes recorded. Freed time triggers a pull-forward replan (Sunsama's early-finish behaviour, S3) in Assisted/Auto modes. Dependants are evaluated, and newly unblocked ones become eligible. If the board has `on_complete: MOVE_TO`, the card moves. Recurring: next instance materialised |
| **Project archived** | Boards become read-only. All cards are excluded from scheduling. Future unpinned sessions are deleted, and pinned future sessions are listed for a per-session decision in one dialog. Day commitments are kept but shown greyed out "(archived project)". Restoring reverses visibility. Sessions are not recreated automatically; a replan proposes them |
| **Task moved to another project** | Same row. `project_id`, `board_id` and `column_id` change. Labels not available in the target workspace are dropped, with a confirmation listing them. Area unchanged. Sessions and day commitment unchanged. Activity is recorded on both project feeds. Across workspaces: allowed only if the user is a member of both. Owner must be a member of the target, else ownership is cleared with a warning |
| **Mobile user edits offline** | §12.8 |

### 12.6 Search and filter grammar

Deck's operators [D2], extended. Case-insensitive. Space = AND, `OR` explicit, `-` negates, quotes for phrases.

| Operator | Values | Example |
|---|---|---|
| free text | title + description (FTS) | `homepage copy` |
| `board:` `project:` `column:` `label:`/`tag:` | name or id | `label:client-a` |
| `owner:` / `assigned:` | `me`, name, `none` | `owner:me` |
| `status:` | `backlog todo doing done` (category) | `-status:done` |
| `due:` / `date:` | `overdue today tomorrow week month none`, `<`, `>`, `<=`, `>=` ISO date | `due:<2026-11-07` |
| `planned:` | `today tomorrow week none <date>` | `planned:none` |
| `scheduled:` | `yes no today` | `scheduled:no` |
| `priority:` | `low medium high urgent` | `priority:>=high` |
| `blocked:` | `yes no` | `blocked:yes` |
| `estimate:` | `none`, comparisons in minutes or `1h` | `estimate:>2h` |
| `is:` | `archived recurring pinned spilled atrisk` | `is:atrisk` |

### 12.7 States, empty states and errors

| State | Rule |
|---|---|
| Loading | Skeletons shaped like the final layout. Never a spinner over a blank board. Card moves are optimistic |
| Empty board | Three example columns plus "Add your first card" plus "Use a template" |
| Empty My Day | "Nothing planned for today", with [Plan today] and [Show cards due soon] |
| No calendar connected | Calendar shows working hours only, with a banner "Connect a calendar so meetings shrink your day" |
| Sync error | Banner on Calendar and Home: what failed, since when, what still works ("Your blocks are saved in Fluid; they'll sync when Google is reachable"), and [Reconnect]. Never a silent failure (existing `statusDetail`) |
| Version conflict (412) | Field-level merge if non-overlapping. Otherwise a side-by-side "Your change / Their change" with keep-mine / keep-theirs |
| Engine can't fit | Resolve tray items with concrete actions. Never a generic error |
| AI unavailable | AI controls disabled, with the reason. Deterministic paths unaffected |

**Keyboard map (MVP):**

| Key | Action | Key | Action |
|---|---|---|---|
| `Q` | quick capture | `Ctrl/Cmd+K` | command palette |
| `/` | focus filter | `E` | edit card |
| `M` | move to… | `T` | plan for today |
| `D` | plan for… (date picker) | `X` | schedule this card (Sunsama's shortcut) |
| `P` | pin / unpin session | `Space` | complete |
| `F` | focus mode | `Ctrl/Cmd+Z` | undo |
| `J` / `K` | next / previous card | `H` / `L` | previous / next column |

### 12.8 Offline and concurrent editing

- **Server:** every mutable row carries an integer `version`. Mutations send `If-Match: <version>`.
- **Merge granularity is the field.** The server applies a mutation if the touched fields haven't changed since `base_version` (per-field version map in `activity_events`). Otherwise it returns 409 with both values.
- **Text fields** (title, description): last-writer-wins *per field*, with the losing text preserved in activity and recoverable. Real-time collaborative text editing (CRDT) is P3.
- **Ordering** uses fractional positions (lexorank-style strings), so concurrent inserts never renumber siblings.
- **Offline (P2):** client op queue (IndexedDB) of semantic ops (`complete`, `move`, `setField`, `checkItem`), replayed in order on reconnect. Completion and checklist ticks are commutative. Moves conflict only if the target column is gone, in which case the card stays put and a notice appears.

### 12.9 Responsive behaviour

| Width | Board | My Day | Calendar | Card detail |
|---|---|---|---|---|
| ≥1280 | Columns + optional side calendar | List + timeline | Week + unscheduled panel | Right panel |
| 768–1279 | Columns, horizontal scroll | List + timeline stacked or tabbed | Week, panel as drawer | Right panel overlay |
| <768 | One column at a time, swipe between columns, column picker | Tabs: List · Timeline | Day view, 3-day optional | Full screen |

Touch: long-press to drag (250 ms), with haptics where available. "Move to…" is always one tap away on the card menu.

### 12.10 Onboarding

1. Account → personal workspace + Inbox board + default hours (editable inline).
2. Optional calendar connect. Explain read vs write: "We read your selected calendars to find free time, and write only Fluid blocks to one calendar you choose."
3. Optional template board.
4. Mode choice: "How much should Fluid move things for you?" → Manual / Ask me first (default) / Handle routine changes / Fully automatic, each with one-line consequences.
5. First planning ritual (skippable). A tooltip tour only on first visit to each screen, and dismissible for good.
