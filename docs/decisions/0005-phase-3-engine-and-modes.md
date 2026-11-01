# 0005 — Phase 3: engine hardening and scheduling modes

Status: accepted, 1 November 2026. Context: [blueprint §13](../blueprint/03-scheduler.md),
[roadmap Phase 3](../blueprint/06-delivery.md#phase-3--engine-hardening-and-modes).

## What was built

All the MVP (●) items, and the optional (○) items behind settings:

| Item | Where |
|---|---|
| ● One eligibility function (REQ-SCH-ELIG) | `apps/web/src/server/services/eligibility.ts` |
| ● "Why here?" on every session (REQ-SCH-EXPLAIN) | Engine `BlockExplanation`, text in `explain.ts`, stored on each session; Today, Week, card panel |
| ● Plan diff polish and a resolve tray | `components/scheduling.tsx` on Today |
| ● "Schedule my day" (REQ-SCH-DAY) | Today's main button |
| ● Missed pinned session → recovery proposal (REQ-SCH-LOCK) | `services/missed.ts`, five-minute sweep |
| ● Deadline kind, soft or hard | Card panel, task editor, API |
| ● Post-condition checks + a DB exclusion constraint | `checkPlanInvariants` (throws); `scheduled_blocks_no_overlap` |
| ● Stale-calendar downgrade | Gate: Hybrid/Automatic act as Assisted after 6 h without a sync |
| ● Golden tests for the four worked examples, property suite | `golden.test.ts`, `property.test.ts` (10,000 cases) |
| ○ Urgent preemption, hard-deadline repair, overtime proposals | `plan.ts` |
| ○ Manual / Assisted / Hybrid / Automatic, disruption score, always-ask list | `gate.ts`; Settings → Scheduling |
| ○ Horizon (1–90 days), daily work cap, preferred time of day, project importance | Settings, card panel, board options |

Replans now also run on their own. A schedule-affecting mutation uses
`replanAfter(trigger)`, which queues a debounced replan (`jobs/replan-jobs.ts`);
calendar syncs that bring changes do the same. Manual mode skips all of this.

## Decisions

1. **The gate is a pure function next to the engine.** Modes, disruption and
   the always-ask list live in `@fluid/core`, not the orchestrator. That makes
   AC-3.3 (no mode applies an always-ask change) one test per item per mode,
   rather than an integration scenario.

2. **Always-ask makes the whole plan a proposal.** The gate could apply the
   harmless part of a plan and ask about the rest. It doesn't: a half-applied
   plan whose other half is pending is hard to read and harder to undo.

3. **An unchanged input leaves no trace (AC-3.4).** The gate returns DISCARD
   for a plan whose diff is empty, or only resizes smaller than the grid. No
   plan version is written, but the resolve tray's issues are refreshed on the
   latest version, so they stay honest.

4. **Concurrency: an epoch, plus a lock around the write.** Inputs are read and
   the engine run outside any transaction; an AI hint can take seconds. The
   write takes `pg_advisory_xact_lock` and checks `users.planEpoch`. If anyone
   changed the plan in between, the replan starts again from fresh inputs
   (twice at most).

5. **The database refuses double-booking, but a person may override.**
   `scheduled_blocks_no_overlap` (btree_gist) rejects two ACCEPTED sessions of
   one owner at once. Sessions a person deliberately put over other work carry
   `overlapAck` and are exempt: dragging one in the app, moving it in their own
   calendar app, undoing a change. Overlaps already in the data are marked
   acknowledged by the migration, never deleted. A trigger fills the owner, so
   no code path can forget it. Accepting a stale proposal that now overlaps
   rejects it and queues a fresh one, rather than forcing it in.

6. **Auto-accept is opt-in.** `autoAcceptSeconds` defaulted to 30 but nothing
   ever implemented the countdown. With replans now running unattended,
   honouring it would silently apply plans in Assisted mode, which promises
   nothing reaches the calendar until accepted. The default is now 0, existing
   30s were reset, and Settings offers 30 s / 2 min.

7. **Overtime hugs the working day, not the grid.** Proposals start the moment
   the buffer after work ends (17:10, not 17:15). They reach at most three
   hours past working hours and avoid quiet hours. A split task takes a shorter
   gap rather than none. Approving one creates pinned sessions; nothing else
   ever places work out of hours.

8. **Overtime only within `[now, deadline)`.** The spec's example 4 follow-up
   proposes 17:00–18:30 for a task due at 17:00, which contradicts its own
   rule. The rule wins: that case is placed after the deadline and flagged.

9. **A missed session is marked, not moved, and its recovery always asks.** Even
   in Manual mode. Often the work has already been planned elsewhere, because
   an ended session no longer covers it. Then the recovery replan changes
   nothing and is dropped; the tray still lists the missed session with "Let it
   go".

## Bugs found and fixed along the way

- **The AI ordering hint had no effect.** The engine re-sorted every task by
  its own key, ending in the task id, so the hint's order was discarded. It is
  now an explicit tier (`aiHintRank`) inside priority and slack.
- **The diff matched the wrong sessions.** The orchestrator numbered previous
  sessions across all tasks, but the diff matches by task and session number,
  so moves showed as remove-plus-add.
- **Pinned work was double-booked.** A task with a pinned session still had
  its full remainder scheduled again. Pinned minutes still ahead now count as
  placed.
- **Accepting a plan deleted history.** Earlier sessions of today, including
  ones already over, were wiped. Past sessions and the one being worked now are
  kept.
- **Sessions too close together.** Buffers were reserved only after a
  session. Work placed before an existing session could end inside its buffer,
  and the next replan then shifted it. Now they are reserved on both sides.
- **Spilled sessions were re-spilled on every replan.** Work the engine had
  placed off its committed day was never kept, so each replan moved it again.
  Each session now records the commitment it was placed for, and is kept while
  that is unchanged.
- **Gaps were treated inconsistently.** A leftover smaller than a real session
  could fill a gap the first plan rightly skipped. The daily cap could make
  the hard-deadline filler skip a gap a later replan used.

The last three were found by the property suite's idempotence check:
re-planning with a plan as the previous plan must change nothing.

## Performance

`toLocal` (Intl formatting) was 80% of scheduling time. Zone offsets change
only on 15-minute boundaries in UTC, so the offset is now cached per zone and
quarter-hour and the rest is arithmetic. Scheduling is about 6× faster, and
300 tasks × 14 days × 200 events plans in roughly 70 ms (AC-3.5: < 500 ms).

## Verified

- Unit: 501 tests.
  - Golden tests reproduce §13.G exactly, including the adaptive re-chunking
    and the 17:10–17:35 overtime of example 2's variant, and the minimal
    release in example 4.
  - 10,000 random inputs across five zones and DST weeks: no hard-constraint
    violation, every minute accounted for, deterministic, idempotent.
  - Gate: every always-ask item in every mode; DST; performance.
- Database: the exclusion constraint refuses an overlapping accepted session,
  allows an acknowledged one, and the owner trigger fills itself.
- In a browser against the real database and worker:
  - Assisted "Schedule my day" → proposal → accept.
  - "Why here?" text on sessions.
  - Hybrid applies a small change on its own: banner → Undo all → the
    follow-up asks.
  - A hard deadline that cannot fit → an overtime offer that asks even in
    Hybrid → approving it books pinned sessions after work.
  - The resolve tray; card fields.
  - A missed pinned session → the sweep marks it → a recovery proposal asks.
- Production build.

## Not done

- Asking how much longer a task needs when its timer stops after overrunning
  (§13.B.10 step 2). Overruns still feed the estimation coach.
- "Pull forward" after early completion (§13.B.11).
- The optional CP-SAT "optimise week" mode (§13.E).
- A replay harness for recorded inputs.
- Daily rollover runs in the five-minute sweep, at about 00:05 local, not as a
  per-user scheduled job.
