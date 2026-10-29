# Fluid Unified Workspace — Product Blueprint

A research-backed specification for growing Fluid from a personal ADHD day
planner into a **board-first project manager with Sunsama-style daily planning and
a Motion-style automatic scheduler**, all over a single task record.

Written 29 October 2026. This is a specification, not a status report: nothing in
it claims that code has been written, deployed or tested unless it points to a file
that already exists in this repository, and even then it reports what the
repository *says* (README, schema, tests) rather than re-running it.

---

## Reading order

| # | Deliverable (as requested) | File |
|---|---|---|
| 1 | Executive summary | this file, [below](#1-executive-summary) |
| 2 | Research methodology and source register | this file, [below](#2-research-methodology-and-source-register) |
| 3 | Sunsama feature inventory | [01-research.md §3](01-research.md#3-sunsama-feature-inventory) |
| 4 | Motion feature inventory | [01-research.md §4](01-research.md#4-motion-feature-inventory) |
| 5 | Trello and Nextcloud Deck comparison | [01-research.md §5](01-research.md#5-trello-and-nextcloud-deck-comparison) |
| 6 | Feature-by-feature comparison matrix | [01-research.md §6](01-research.md#6-unified-feature-matrix) |
| 7 | Verified gaps and user pain points | [01-research.md §7](01-research.md#7-verified-feature-gaps-and-user-pain-points) |
| 8 | Recommended unified feature set | [02-product.md §8](02-product.md#8-recommended-unified-feature-set) |
| 9 | Features deliberately excluded | [02-product.md §9](02-product.md#9-features-deliberately-excluded) |
| 10 | Product requirements document | [02-product.md §10](02-product.md#10-product-requirements-document) |
| 11 | User journeys | [02-product.md §11](02-product.md#11-user-journeys) |
| 12 | Information architecture and screens | [02-product.md §12](02-product.md#12-information-architecture-and-screen-specifications) |
| 13 | Scheduling engine and pseudocode | [03-scheduler.md](03-scheduler.md) |
| 14 | Calendar integration and sync | [04-sync-ai-collaboration.md §14](04-sync-ai-collaboration.md#14-calendar-integration-and-synchronisation) |
| 15 | AI assistant | [04-sync-ai-collaboration.md §15](04-sync-ai-collaboration.md#15-ai-assistant-specification) |
| 16 | Collaboration and automation | [04-sync-ai-collaboration.md §16](04-sync-ai-collaboration.md#16-collaboration-and-automation-specification) |
| 17 | Data model and ER diagram | [05-data-and-architecture.md §17](05-data-and-architecture.md#17-data-model) |
| 18 | Technical architecture | [05-data-and-architecture.md §18](05-data-and-architecture.md#18-recommended-technical-architecture) |
| 19 | API and events | [05-data-and-architecture.md §19](05-data-and-architecture.md#19-api-endpoint-and-event-specification) |
| 20 | Security and deployment | [05-data-and-architecture.md §20](05-data-and-architecture.md#20-security-and-deployment-requirements) |
| 21 | MVP and roadmap | [06-delivery.md §21](06-delivery.md#21-mvp-scope-and-phased-roadmap) |
| 22 | Test plan and acceptance criteria | [06-delivery.md §22](06-delivery.md#22-test-plan-and-acceptance-criteria) |
| 23 | Technical risks | [06-delivery.md §23](06-delivery.md#23-major-technical-risks-and-mitigations) |
| 24 | Open questions and decisions | [06-delivery.md §24](06-delivery.md#24-unresolved-questions-assumptions-and-decisions-requiring-input) |
| 25 | Implementation checklist | [06-delivery.md §25](06-delivery.md#25-final-prioritised-implementation-checklist) |

If you are an engineer picking this up, read §1, then
[03-scheduler.md](03-scheduler.md), then the data model in
[05-data-and-architecture.md §17](05-data-and-architecture.md#17-data-model), then
the roadmap. The research files explain *why*; the rest explain *what*.

---

## 1. Executive summary

### The opportunity

The four products each own one part of the problem, and none of them joins the parts up:

| Product | What it owns | What it lacks |
|---|---|---|
| **Sunsama** | The intentional day: guided planning, a capacity check before you commit, shutdown, weekly review [S1][S5][S6] | Permanent project structure. Its board is a *board of days*, and users say it "lacks the ability to plan projects on a larger scale" [S25]. You choose the time by hand, with auto-schedule one keystroke per task [S2] |
| **Motion** | The engine: tasks placed automatically by priority, deadline and availability, then rescheduled as the day changes [M1][M3] | Predictability and ritual. Tasks move without being asked, locked tasks still move if missed [M5], and the scheduling window is one month for individuals [M7][M8] |
| **Trello** | The visual board: lists, cards, Butler automation, Power-Ups, a mature API [T4][T6] | Scheduling. Planner can time-block a card [T1], but nothing schedules for you, there are no native dependencies, and the extra views need Premium [T8] |
| **Nextcloud Deck** | Self-hosted, privacy-respecting Kanban inside an existing groupware stack [D1][D2] | Depth. No checklists beyond markdown, read-only CalDAV exposure [D6], and documented performance limits [D1] |

**The product this blueprint describes:** permanent Kanban boards as the home of all work. Any
card can be committed to a day (Sunsama) and turned into calendar sessions automatically
(Motion), without ever being copied. The **board decides what**, the **day decides which
day**, the **engine decides when**, and the user can overrule any of the three.

### Where Fluid already is

This repository already contains the hardest half (per [F1][F2][F3]). It has a pure,
deterministic scheduler with protected time, dependencies, chunking, energy matching and
a churn-minimising stability pass. Day commitments (`Task.plannedFor`) are a soft window,
and when the scheduler cannot honour one, the spill is reported. There is a capacity
ledger, a morning ritual, focus mode and shutdown. Events have an ownership model, so the
scheduler cannot write to a real meeting, and database triggers enforce that. The CalDAV
adapter works, and the AI action validator has autonomy tiers and per-entry undo.

What it does **not** have is everything Trello and Deck are known for. There are no
workspaces, no boards or columns as entities, and no labels, comments, attachments,
checklists or custom fields. There is no activity history, no sharing, no multi-user
anything, no automation rules, and no Google or Microsoft adapter calls. The README
lists these gaps itself [F1].

So the plan is **not** "build a new app". It is:

1. **Add the board layer** (workspaces, boards, columns, card metadata, activity) on top
   of the existing `Task` row, so it stays the single source of truth.
2. **Finish the integration layer** (Google, Microsoft Graph, a background worker).
3. **Generalise from one user to a workspace** (membership, roles, per-assignee
   scheduling), keeping the scheduler per person.
4. **Add rule-based automation and the AI assistant** on top of the same validated
   action pipeline that already gates AI calendar edits.

### Ten decisions that shape everything else

| # | Decision | Why | Section |
|---|---|---|---|
| D1 | **One `Task` row per piece of work.** Board position, day commitment, sessions and calendar mirrors are all *references to* it | Every competitor that syncs copies (Sunsama's integrations, Trello mirror Power-Ups) ends up with stale duplicates [S10] | §17 |
| D2 | **Completion is a property, not a column.** A card is done when `completedAt` is set. A column may *react* to that, but moving to "Done" is not the only way to finish | Deck made exactly this split (`done` independent of stack) [D3]. It lets My Day complete a card without knowing the board's workflow | §12, §17 |
| D3 | **Deadline ≠ day commitment ≠ session.** Three separate fields with three separate owners: the project, the person, the engine | Conflating them is how a "due Friday" card turns into "missed Tuesday" | §10 |
| D4 | **The deterministic engine decides. AI only proposes**, and every AI proposal passes the same validator as a human edit | Motion's behaviour is opaque even in its own docs [M1]. Prompt injection via calendar invites is real [F2] | §13, §15 |
| D5 | **Every change the engine makes is a versioned plan with a plain-language diff and per-entry undo** | Motion's most repeated complaint is tasks moving without explanation [M8][M22] | §13 |
| D6 | **Four autonomy modes (Manual, Assisted, Automatic, Hybrid), configured per user and capped per pass** | Neither Sunsama's all-manual approach nor Motion's all-auto approach suits everyone, and both vendors get feature requests from the other camp [S24][M24] | §13.C |
| D7 | **Event ownership is immutable.** The engine may only write events it created. External events are read-only unless the user edits one deliberately | Already enforced in Fluid three ways [F2]. It is the one failure the product cannot survive | §14 |
| D8 | **Only one person is scheduled per card**, the `owner`. Other members are collaborators | A card split across three calendars has no meaningful duration estimate. Motion schedules per assignee too [M13] | §16 |
| D9 | **Modular monolith** (Next.js + tRPC + Postgres + Redis/BullMQ worker), self-hostable with one `docker compose up` | It matches the existing repo. Deck shows self-hosting matters to a real audience [D1] | §18 |
| D10 | **The MVP is a board and a day, not a platform.** Teams, automation rules, Gantt and AI chat come later | The request warns against overcomplicating the MVP, and the existing single-user engine already delivers the differentiator | §21 |

### MVP in one paragraph

A single user, possibly with a few invited collaborators who can view and comment, gets:

- Workspaces holding projects, each with one or more boards of custom columns.
- Cards with description, labels, checklist, attachments, comments, priority, estimate,
  deadline, start date and dependencies.
- Search and filters across boards.
- The existing My Day and Week screens, now reading from the same cards.
- One-gesture "commit to a day" from any card.
- The existing scheduler, now fed from board cards. It runs in Assisted mode by default
  and shows a diff.
- Google Calendar and CalDAV/Nextcloud two-way block sync.
- Activity history and undo.

Everything else is phased (§21).

---

## 2. Research methodology and source register

### Method

1. **Codebase audit first.** Read `README.md`, `docs/architecture.md`,
   `packages/db/prisma/schema.prisma` and `packages/core/src/scheduler/*`, so that
   recommendations extend what exists rather than restate it.
2. **Primary sources where reachable.** Nextcloud Deck's documentation and API reference
   were read directly from its source repository (README, `docs/API.md`,
   `docs/User_documentation_en.md`, `CHANGELOG.md`, `appinfo/info.xml` on `main`).
3. **Official vendor pages via search.** This session's network policy refused direct
   connections to `sunsama.com`, `usemotion.com`, `trello.com`,
   `developers.google.com` and `learn.microsoft.com` (DNS or proxy refusal). For those,
   the official help-centre, changelog and reference pages were located and read
   **through web-search excerpts**, not fetched in full. Claims sourced this way are
   tagged **[O]**. They quote or paraphrase the vendor's own page, but a reviewer should
   open the link before relying on exact wording.
4. **Independent and community sources** were used for pricing (which the vendors'
   pages did not surface), for complaints, and to cross-check marketing against
   documentation. Competitor-authored reviews (Morgen, ClickUp, Lindy and others) are
   flagged as such, because they have a reason to shape the comparison.
5. **Nothing was assumed to exist because a competitor has it.** Where a feature could
   not be confirmed, it is marked *Unverified* rather than omitted or asserted.

### Evidence and status legend

**Evidence grade**, shown in brackets after the source ID:

| Tag | Meaning |
|---|---|
| **[P]** | Primary source read directly in full (source code, official repository docs) |
| **[O]** | Official vendor page (help centre, changelog, API reference), read via search excerpt |
| **[T]** | Third-party review or article. *Competitor-authored* is noted where relevant |
| **[C]** | Community post, public roadmap request, forum thread or user review: evidence of user sentiment, not of product behaviour |
| **[K]** | Standard or protocol behaviour stated from established knowledge (RFCs, widely documented API semantics), not re-fetched in this session. Verify before implementation |
| **[I]** | Inference or architectural recommendation, not a product fact |

**Feature status**, used in the inventories:

| Status | Meaning |
|---|---|
| ✅ **Available** | Documented as currently shipping |
| 💳 **Plan-gated** | Available only on certain tiers or conditions |
| 🧪 **Beta / experimental** | Labelled beta, experimental or early access by the vendor |
| 📋 **Requested** | Appears only as a public feature request. Not shipped as far as the evidence shows |
| 🗄️ **Legacy / removed** | Discontinued or superseded |
| ❓ **Unverified** | Claimed by third parties only, or could not be confirmed |

### Source register

Dates are the publication or update date where the source shows one. Otherwise they
are "n.d." (accessed 2026-10-29).

#### Fluid (this repository)

| ID | Source | Grade |
|---|---|---|
| F1 | `README.md` — product loop, screens, status, what does not work | [P] |
| F2 | `docs/architecture.md` — the nine design decisions | [P] |
| F3 | `packages/db/prisma/schema.prisma` and migrations | [P] |
| F4 | `packages/core/src/scheduler/{plan,types,availability,capacity,diff,flow}.ts` | [P] |
| F5 | `packages/core/src/actions/index.ts` — AI action validator | [P] |
| F6 | `packages/calendar/src/{adapter,types}.ts`, `adapters/caldav/*`, `testing/contract.ts` | [P] |

#### Sunsama

| ID | Source | Grade | Date |
|---|---|---|---|
| S1 | [Daily Planning: the basics](https://help.sunsama.com/docs/daily-planning-the-basics) | [O] | n.d. |
| S2 | [Timeboxing: auto-scheduling](https://help.sunsama.com/docs/timeboxing-auto-scheduling) | [O] | n.d. |
| S3 | [Auto-rescheduling](https://help.sunsama.com/docs/auto-rescheduling) | [O] | n.d. |
| S4 | [Channels and Contexts](https://help.sunsama.com/docs/usage-guides/channels-and-contexts) | [O] | n.d. |
| S5 | [Changelog: Weekly review 2.0](https://roadmap.sunsama.com/changelog/weekly-review-20) | [O] | n.d. |
| S6 | [Changelog: Daily shutdown](https://roadmap.sunsama.com/changelog/daily-shutdown) | [O] | n.d. |
| S7 | [Changelog: Daily highlights](https://roadmap.sunsama.com/changelog/daily-highlights) | [O] | n.d. |
| S8 | [Backlog pro-tips](https://help.sunsama.com/docs/backlog-pro-tips) | [O] | n.d. |
| S9 | [Tasks: the basics](https://help.sunsama.com/docs/getting-started/basics/task-basics) · [Task management pro-tips](https://help.sunsama.com/docs/task-management) | [O] | n.d. |
| S10 | [Request: roll over subtasks for daily repeated tasks](https://roadmap.sunsama.com/improvements/p/rollover-subtasks-for-daily-repeated-tasks) | [C] | n.d. |
| S11 | [Calendar Integration](https://help.sunsama.com/docs/calendar-integration) | [O] | n.d. |
| S12 | [Request: CalDAV/iCloud integration](https://roadmap.sunsama.com/integrations/p/caldavicloud-integration) | [C] | n.d. |
| S13 | [Google Calendar integration page](https://www.sunsama.com/integrations/google-calendar) | [O] marketing | n.d. |
| S14 | [MCP (Model Context Protocol)](https://help.sunsama.com/docs/integrations/mcp/) | [O] | n.d. |
| S15 | [Sunny the AI Assistant](https://help.sunsama.com/docs/usage-guides/sunny) | [O] | n.d. |
| S16 | [Request: Sunsama API](https://roadmap.sunsama.com/improvements/p/sunsama-api) | [C] | n.d. |
| S17 | [Focus mode](https://sunsama.com/features/focus-mode) | [O] marketing | n.d. |
| S18 | [Request: better juggling between pomodoro and focus mode](https://roadmap.sunsama.com/improvements/p/better-juggling-between-pomodoro-vs-focus-mode) | [C] | n.d. |
| S19 | [Using Sunsama with teammates](https://help.sunsama.com/docs/using-sunsama-with-teammates) | [O] | n.d. |
| S20 | [Morgen: Sunsama pricing 2026](https://www.morgen.so/blog-posts/sunsama-pricing) | [T] competitor | Apr 2026 |
| S21 | [Techpresso: Is Sunsama worth it](https://academy.techpresso.co/reviews/is-sunsama-worth-it) | [T] | claims pricing read 2026-10-24 |
| S22 | [Carly: Sunsama review 2026](https://www.usecarly.com/blog/sunsama-review/) · [Claude + Sunsama](https://www.usecarly.com/blog/claude-sunsama-integration/) | [T] | 2026 |
| S23 | [Changelog: control auto-scheduling hours](https://roadmap.sunsama.com/changelog/control-auto-scheduling-hours) | [O] | n.d. |
| S24 | [Request: auto-schedule all tasks in today's list](https://roadmap.sunsama.com/improvements/p/automatic-day-scheduling) · [Request: automatically schedule tasks to calendar](https://roadmap.sunsama.com/improvements/p/automatically-schedule-tasks-to-calendar) | [C] | n.d. |
| S25 | [GetApp: Sunsama reviews](https://www.getapp.com/all-software/a/sunsama/) | [C] | n.d. |
| S26 | [Sunsama for engineers (integration list)](https://www.sunsama.com/team/engineering) | [O] marketing | n.d. |
| S27 | [Request: multiple backlogs / folders](https://roadmap.sunsama.com/improvements/p/create-multiple-backlogs-or-folderssections-in-backlog) | [C] | n.d. |
| S28 | [Request: auto-reschedule based on actual duration](https://roadmap.sunsama.com/improvements/p/auto-reschedule-based-on-actual-task-duration) · [Request: auto-reschedule delays the start](https://roadmap.sunsama.com/improvements/p/auto-reschedule-delays-the-start) | [C] | n.d. |

#### Motion

| ID | Source | Grade | Date |
|---|---|---|---|
| M1 | [How auto-scheduling works: behind the scenes](https://www.usemotion.com/help/time-management/auto-scheduling/reference-auto-scheduling/how-auto-scheduling-works-behind-the-scenes) | [O] | n.d. |
| M2 | [What auto-scheduling considers](https://www.usemotion.com/help/time-management/auto-scheduling/reference-auto-scheduling/what-auto-scheduling-considers) | [O] | n.d. |
| M3 | [Reference: auto-scheduling](https://www.usemotion.com/help/time-management/auto-scheduling/reference-auto-scheduling) | [O] | n.d. |
| M4 | [Task scheduling FAQ](https://www.usemotion.com/help/project-management/task/task-scheduling-faq) | [O] | n.d. |
| M5 | [Task states and task types](https://usemotion.com/help/project-management/task/reference-tasks/task-states-and-task-types) | [O] | n.d. |
| M6 | [Understanding free, busy and fixed tasks and events](https://help.usemotion.com/product-and-feature-guides/calendar/events/tasks-versus-events/understanding-free-busy-and-fixed-tasks-and-events) | [O] | n.d. |
| M7 | [Understanding the Resolve Issues box](https://help.usemotion.com/product-and-feature-guides/calendar/tasks/understanding-the-resolve-issues-box) | [O] | n.d. |
| M8 | [Five essential troubleshooting tips for task scheduling](https://help.usemotion.com/settings-and-troubleshooting/troubleshooting/five-essential-troubleshooting-tips-for-task-scheduling) | [O] | n.d. |
| M9 | [Project stages and blockers](https://www.usemotion.com/help/project-management/projects/reference-projects/project-stages-and-blockers) | [O] | n.d. |
| M10 | [Introducing project workflow templates](https://www.usemotion.com/blog/project-workflow-templates) | [O] | n.d. |
| M11 | [Manage dependencies with multiple blockers](https://www.usemotion.com/blog/manage-dependencies-with-multiple-blockers-in-tasks) | [O] | Apr 2025 |
| M12 | [Kanban view: a deep dive](https://help.usemotion.com/workspaces-projects-and-workflows/kanban-view-a-deep-dive) | [O] | n.d. |
| M13 | [Reference: views](https://www.usemotion.com/help/project-management/views/reference-views) | [O] | n.d. |
| M14 | [Supported calendar providers](https://www.usemotion.com/help/time-management/all-things-calendars/reference-all-things-calendars/supported-providers) | [O] | n.d. |
| M15 | [Differences between Google, Microsoft and iCloud calendars](https://help.usemotion.com/all-things-calendars/understanding-differences-between-google-microsoft-and-icloud-calendars) | [O] | n.d. |
| M16 | [Concept: AI Notetaker](https://usemotion.com/help/knowledge-management/ai-notetaker/concept-ai-notetaker) | [O] | n.d. |
| M17 | [AI Employees (Beta)](https://www.usemotion.com/ai-employees) | [O] marketing | n.d. |
| M18 | [ZoomInfo: Motion API review 2026](https://pipeline.zoominfo.com/sales/motion-api-review) | [T] | 2026 |
| M19 | [Morgen: Motion pricing 2026](https://morgen.so/blog-posts/motion-pricing) | [T] competitor | 2026 |
| M20 | [Carly: Motion pricing](https://www.usecarly.com/blog/motion-pricing/) | [T] | 2026 |
| M21 | [Recurring tasks](https://help.usemotion.com/product-and-feature-guides/calendar/tasks/recurring-tasks) · [Recurring tasks and events](https://help.usemotion.com/tasks-events-and-auto-scheduling-101/recurring-tasks-and-events) | [O] | n.d. |
| M22 | [ClickUp: Motion review](https://clickup.com/blog/motion-review/) | [T] competitor | n.d. |
| M23 | [Tasks not scheduling where you expect](https://help.usemotion.com/tasks-events-and-auto-scheduling-101/tasks-not-scheduling-where-you-expect-heres-whats-actually-happening) | [O] | n.d. |
| M24 | [Lifestack: Motion app review 2026](https://lifestack.ai/blog/motion-app-review) | [T] competitor | 2026 |
| M25 | [How Motion's predictive system helps you adjust projects](https://help.usemotion.com/workspaces-projects-and-workflows/how-motions-predictive-system-helps-you-adjust-projects-on-the-fly) | [O] | n.d. |
| M26 | [Regular projects vs workflow projects](https://help.usemotion.com/workspaces-projects-and-workflows/projects-in-motion-regular-projects-vs-workflow-projects) | [O] | n.d. |

#### Trello

| ID | Source | Grade | Date |
|---|---|---|---|
| T1 | [Trello Planner](https://support.atlassian.com/trello/docs/trello-planner/) | [O] | n.d. |
| T2 | [Atlassian Community: Planner plan availability](https://community.atlassian.com/forums/discussion/comment/3089314) | [C] | "February" (year not shown) |
| T3 | [How To Trello: making sense of Trello's calendars](https://trello.substack.com/p/making-sense-of-trellos-calendars) | [T] | n.d. |
| T4 | [Creating and managing Butler commands](https://support.atlassian.com/trello/docs/creating-and-managing-butler-commands/) · [Butler automation blog](https://www.atlassian.com/blog/trello/butler-power-up-trello-automation) | [O] | n.d. |
| T5 | [Trello guide: advanced features](https://trello.com/guide/enterprise/advanced-features) | [O] | n.d. |
| T6 | [Trello REST API rate limits](https://developer.atlassian.com/cloud/trello/guides/rest-api/rate-limits/) | [O] | n.d. |
| T7 | [API rate limits (support)](https://support.atlassian.com/trello/docs/api-rate-limits/) | [O] | n.d. |
| T8 | [Trello views](https://trello.com/views) | [O] marketing | n.d. |
| T9 | [Revamped pricing and Power-Up news](https://www.atlassian.com/blog/trello/revamped-pricing-and-power-up-news) | [O] | n.d. |
| T10 | [Trello Premium free trial](https://trello.com/free-trial) | [O] marketing | n.d. |
| T11 | [Trello Free plan collaborator limits (JP)](https://www.atlassian.com/ja/blog/trello-new-collaborator-limits) | [O] | 2024 |
| T12 | [Analytics Insight: Trello pricing 2026](https://www.analyticsinsight.net/apps/how-much-does-trello-cost-in-2026-plans-pricing-explained) · [TemperStack](https://www.temperstack.com/plans/trello/) | [T] | 2026 |
| T13 | [Atlassian Community: Feature Focus 2026 Vol. 9 (July)](https://community.atlassian.com/forums/Customer-Success/Feature-Focus-2026-Vol-9-July/bc-p/3276165) | [C] official-community | Jul 2026 |
| T14 | [New views switcher and Table view](https://www.atlassian.com/blog/trello/new-views-switcher-and-table-view) | [O] | n.d. |
| T15 | [Workspace views and dashcards](https://www.atlassian.com/blog/trello/trello-workspace-views-dashcards) | [O] | n.d. |
| T16 | [Toolworthy: Trello alternatives after Inbox/Planner/AI pivot](https://www.toolworthy.ai/blog/trello-alternatives) · [CostBench hidden costs](https://costbench.com/software/project-management/trello/hidden-costs/) | [T] competitor | 2026 |

#### Nextcloud Deck

| ID | Source | Grade | Date |
|---|---|---|---|
| D1 | [nextcloud/deck README](https://github.com/nextcloud/deck/blob/main/README.md) | [P] | `main`, read 2026-10-29 |
| D2 | [Deck user documentation (EN)](https://github.com/nextcloud/deck/blob/main/docs/User_documentation_en.md) | [P] | `main` |
| D3 | [Deck REST API reference](https://github.com/nextcloud/deck/blob/main/docs/API.md) | [P] | `main` (API 1.0, 1.1; 1.2 "unreleased") |
| D4 | [Deck CHANGELOG](https://github.com/nextcloud/deck/blob/main/CHANGELOG.md) | [P] | latest entry 1.16.0-beta.1 |
| D5 | [`appinfo/info.xml`](https://github.com/nextcloud/deck/blob/main/appinfo/info.xml) — `main` is `2.0.0-dev.0`, Nextcloud 36 | [P] | `main` |
| D6 | [Nextcloud forum: Deck, a kanban-like app](https://help.nextcloud.com/t/deck-a-kanban-like-organization-app/8323) · [Linking cards with Outlook tasks](https://help.nextcloud.com/t/linking-cards-with-outlook-tasks/132565) | [C] | n.d. |
| D7 | [Blog: moving to-do lists into Nextcloud](https://tiny.write.as/tompurl/moving-my-todo-lists-from-org-mode-into-nextcloud) | [C] | n.d. |

#### Calendar protocols and APIs

| ID | Source | Grade |
|---|---|---|
| C1 | [Microsoft Graph subscription resource](https://learn.microsoft.com/graph/api/resources/subscription) — Outlook event subscriptions max 10,080 min | [O] |
| C2 | [Graph lifecycle notifications](https://learn.microsoft.com/graph/change-notifications-lifecycle-events) | [O] |
| C3 | [Graph change notifications overview](https://learn.microsoft.com/en-us/graph/webhooks) | [O] |
| C4 | [Google Calendar extended properties](https://developers.google.com/workspace/calendar/api/guides/extended-properties) | [O] |
| C5 | [Nylas: Google Calendar sync tokens and 410](https://cli.nylas.com/guides/google-calendar-api-sync-tokens) | [T] |
| C6 | [Google Calendar events.import](https://developers.google.com/calendar/api/v3/reference/events/import) — `id` vs `iCalUID` | [O] |
| C7 | [OneCal: integrating iCloud Calendar](https://www.onecal.io/blog/how-to-integrate-icloud-calendar-api-into-your-app) | [T] |
| C8 | [2Do: sync with iCloud CalDAV](https://www.2doapp.com/docs/ios/sync-with-icloud-caldav) | [T] |
| C9 | RFC 4791 (CalDAV), RFC 6578 (WebDAV sync-collection), RFC 5545 (iCalendar), RFC 6638 (CalDAV scheduling) | [K] |
| C10 | [Google Calendar push notifications guide](https://developers.google.com/workspace/calendar/api/guides/push) — channels expire and must be re-created | [K] |

### Contradictions found between sources

| Topic | Contradiction | Treatment in this blueprint |
|---|---|---|
| Sunsama price | $20/$25 (Morgen, Apr 2026) [S20] vs $17/$22 (Techpresso, Oct 2026) [S21] vs $16/$20 (older listings) | Report the range and do not rely on it. Pricing does not drive any requirement |
| Sunsama MCP / Sunny status | Beta labels reportedly removed 28 Aug 2026 [S22] vs earlier forum reply calling it beta | Treat as ✅ Available with ❓ on exact plan inclusion |
| Sunsama iCloud vs CalDAV | Help centre lists iCloud as supported [S11]; the public roadmap still carries an open CalDAV/iCloud request [S12] | iCloud ✅, generic CalDAV/Nextcloud 📋. This is a gap Fluid already fills |
| Motion priority order | The "hierarchy" lists ASAP > High > Medium > Low, but the same docs say hard deadlines can break working hours and that scheduling "balances" factors rather than following a linear rule [M1][M3] | Treat Motion's precedence as underspecified. Our engine publishes a strict, documented order (§13) |
| Motion lock semantics | "Locked … won't be controlled by the algorithm" yet "will only consider rescheduling this task if you don't complete it" [M5][M6] | Locks in our engine never move. A missed locked session becomes a *proposal*, never an automatic move (§13.D) |
| Motion API rate limit | 12 req/min individual (ZoomInfo) vs "12 req/3 min" (community README) [M18] | ❓. Not load-bearing |
| Motion pricing / "AI Employees" tier | Some sources say the credit grid was dropped; others list a $49 AI Employee tier [M19][M20] | ❓. Not load-bearing |
| Trello views on Calendar | Older articles put Calendar on Business Class; current marketing says additional views need Premium or Enterprise [T8] | 💳 Premium |
| Nextcloud Deck calendar | Older blog lists due-date calendar as missing; changelog shows "Show cards in calendar/tasks app and make them available through CalDAV" (#1545) and a per-board calendar toggle (#4622) [D4] | ✅ read-only CalDAV exposure, with writes ❓/partial [D6] |
