# Research: Product Inventories, Comparison and Gaps

Sections 3–7 of the blueprint. Source IDs (S…, M…, T…, D…, C…, F…) and the
evidence/status legend are defined in [README.md §2](README.md#2-research-methodology-and-source-register).

Every row in this file is a **research finding**: what the product does, as far as
the evidence shows. Recommendations are kept out of it, except in the
"Retain / improve / replace" columns, which are explicitly labelled **[I]**.

---

## 3. Sunsama feature inventory

**What Sunsama is:** a single-user daily planner with team billing. The unit of
organisation is the *day*, not the project. Tasks live in day columns and a backlog.
Channels and contexts provide categorisation [S4]. The calendar is where you
timebox [S2].

### 3.A Task management

| Feature | Status | Verified behaviour | Source |
|---|---|---|---|
| Create, edit, complete, delete | ✅ | "Add task" in any day column; tasks can be created from integrations, weekly objectives or the backlog | S1, S9 |
| Notes / description | ✅ | Task detail holds notes (documented as part of task basics; details of rich formatting not confirmed) | S9 |
| Attachments | ❓ | Not found in the help-centre excerpts reviewed | — |
| Planned (estimated) time | ✅ | Each task has a planned duration. It feeds the workload timeline and auto-scheduling | S1, S2 |
| Actual time | ✅ | The task timer (in focus mode) "measures time and keeps running even when you're not in the app" | S17 |
| Due dates | ✅ | Due dates are settable, for example via the MCP server ("create tasks with notes, time estimates, and due dates") | S22 |
| Start dates / priorities | ❓ | No priority field documented. Order within a day column is the priority signal | — [I] |
| Recurring tasks | ✅ | Three-dot menu → Repeat → frequency | S9 |
| Subtasks | ✅ | Subtasks can be timed and completed | S9 |
| Recurring + subtasks rollover | ⚠️ known defect | Rolling over a recurring parent with unfinished subtasks copies the whole task, creating a duplicate the user deletes by hand (open request) | S10 [C] |
| Dependencies | ❓ | None documented | — |
| Channels and contexts | ✅ | Channels categorise tasks, events and objectives. Contexts group channels. Shift-F filters by context/channel. `#` sets a channel during capture. A context can be marked "Personal" | S4 |
| Rollover | ✅ | Incomplete tasks roll over to tomorrow at midnight | S8 (summary) |
| Backlog | ✅ | For undated "someday" work. Shift-B opens it. `@backlog` sends a task there | S8 |
| Multiple backlogs / folders | 📋 | Open request | S27 [C] |
| Archive | ✅ (thin) | An archive exists for tasks that repeatedly roll over. Mechanics not detailed | S8 |
| Keyboard shortcuts | ✅ | Documented throughout (X to timebox, Shift-B backlog, Shift-F filter, Y voice) | S2, S4, S8, S15 |
| Quick capture with tokens | ✅ | `#channel`, `@backlog` in the title field | S4, S8 |
| Import from external tools | ✅ | Browse Asana, ClickUp, Notion, Jira, GitHub, Todoist and Trello tasks inside Sunsama and pull in the ones you want for today | S26 |
| Completion sync back to source | ❓ | Marketing says "automatically sync and update your tools"; per-integration direction not confirmed | S26 |

### 3.B Kanban and board management

| Feature | Status | Verified behaviour | Source |
|---|---|---|---|
| Daily Kanban | ✅ | The main view is day columns. Dragging a task to another column defers it to that day | S1 |
| Column semantics | ✅ | Columns are **dates**, not workflow states. There are no user-defined columns | S1 [I: inferred from all planning docs] |
| Backlog as a side panel | ✅ | The backlog is a separate list, not a board | S8 |
| Projects / multiple boards | ❓ / absent | No project board concept found. Channels are the closest grouping. Reviewers say it "lacks the ability to plan projects on a larger scale" | S4, S25 [C] |

**Retain / improve / replace [I]:**
- *Retain:* "drag to a day to commit". It is the simplest planning gesture in any of the four products.
- *Improve:* the day board becomes **one lens** (Week) over cards that live permanently on project boards.
- *Replace:* channels become labels or projects on real boards. Contexts map to Fluid's
  existing `Area`, which already has a `countsTowardCapacity` flag equivalent to the
  "Personal" toggle [F2 §9].

### 3.C Daily planning and productivity

| Feature | Status | Verified behaviour | Source |
|---|---|---|---|
| Guided morning planning | ✅ | Import meetings (manually or automatically), add tasks, pull from integrations, objectives or the backlog. Review the predicted workload timeline, then confirm | S1 |
| Capacity / overcommit warning | ✅ | The "predicted workload timeline" is reviewed before confirming, "to avoid overcommitting" | S1 |
| Defer during planning | ✅ | Drag to another day column | S1 |
| Timebox to calendar | ✅ | X or right-click → add to calendar | S2 |
| Auto-schedule (per task) | ✅ | Places a task in free time inside Settings → Schedules. Avoids events, ignores declined or "free" events, and splits a task across blocks if needed. Tasks of 1 hour or less split only if necessary; longer tasks split readily. Shift-X prevents splitting | S2 |
| Overcommitted day choices | ✅ | "Schedule anyway" (ignores schedule settings, as soon as possible), "schedule on another day", or "defer to tomorrow" | S2 |
| Auto-schedule a whole day | 📋 | Requested ("auto-schedule all tasks in today's task list") | S24 [C] |
| Control auto-scheduling hours | ✅ | Changelog entry | S23 |
| Auto-reschedule | ✅ | Shifts remaining tasks when one runs long or finishes early. Completing early truncates the session and pulls later tasks forward | S3 |
| Auto-reschedule refinements | 📋 | Requests: reschedule based on *actual* duration, and avoid delaying the start | S28 [C] |
| Daily shutdown | ✅ | Choose a wrap-up time during morning planning. The shutdown ritual reviews the day. Available only to people who plan in the morning | S6 |
| Daily highlights | ✅ | Generated as part of the shutdown ritual | S7 |
| Weekly review | ✅ | Rebuilt as a guided ritual: objectives progress → review of the week's work → short journal reflection. Schedule set in account settings | S5 |
| Weekly objectives | ✅ | Tasks can be created from weekly objectives | S1 |
| Focus mode + timer | ✅ | A single-task view with a running timer | S17 |
| Pomodoro | ✅ (UX gap) | Pomodoro exists, but you must toggle away from it to see overall task progress (request) | S18 [C] |
| Analytics | ✅ (thin evidence) | Marketing lists time-use analytics. Exact reports were not confirmed | S17 [O marketing], S22 [T] |

### 3.D Calendar and integrations

| Feature | Status | Verified behaviour | Source |
|---|---|---|---|
| Google Calendar | ✅ | Bidirectional sync: edits in Sunsama go to Google and vice versa | S11, S13 |
| Outlook | ✅ | Described as similarly bidirectional | S11 |
| Apple iCloud | ✅ | Listed as supported in the help centre | S11 |
| Generic CalDAV / Nextcloud | 📋 | A long-running public request, described by users as a blocker | S12 [C] |
| Multiple calendar accounts | ✅ | Several accounts can be connected | S11 |
| Private Sunsama calendar | ✅ (limited) | Cannot be shared, no invites, **no recurring events** | S11 (via summary) |
| Task integrations | ✅ | Asana, ClickUp, GitHub, Jira, Linear, Notion, Todoist, Trello, Gmail, Outlook mail, Slack, Teams (lists vary between sources) | S26, S1 |
| Public REST API | 📋 | Requested. A Sunsama rep said documentation was "still coming" | S16 [C], S22 |
| MCP server | ✅ | Hosted at `https://api.sunsama.com/mcp`, with OAuth. Tools reportedly cover task create, read, update and complete, subtasks, streams and comments | S14, S22 |

### 3.E AI

| Feature | Status | Verified behaviour | Source |
|---|---|---|---|
| Sunny assistant | ✅ | Chat to create and manage tasks, plan the day, reorder the list, pull events in as tasks, timebox, organise the backlog, and summarise completed work. Enabled in Settings → Integrations → AI Assistant | S15 |
| Voice mode | 🧪 | Microphone button or Y. Reported as still experimental | S15, S22 |
| AI channel and estimate suggestions | ✅ | "Sunsama AI automatically recommends time estimates and channels for each task" | S26 [O marketing] |
| AI weekly review | 📋 | Requested | roadmap [C] |

### 3.F UX, administration and commercial

| Feature | Status | Notes | Source |
|---|---|---|---|
| Desktop, web and mobile apps | ✅ | Multiple platforms (marketing and app listings) | S22 [T] |
| Team workspaces | ✅ | Collaborative workspaces share tasks and show teammates' lists. Private workspaces only aggregate billing. One admin owns billing | S19 |
| Assigning tasks to teammates | ❓ | Not explicitly documented in the excerpts reviewed | S19 |
| Pricing | 💳 | No free plan. 14-day trial. Reported at roughly $16–20 a month billed annually, or $20–25 billed monthly, with sources conflicting | S20, S21 |
| Common complaints | [C] | Price for a single-user tool, no larger-scale project planning, no CalDAV | S25, S12 |

---

## 4. Motion feature inventory

**What Motion is:** a task and project manager whose defining feature is an
auto-scheduler. It places tasks into calendar time and keeps re-placing them as
conditions change. It has added projects, workflow templates, AI notetaking and "AI
Employees".

### 4.A Automatic calendar organisation — verified rules

| Rule | Verified behaviour | Source |
|---|---|---|
| Inputs | Priority, deadlines (hard or soft), duration, minimum chunk, start date, the schedule a task is assigned to (working hours), and existing busy events | M2, M3 |
| Priority tiers | ASAP > High > Medium > Low. "ASAP tasks take precedence over everything unless no time is available." Setting ASAP greys out the deadline field | M3, M4 |
| Not a strict order | Scheduling "balances priority, deadlines, and availability together" rather than following one linear rule | M1 |
| Hard vs soft deadlines | Hard = "must be done by this exact deadline no matter what". Motion "will break its normal rules", including placing work outside working hours (the docs' example is 6 PM when 9–5 is full) and outside an assigned schedule | M1 |
| Soft deadlines | Ordered by due date. Flexible tasks without deadlines may be pushed back | M1 |
| Chunking | Set a total duration and a "Min chunk", and Motion splits the task into blocks across open slots. Without a chunk size it looks for one slot that fits the whole duration | M3 (via search summary) |
| Busy vs free events | Busy events block auto-scheduling and free events do not. A busy all-day event can push a whole day's tasks out | M6, M8 |
| Fixed (locked) tasks | Dragging an auto-scheduled task or creating a time block by hand locks it (lock icon). Locked tasks "won't be controlled by the algorithm", **but** Motion "will only consider rescheduling this task if you don't complete it" | M5, M6 |
| Missed work | Incomplete tasks are rescheduled "within 30 minutes of their original end time" | M8 |
| Horizon | Auto-scheduled only for the upcoming month, for performance reasons. 30 days for individuals and 92 days for teams | M7, M8 |
| Unschedulable | "Could not fit" means no free time within the window. "Past due" means scheduled after its deadline. Both collect in the **Resolve Issues** box, with a hover reason | M7 |
| Deadline risk | "Flags potential delays well in advance" | M25 |
| Recurring tasks | Daily, weekly, bi-weekly, monthly and quarterly patterns, auto-placed. For fixed-time routines Motion recommends recurring *events*, which are never moved | M21 |
| Deadline granularity | An independent review reports date-level rather than time-level deadlines, and a hard deadline pushing work outside configured hours | M24 [T, competitor] |

**Unspecified in Motion's docs [I]:**
- The tie-break between a High-priority soft-deadline task and a Medium-priority hard-deadline task.
- Whether re-placement is minimised. Reviews say tasks "shift multiple times" [M22].
- How dependent tasks are ordered beyond "blocked tasks cannot be scheduled" [M9].
- Whether any notification fires when a task moves.

### 4.B Calendar management

| Feature | Status | Source |
|---|---|---|
| Google, Outlook, iCloud read/write | ✅. Google and Outlook are "most consistent", iCloud is "more basic" | M14, M15 |
| Calendar visibility, default save location, time zones | ✅ | M14 (summary) |
| Booking links | ✅ (for Outlook, booking events write directly). Google and iCloud details not confirmed | M15 |
| Generic CalDAV / Nextcloud | ❓ / not listed | M14 |

### 4.C Task and project management

| Feature | Status | Verified behaviour | Source |
|---|---|---|---|
| Workspaces → projects → tasks | ✅ | Regular projects for one-off work. Project Workflow Templates for repeatable processes | M26, M10 |
| Stages | ✅ | Workflow steps of a project. Ad-hoc stages are allowed. Templates can auto-advance a project to the next stage when its tasks are done. Stage dates set default task deadlines | M9, M10 |
| Blockers (dependencies) | ✅ | "A task marked as blocked cannot be scheduled or progressed until the blocker is cleared." Also stage-level and external blockers. Multiple blockers per task since Apr 2025 | M9, M11 |
| Views | ✅ | List, Kanban and Gantt. Kanban groups by stage or any field (for example assignee), columns are reorderable, filters can be saved | M12, M13 |
| Assignment | ✅ | Tasks are assigned to team members and auto-scheduled on the assignee's calendar | M13 [I: inferred from per-assignee grouping] |

### 4.D AI and automation

| Feature | Status | Source |
|---|---|---|
| AI Notetaker: joins calls and produces summaries, transcripts and action items. Approved items become tasks with owners and deadlines | ✅ | M16 |
| AI Employees (scheduling, email, lead gen, content, project coordination) | 🧪 Beta | M17 |
| Public API | ✅. Base `https://api.usemotion.com/v1`, `X-API-Key` header, task CRUD. **No OAuth, no webhooks** (third-party review) | M18 [T] |

### 4.E Limitations and usability

| Issue | Evidence | Source |
|---|---|---|
| Frequent movement / instability | "New meetings or higher-priority work can make some tasks shift multiple times" | M22 [T competitor], M8 [O: by design] |
| Locks aren't absolute | A missed locked task is rescheduled like any other | M5 |
| Busy all-day events wipe out days | The documented cause of "could not fit"; the fix is to mark them Free | M8 |
| One-month horizon | Long-range plans beyond 30 days are not auto-placed for individuals | M8, M7 |
| No manual daily ritual | No guided planning or shutdown documented [I: absence in all sources] | — |
| Price and complexity | "Steep price that keeps going up", "clunky UI" | M22 [T competitor] |
| Pricing | 💳 No free tier. Trial (reported as 7 days). Pro AI and Business AI, with AI credits. Exact figures conflict | M19, M20 |

---

## 5. Trello and Nextcloud Deck comparison

| Capability | Trello | Nextcloud Deck | Implication for Fluid [I] |
|---|---|---|---|
| Hierarchy | Workspace → board → list → card [T8] | Board → stack → card. No workspace level beyond Nextcloud users, groups and Teams (Circles) [D2][D4 #5611] | Adopt Trello's workspace layer. Name columns "columns" (not lists or stacks) |
| Card fields | Title, description, members, labels, due *and start* dates, checklists, attachments, custom fields (💳 Standard+), cover, location [T9][T10] | Title (≤255), markdown description, labels, assigned users or groups, due date, `done` timestamp, attachments, comments [D3] | Fluid needs the Trello-level field set. Deck's `done`-independent-of-column model is better than Trello's "move to Done list" convention |
| Completion | Due-date "complete" checkbox. Done is usually modelled as a list | `done` timestamp, explicitly independent of the stack. Marking done "prevents it from becoming overdue and hides it from upcoming cards" [D2][D3] | **Adopt Deck's model** (decision D2) |
| Checklists | Native. *Advanced checklists* (assignee and due date per item) moved from Premium to Standard [T9] | Markdown task-list checkboxes in the description, rendered with progress [D4 #3327, #1998] | Native checklist items. Item due dates are P2 |
| Comments and mentions | ✅ | ✅ Replies, separate comment and activity timelines, notifications [D4] | ✅ P1 |
| Activity history | ✅ | ✅ "See everything that happened in your boards. Everything!" [D2] | ✅ P0, the backbone for undo and audit |
| Deleted-item recovery | Archive, then delete | **Deleted objects** tab restores stacks and cards. `undo_delete` endpoint for boards [D2][D3] | Soft delete everywhere, with a recovery tab |
| Archive | ✅ | ✅ Cards, stacks and boards [D3] | ✅ |
| Labels | ✅ Board-scoped | ✅ Board-scoped, "tags" [D2] | Workspace-scoped labels, with optional board restriction |
| Assignment | Members (many) | Users *or groups* [D2] | One `owner` (scheduled) plus many collaborators (decision D8) |
| Search | ✅ Cross-board | ✅ Cross-board, with operators `tag:`, `assigned:`, `date:overdue/today/week`, `list:`, comparisons on due date [D2] | **Adopt Deck's operator syntax** as the starting grammar |
| Saved filters / views | 💳 Table, Calendar, Timeline, Dashboard and Map are Premium or Enterprise [T8]. Workspace views span boards [T15] | Board filters and an "upcoming cards" overview [D4 #1934] | Saved views are P1. Calendar and Table are MVP because they are the product |
| Templates | ✅ Board templates | Clone board with stacks and labels [D3][D4 #1221] | Board templates are P1 |
| Automation | **Butler**: rules (trigger→actions), card buttons, board buttons, calendar (scheduled) commands and due-date commands. Suggests automations from repeated actions. Run quotas per plan [T4][T5][T12] | None native | Rule engine in P2, modelled on Butler's five types, but fed through the scheduler (§16) |
| Recurring cards | Via Butler scheduled commands [T4] [I] | None | Native recurrence on tasks (RRULE), P1 |
| Dependencies | ❓ Not native. Power-Ups only [T-search] | None | Native, already in Fluid (`TaskDependency`) |
| Calendar / timeblocking | **Planner**: connect up to 10 Google or Outlook accounts, drag a card into a time slot to block focus time, and scheduling focus time **does not change the card's due date**. Cards with due dates appear automatically (on shared boards only when assigned to you) [T1]. Free users reportedly view only [T2] | Cards with due dates exposed to Nextcloud Calendar and Tasks via CalDAV (board = calendar, card = VTODO), with a per-board toggle. **Read-only** for clients [D4 #1545, #4622][D6][D7] | Trello's "focus block ≠ due date" rule independently confirms decision D3 |
| Real-time | ✅ | `notify_push` session handling [D4 #3876] | SSE in P1 |
| API | REST with webhooks. 300 req / 10 s per key, 100 req / 10 s per token, `/1/members/` 100 req / 900 s. Exceeding gives 429. No limit on the number of webhooks [T6][T7] | REST (`/index.php/apps/deck/api/v1.0/…`), **ETag** propagation from child to parent, `If-Modified-Since` on the board list, plus OCS endpoints for comments, config and sessions [D3] | Copy Deck's ETag-propagation idea for cheap client sync |
| Import | Export JSON | Import Trello JSON (≤1000 actions) or via the Trello API [D2] | Trello JSON import is P2 |
| Permissions | Workspace roles, board visibility, guests (plan-dependent) | Per-board ACL with READ, EDIT, MANAGE and SHARE. Users, groups and circles. An explicit user ACL overrides group ACLs [D2][D3] | Workspace roles plus a board ACL override |
| Ownership transfer | Admin UI | `occ deck:transfer-ownership` [D2] | P2 |
| Self-hosting | No | Yes (Nextcloud app, AGPL-3.0) [D1] | Fluid is self-hostable via Docker [F1] |
| Mobile | Official apps | Third-party Android (F-Droid or Play) and iOS ("Next Deck") apps [D1] | Responsive web first. PWA in P2 |
| Scale limits | Free plan: 10 collaborators per workspace, enforced from 2024 (boards view-only above the limit) [T11] | "Not yet ready for intensive usage". 13 boards × 100 cards × 5 attachments ≈ 6,500 file queries [D1] | Design indexes and queries for 10k cards per workspace from the start (§17) |
| AI | Trello MCP (Jul 2026 community roundup) [T13]. Atlassian Intelligence and Rovo plan availability unverified | None | AI is P2/P3 and goes through the same validator (§15) |

**Foundation for Fluid [I]:** Trello's hierarchy and field set, Deck's completion
semantics, soft-delete recovery, ACL model, search grammar and ETag sync, Butler's
automation *shapes*, and Trello Planner's rule that a focus block never edits the due
date.

---

## 6. Unified feature matrix

Priority: **P0** essential · **P1** competitive · **P2** advanced · **P3** optional.
"Fluid today" reports the repository's own claims [F1][F3]. Complexity is S, M, L or XL.

| # | Feature | Products | Verified behaviour (short) | User problem | Strengths | Weaknesses | Pri | Release | Recommended implementation [I] | Depends on | Cx | Fluid today | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Workspaces | Trello, Motion | Container of boards and members | Separate contexts and teams | Clear tenancy boundary | Plan limits (Trello) | P0 | MVP | `workspaces` table. Every row is scoped by `workspace_id` | Auth | M | ❌ (user-scoped) | T8, T11, M26 |
| 2 | Projects | Motion | Project with stages, deadline, templates | Group work toward an outcome | Rollup deadline, stages | Heavy for small work | P0 | MVP | Keep `Project`. Add `workspace_id`. A project has 1..n boards | 1 | S | ✅ partial | M9, F3 |
| 3 | Boards and custom columns | Trello, Deck, Motion | Kanban with user-defined columns | Visual workflow | Universal mental model | No scheduling | P0 | MVP | `boards`, `board_columns(status_category, wip_limit, auto_schedule)` | 1, 2 | M | ❌ (week board only) | T8, D2, M12 |
| 4 | Card ↔ task identity | — | — | No duplicates across views | — | Others duplicate via sync | P0 | MVP | `tasks.board_id, column_id, position`. One row | 3 | M | ✅ single row | D1 decision |
| 5 | Drag-and-drop with keyboard alternative | All | Drag between columns and days | Fast reorganisation | Direct manipulation | Inaccessible alone | P0 | MVP | dnd-kit with keyboard sensor, plus a "Move to…" menu (Fluid already has one) | 3 | M | ✅ week board | F1 |
| 6 | Labels | Trello, Deck | Coloured tags | Cross-cutting categorisation | Cheap | Sprawl | P0 | MVP | Workspace labels. `task_labels` join | 1 | S | ❌ | D2 |
| 7 | Checklists | Trello (native), Deck (markdown) | Items with progress | Break work down without new cards | Lightweight | Not schedulable individually | P0 | MVP | `checklists`, `checklist_items`. Item → subtask promotion | 4 | S | ❌ | T9, D4 |
| 8 | Subtasks | Sunsama, Motion | Child tasks, timed | Schedulable sub-work | Each has an estimate | Clutter | P1 | MVP | Keep `Task.parentId`. Parent estimate = own + Σ children (display only) | 4 | S | ✅ | S9, F3 |
| 9 | Comments and mentions | Trello, Deck | Threaded comments | Collaboration | — | Noise | P1 | MVP (basic) | `comments`. Mentions create notifications | 1, 27 | M | ❌ | D3 |
| 10 | Attachments | Trello, Deck | Files on cards | Reference material | — | Storage cost, security | P1 | MVP | S3-compatible store. Signed URLs. AV scan hook | 18 | M | ❌ | D3 |
| 11 | Activity history | Trello, Deck | Every change logged | Trust, audit, undo | — | Volume | P0 | MVP | Append-only `activity_events` (§17). Undo derives from it | 4 | M | partial (`AiAction`, `PlanChange`) | D2 |
| 12 | Soft delete and recovery | Deck | Deleted-objects tab | Recover mistakes | Safety | Retention cost | P0 | MVP | `deleted_at` on tasks, columns, boards. 30-day purge job | 11 | S | partial (events only) | D2, D3 |
| 13 | Search with operators | Deck, Trello | `tag:`, `assigned:`, `date:` | Find anything | Power-user speed | Learning curve | P0 | MVP | Postgres FTS + `pg_trgm`, using Deck's grammar plus `due:`, `planned:`, `status:` | 4 | M | ❌ | D2 |
| 14 | Filters, grouping, saved views | Trello 💳, Motion | Per-view query | Focus | — | Sprawl | P1 | MVP (filters), P1 (saved) | `saved_views(query_json, layout, group_by, sort)` | 13 | M | ❌ | T8, M13 |
| 15 | Custom fields | Trello 💳 | Typed fields | Domain data | Flexible | Schema creep | P2 | Later | `custom_field_defs` + `custom_field_values` (typed columns, not EAV-JSON) | 3 | M | ❌ | T9 |
| 16 | Board templates | Trello, Deck clone, Motion PWT | Reusable structure | Repeatable processes | — | — | P1 | Later | Template = serialised board plus relative-date offsets | 3 | M | ❌ | D3, M10 |
| 17 | Priority | Motion | ASAP/High/Med/Low | Rank work | — | Everything becomes high | P0 | MVP | Keep `LOW…URGENT`. URGENT = Motion ASAP semantics | — | S | ✅ | M3 |
| 18 | Estimate and actual time | Sunsama, Motion | Planned vs actual | Realistic plans | Calibration | Tracking burden | P0 | MVP | Keep `estimateMinutes`, `actualMinutes`, `TimeEstimateSample` | — | S | ✅ | S1, S17 |
| 19 | Deadline (soft or hard) | Motion | Hard deadlines may break hours | Commitments to others | Expressive | Surprise overtime | P0 | MVP | `deadline` + `deadline_kind SOFT/HARD`. HARD never breaks working hours silently; it *proposes* overtime | 17 | S | ✅ soft only | M1 |
| 20 | Start date / earliest start | Motion | Do not schedule before | Waiting periods | — | — | P0 | MVP | Keep `earliestStart` | — | S | ✅ | M2 |
| 21 | Dependencies | Motion | Blocked tasks unschedulable. Multiple blockers | Order work | Correct sequencing | Over-modelling | P1 | MVP | Keep `TaskDependency`. Cycle check on write | 4 | S | ✅ | M9, M11 |
| 22 | Recurrence | Sunsama, Motion | Repeating series | Routine work | — | Duplicates on rollover (Sunsama) | P1 | P4 | RRULE on a template task. Materialise the *next* instance only. Instances are separate rows linked by `series_id` | 4 | L | ❌ (routines as protected time only) | S9, S10, M21 |
| 23 | My Day / daily list | Sunsama | Ordered list for one day | Intentional focus | Bounded | Manual effort | P0 | MVP | Keep `plannedFor` + `dayOrder` | 4 | S | ✅ | S1, F1 |
| 24 | Guided morning planning | Sunsama | Ritual with workload preview | Realistic commitments | Reflective | Skippable friction | P0 | MVP | Keep `/plan-day`. Pull candidates from boards | 23 | S | ✅ | S1, F1 |
| 25 | Capacity meter | Sunsama | Predicted workload | Overcommitment | Early warning | — | P0 | MVP | Keep the capacity ledger [F2 §9] | 23 | S | ✅ | S1 |
| 26 | Shutdown and highlights | Sunsama | End-of-day review | Closure, rollover decisions | — | — | P1 | MVP | Keep. Rollover is an explicit decision | 23 | S | ✅ | S6, S7 |
| 27 | Weekly planning and review | Sunsama | 3-step guided review | Strategic reflection | — | — | P1 | P4 | Keep objectives. Add a guided review flow | 26 | M | partial | S5 |
| 28 | Timeboxing (manual) | Sunsama, Trello Planner | Drag task to a time slot | Explicit plans | Control | Manual effort | P0 | MVP | Creates a *pinned* `ScheduledBlock` | 30 | S | ✅ | S2, T1 |
| 29 | Auto-scheduling | Motion, Sunsama (per task) | Engine places blocks | Removes planning toil | Speed | Unpredictable | P0 | MVP | Existing `plan()` (§13) | 30 | L | ✅ | M1, S2 |
| 30 | Calendar view | All but Deck (Deck via Nextcloud Calendar) | Week or day grid | See commitments | — | — | P0 | MVP | Keep `/calendar`. Add drag-to-slot from a card side panel | — | M | ✅ | T1 |
| 31 | Rescheduling modes | Motion (auto), Sunsama (assisted per task) | — | Control vs convenience | — | — | P0 | MVP (Manual, Assisted), P3 (Auto, Hybrid) | Map onto `AutonomyLevel` plus a disruption score (§13.C) | 29 | M | ✅ partial | M8, S3 |
| 32 | Locks / pins | Motion, Fluid | Manually placed blocks fixed | Respect decisions | — | Motion locks still move [M5] | P0 | MVP | `isPinned` never moves. Missed means *propose* only | 29 | S | ✅ | M5 |
| 33 | Scheduling explanations and diff | Fluid (Motion: reasons on hover only) | Plain-language diff | Trust | — | — | P0 | MVP | Keep `PlanVersion` / `PlanChange` | 29 | S | ✅ | M7, F2 |
| 34 | Resolve-issues tray | Motion | Past due and could-not-fit list | Visible failure | — | — | P0 | MVP | `Plan.unscheduled` + `spilled` as a tray | 29 | S | ✅ data, partial UI | M7 |
| 35 | Google Calendar | All | Two-way | — | — | — | P0 | MVP | Adapter on the existing contract | 30 | L | ❌ (interface only) | S11, M14, T1 |
| 36 | Outlook / M365 | All | Two-way | — | — | — | P1 | P2 | Graph adapter | 35 | L | ❌ | S11, M14 |
| 37 | CalDAV / Nextcloud | Deck (read-only export) | — | Self-host users | Differentiator | No push | P0 | MVP | Existing adapter | — | — | ✅ | S12, F1 |
| 38 | iCloud | Sunsama, Motion | Basic | Apple users | — | App-specific password | P2 | Later | CalDAV adapter with iCloud discovery | 37 | M | via CalDAV ❓ untested | C7, C8 |
| 39 | Focus mode and timer | Sunsama | Timer, Pomodoro | Execution | — | Pomodoro/focus toggle UX [S18] | P1 | MVP | Keep `/focus`. Show both timers | — | S | ✅ | S17, S18 |
| 40 | Reports | Sunsama, Trello 💳 | Time use, dashboards | Learning | — | Vanity metrics | P1 | P4 | §11 metrics in [02-product.md](02-product.md) | 18 | M | partial (`/review`) | S17, T15 |
| 41 | Rule automation | Trello Butler | Triggers → actions | Remove repetition | Powerful | Loops, quotas | P2 | P4 | §16 engine. Actions go through the validator | 11 | L | ❌ | T4 |
| 42 | Notifications and reminders | Trello, Deck | Mentions, due | Awareness | — | Noise | P1 | P4 | In-app, email and web push. Quiet hours exist | 9 | M | ❌ (prefs only) | D4 |
| 43 | Team workspaces and roles | Trello, Deck, Sunsama, Motion | Membership, ACL | Collaboration | — | — | P1 | P5 | Roles plus board ACL (§16) | 1 | L | ❌ | D3, S19 |
| 44 | Team workload | Motion | Kanban grouped by assignee | Balance load | — | — | P2 | P5 | Capacity per member from the scheduler | 43 | M | ❌ | M12 |
| 45 | AI assistant (NL ops) | Sunsama, Motion | Chat to plan and manage | Speed | — | Trust, injection | P2 | P5 | Tool-calling over validated actions (§15) | 41 | L | partial (calendar agent) | S15, M17 |
| 46 | AI project breakdown | Motion (notetaker → tasks) | — | Starting is hard | — | Hallucinated scope | P2 | P5 | Exists as "AI breakdown" for one task. Extend to a board | 45 | M | ✅ single task | F1 |
| 47 | Meeting notetaker | Motion | Transcribe → tasks | Action capture | — | Privacy, cost | P3 | Optional | Out of scope (§9) | — | XL | ❌ | M16 |
| 48 | Booking links | Motion | Scheduling pages | External meetings | — | Separate product | P3 | Optional | Out of scope (§9) | — | L | ❌ | M15 |
| 49 | Public API and webhooks | Trello, Deck, Motion (no webhooks) | REST | Integration | — | — | P1 | P4 | REST v1 + signed webhooks (§19) | 11 | M | ❌ | T6, D3, M18 |
| 50 | MCP server | Sunsama, Trello | AI clients act on data | AI interoperability | — | Same risks as the AI | P2 | P5 | MCP over the public API with OAuth scopes | 49 | M | ❌ | S14, T13 |
| 51 | Import (Trello JSON, CSV) | Deck, Sunsama | — | Migration | — | — | P2 | P4 | Deck's Trello-import approach | 4 | M | ❌ | D2 |
| 52 | Self-hosting | Deck, Fluid | Docker | Data ownership | Differentiator | Ops burden | P0 | MVP | Keep compose. Add backup scripts | — | M | ✅ | D1, F1 |
| 53 | Offline edits (mobile) | Trello apps | — | Spotty connections | — | Conflicts | P2 | Later | Op queue with per-field merge (§12) | 11 | L | ❌ | [I] |
| 54 | Gantt / timeline | Motion, Trello 💳 | Dates and dependencies | Long-range view | — | Maintenance | P2 | P4 | Read-only first (derived from blocks, deadlines and dependencies) | 21 | L | ❌ | M13, T8 |

### Redundant, incompatible or not-to-combine

| Pair | Problem | Resolution [I] |
|---|---|---|
| Sunsama "channels" vs Trello "labels" vs Fluid "areas" | Three categorisation axes confuse capture | **Area** = capacity ledger (Work/Personal). **Project/board** = where work lives. **Label** = free tagging. No channels |
| Motion "stages" vs board columns | Two workflow axes on one project | A column *is* a stage. Motion-style stage dates become optional column due dates (P2) |
| Sunsama day columns vs Trello lists | Both are columns, with different meanings | Day columns are a *view* (Week). Workflow columns are *data* (Board). Never mix them on one screen without a clear switch |
| Motion's "hard deadline breaks working hours" vs Fluid's "working hours are a constraint" | Silent overtime vs never overtime | Hard deadlines may **propose** out-of-hours time, never apply it automatically (D4/D5) |
| Motion's "missed locked task moves" vs Fluid's "pinned never moves" | Incompatible lock semantics | Fluid's semantics win. A missed pin becomes a recovery proposal |
| Midnight auto-rollover (Sunsama) vs explicit shutdown decisions (Fluid) | Silent vs deliberate | Explicit. If the user skips shutdown, unfinished commitments show as "carried, undecided" the next morning |
| Recurring task copying (Sunsama) vs a single source of truth | Duplicates [S10] | A series is a template. Each instance is its own row, and rollover moves the instance, never copies it |

---

## 7. Verified feature gaps and user pain points

Each finding has an ID that the PRD ([02-product.md §10](02-product.md#10-product-requirements-document))
traces to.

| ID | Finding | Evidence | Strength | Requirement it drives |
|---|---|---|---|---|
| **R-01** | Sunsama has no permanent project boards. Reviewers say it can't plan projects at scale | S25 [C], absence in S1–S9 | Medium (review plus absence) | REQ-BRD-* |
| **R-02** | Motion moves tasks repeatedly, and its docs describe rescheduling within 30 minutes of a missed end time as intended behaviour | M8 [O], M22 [T] | Strong (vendor-confirmed) | REQ-SCH-STAB, REQ-SCH-DIFF |
| **R-03** | Motion's locks are not absolute: missed locked tasks are rescheduled | M5, M6 [O] | Strong | REQ-SCH-LOCK |
| **R-04** | Motion's hard deadlines silently break working hours | M1 [O], M24 [T] | Strong | REQ-SCH-HARD |
| **R-05** | Motion only schedules about 30 days ahead for individuals (92 for teams) | M7, M8 [O] | Strong | REQ-SCH-HORIZON |
| **R-06** | Busy all-day events collapse whole days in Motion | M8 [O] | Strong | REQ-CAL-ALLDAY |
| **R-07** | Sunsama cannot auto-schedule a whole day, and users ask for it | S24 [C], S2 [O: per task only] | Medium | REQ-SCH-DAY |
| **R-08** | Sunsama's auto-reschedule doesn't learn from actual durations (request) | S28 [C] | Weak (request) | REQ-SCH-ACTUAL |
| **R-09** | Sunsama duplicates recurring parents with unfinished subtasks on rollover | S10 [C] | Medium (specific defect report) | REQ-REC-NODUP |
| **R-10** | Neither Sunsama nor Motion supports generic CalDAV / Nextcloud. Sunsama users call it a blocker | S12 [C], M14 [O] | Strong | REQ-CAL-CALDAV |
| **R-11** | Deck's CalDAV exposure is read-only | D6, D7 [C], D4 [P] | Medium | REQ-CAL-NC |
| **R-12** | Deck has documented performance limits at modest scale | D1 [P] | Strong | REQ-NFR-PERF |
| **R-13** | Trello's extra views (Calendar, Table, Timeline) are Premium-only. The free plan is capped at 10 collaborators | T8, T11 [O] | Strong | (commercial positioning) REQ-VIEW-* |
| **R-14** | Trello Planner separates focus blocks from due dates, a validated design pattern | T1 [O] | Strong | REQ-TASK-DATES |
| **R-15** | Deck separates `done` from columns, a validated design pattern | D3 [P] | Strong | REQ-TASK-DONE |
| **R-16** | Motion's API has no webhooks and no OAuth. Sunsama has no public REST API | M18 [T], S16 [C] | Medium | REQ-API-* |
| **R-17** | Sunsama's Pomodoro and focus timers can't be seen together | S18 [C] | Weak | REQ-FOCUS-TIMERS |
| **R-18** | Motion's scheduling precedence is underspecified even in its own docs | M1, M3 [O] | Strong | REQ-SCH-EXPLAIN |
| **R-19** | Price: no free tier for Sunsama or Motion. Trello free is shrinking | S20, S21, M19, T16 [T] | Medium (conflicting figures) | (positioning) self-host free |
| **R-20** | Butler-style automation is valued but quota-limited | T4, T12 | Medium | REQ-AUTO-* |
| **R-21** | AI assistants (Sunny, Motion AI) act directly. Neither documents a validation layer | S15, M17 [O] | Medium (absence of evidence) | REQ-AI-VALIDATE |
| **R-22** | Fluid already has: protected time, spill reporting, plan diffs, ownership-guarded sync, AI autonomy tiers | F1–F5 [P] | Strong | Reuse, do not rebuild |
