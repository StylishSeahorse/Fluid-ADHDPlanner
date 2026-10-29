# 0001 — Phase 0 decisions, and how Phase 1 was built

Status: accepted, 29 October 2026. Context: [blueprint §24](../blueprint/06-delivery.md#24-unresolved-questions-assumptions-and-decisions-requiring-input).

## Decisions taken with the blueprint's defaults

| # | Decision | Taken |
|---|---|---|
| D-01 | Product identity | ADHD-first in tone and defaults; no feature gated on it |
| D-02 | Who is scheduled | One owner per card (`tasks.userId` today); collaborators come with teams in Phase 5 |
| D-03 | Where the day commitment lives | On the task (`plannedFor`), as before |
| D-04 | Default scheduling mode | Unchanged — the existing autonomy setting |
| D-06 | Completion vs columns | Completion is independent; columns react to it |
| D-09 | Mobile | PWA first (shipped before this phase) |
| D-10 | Search | Postgres, through Prisma filters |
| D-11 | Label scope | Workspace-wide |
| D-12 | Deleting a column with cards | The user must choose where the cards go |

**Still open, and the owner's to make:** D-07 (licence) and D-08 (managed hosting).

## Where Phase 1 deliberately differs from the blueprint

Each of these is a simplification that keeps the rest of the app working
unchanged. Each can be extended later without a breaking migration.

1. **One board per project** (`boards.projectId` is unique), not 1..n. A new
   board creates its project, and renaming one renames the other. Nobody has
   asked for two boards on one project yet. Dropping the unique index later
   is not a breaking change.

2. **Boards are set up lazily, not by a SQL backfill.** `ensureBoards()`
   (`apps/web/src/server/services/boards.ts`) creates the personal workspace,
   the Inbox, and a board per project, and places every top-level task in the
   column matching its status. It runs whenever a board screen loads and
   after any task is created. It is idempotent and serialised per user with
   an advisory lock. This avoided generating ids in SQL, and means tasks
   captured anywhere (Today, braindump, AI) land on a board without every
   creation path knowing about boards.

3. **A column's category drives the existing `TaskStatus`.** The scheduler,
   My Day and the week board read `status` and needed no change:

   | Column category | Status |
   |---|---|
   | Backlog | `BACKLOG` (not scheduled) |
   | To do | `READY` |
   | Doing | `IN_PROGRESS` |
   | Done | `DONE` (completed) |

   Moving a card to Backlog also clears its day commitment.

4. **Deleted cards are snapshots, not soft-deleted rows.** `trashed_cards`
   holds the card, its subtasks, checklist, comments and labels as JSON for
   30 days. A `deletedAt` flag would have needed a filter in every query in
   the app. One forgotten filter would schedule a deleted task. Scheduled
   sessions are not restored; the next replan places the work again.

5. **One checklist per card** (Deck's model), not several named checklists.

6. **No row-level security yet.** Every board query checks workspace
   membership in the service layer (`loadBoard`, `loadCard`). RLS lands with
   multi-member workspaces in Phase 5, when it starts protecting against
   something.

## Deferred from Phase 1

These are planned, not dropped. They are listed in the roadmap status:
attachments, a Table view, board templates beyond the default columns,
real-time updates between open tabs, the public REST API, and saved views.
