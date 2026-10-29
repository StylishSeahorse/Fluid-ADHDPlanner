# 13. Scheduling Engine Design

The engine is the part of the product that must be right. This section specifies it
at implementation level, starting from what already exists in
`packages/core/src/scheduler/plan.ts` [F4] and stating every proposed change as a
change.

**Status key used below:**
- **[exists]** is implemented in `plan.ts` or `types.ts` today (per reading the code; not re-tested in this session).
- **[change]** modifies existing behaviour.
- **[new]** is not implemented.

---

## 13.0 Principles

1. **Pure and deterministic.** `plan(input) → Plan` reads no clock, database or network. `now` is an input. Ties break by id. **[exists]**
2. **Hard constraints are never violated automatically.** Soft goals are optimised in a published, strict order. **[exists, extended]**
3. **Stability beats optimality.** A still-valid session stays where it is unless something with a higher claim needs that time. **[exists; preemption is a change]**
4. **Every output is explained** in plain language: placements, failures, spills and moves. **[exists for failures and spills; per-block "why here" is new]**
5. **The engine computes; the orchestrator decides what to apply.** Modes, approval, undo and calendar writes live outside the pure function. **[exists in part: `PlanVersion`, `AiAction`]**
6. **AI may propose an ordering hint; the engine applies every constraint** (F2 §3). **[exists]**

---

## 13.A Scheduling inputs

| Input | Required? | Source | Default when absent | Used for |
|---|---|---|---|---|
| `now` | **Mandatory** | Orchestrator clock | — | Floor for all placement; past blocks ignored |
| `timeZone` (IANA) | **Mandatory** | `users.time_zone` | `UTC` (onboarding sets the browser zone) | Wall-clock rules, day boundaries, DST |
| `horizonDays` | **Mandatory** | User setting | 14 **[change: README implies a fixed value]** | Availability window (max 90) |
| Working hours (weekly rules) | **Mandatory** | `working_hours` | Mon–Fri 09:00–17:00 | Hard constraint |
| Task: id, remaining minutes | **Mandatory** | `tasks.estimate_minutes − logged` | Default estimate (30 min) and an `estimateAssumed` flag **[new flag]** | Chunking, capacity |
| Task: priority | **Mandatory** (has default) | `tasks.priority` | MEDIUM | Ranking |
| Task: deadline + kind | Optional | `tasks.deadline`, `deadline_kind` **[new column]** | none / SOFT | Ranking, relaxation, risk |
| Task: earliest start | Optional | `tasks.earliest_start` | none | Hard constraint |
| Task: dependencies | Optional | `task_dependencies` | none | Hard constraint (ordering) |
| Task: committed day | Optional | `tasks.planned_for` → local-day interval | none | Strongest soft constraint |
| Task: split rules | Optional | `is_splittable`, `min_chunk`, `max_chunk` | true, 25, 90 | Chunking |
| Task: energy | Optional | `tasks.energy` | MEDIUM | Soft slot matching |
| Task: project importance | Optional | `projects.importance` **[new, 0–2]** | 1 | Tie-break after priority **[new]** |
| Task: preferred window | Optional | `tasks.preferred_window` **[new: MORNING / AFTERNOON / EVENING / custom]** | none | Soft, relaxed like energy |
| Task: fixed time | Optional | A pinned session | — | It is a pinned block, not a task input |
| Busy intervals | **Mandatory** (may be empty) | External events with `transparency=BUSY`, `status≠CANCELLED`, on selected calendars, plus pinned sessions | `[]` | Hard constraint |
| Protected time | Optional | `protected_times` (routines, buffers, live hyperfocus) | none | Hard constraint, outranks all |
| Personal-area time | Optional | Sessions of tasks in areas with `countsTowardCapacity=false` | — | Occupies time; not counted as work (F2 §9) |
| Energy windows | Optional | `energy_windows` | none | Soft |
| Buffer minutes | Optional | `user_preferences.buffer_minutes` | 10 | After each placed block |
| Slot granularity | Optional | preference | 15 | Alignment |
| Max daily work minutes | Optional | `user_preferences.max_daily_work_minutes` **[new]** | none (working hours bound it) | A cap below working hours ("I only do 5 h of deep work") |
| Previous plan | Optional | Accepted, unpinned blocks in force | none | Stability |
| AI ordering hint | Optional | `validateScheduleSuggestion` output | none | Tie-break *within* the same rank tier only **[change: make the tier explicit]** |
| User rules | Optional | `scheduling_rules` **[new, P4]**, e.g. "no deep work on Fridays", "label:admin only after 15:00" | none | Compiled into per-task allowed windows, treated like `preferred_window` (soft) or `allowed_window` (hard) per rule |

**Status and completion are filters, not inputs.** Completed, archived, deleted and
blocked (prerequisite incomplete *and* not schedulable within the horizon) tasks are
excluded before `plan()` is called (13.B.12).

### Eligibility filter (orchestrator, before `plan()`) **[new as a single function]**

A task is passed to the engine for user *u* if **all** of these hold:

1. `owner_id = u`.
2. `completed_at IS NULL`, `archived_at IS NULL`, `deleted_at IS NULL`, and the project/board is not archived.
3. Effective `auto_schedule` = task override ?? column flag ?? user default (`true` in Assisted/Auto/Hybrid, `false` in Manual) **is true**, *or* the task is committed to a day inside the horizon (a day commitment always makes it eligible for "Schedule my day").
4. The column's status category is not `BACKLOG` *unless* the task is committed to a day.
5. Remaining minutes > 0.

Pinned sessions of *any* task (including ineligible ones) are always passed as busy time.

---

## 13.B Scheduling behaviour

### B.1 Finding available time **[exists]**

```
free = working_hours(horizon, tz)          // wall-clock rules expanded per local day (DST-safe)
     − protected_times                      // inviolable
     − busy external events
     − pinned sessions
     − [now floor]                          // nothing before `now`
```

All interval arithmetic is half-open `[start, end)` (`intervals.ts`). Expansion of
weekly rules happens per *local* date, then converts to UTC instants, so "09:00–17:00"
stays 09:00–17:00 local across a DST change (`time/zoned.ts`, Europe/London tests per F1).

**[new] `maxDailyWorkMinutes`:** after placement, a day whose placed work minutes
would exceed the cap has its remaining free slots treated as unavailable for further
work placement. This is implemented as a per-day counter in the placement context.

### B.2 Ranking competing tasks

Tasks are topologically sorted (Kahn) and, among those ready at each step, ordered
by a **lexicographic key**. Lexicographic, not weighted, so the order is explainable
in one sentence per comparison.

| Rank | Key component | Direction | Status |
|---|---|---|---|
| 1 | Committed day (start of day) | earlier first; uncommitted last | [exists] |
| 2 | **Hard deadline at risk**: `deadline_kind=HARD` and `slack < riskThreshold` (default: 2 × remaining minutes) | at-risk first | **[new]** |
| 3 | Priority (URGENT > HIGH > MEDIUM > LOW) | higher first | [exists] |
| 4 | Project importance | higher first | **[new]** |
| 5 | Slack = minutes(now → deadline) − remaining minutes | less first (no deadline = 1 year) | [exists] |
| 6 | AI ordering hint position (if present and validated) | earlier first | **[change: explicit tier]** |
| 7 | `created_at` | older first | **[new]** (fairness: stops new work starving old) |
| 8 | Task id | lexical | [exists] |

*Why priority outranks slack:* this is existing behaviour and is kept deliberately.
Priority is a human statement. Slack is arithmetic. Component 2 is the safety valve
that stops a LOW-priority hard deadline from being starved by a pile of HIGH-priority
work.

### B.3 Allocating time before deadlines **[exists]**

Each task's chunks are placed earliest-first from `notBefore` (max of `now`,
`earliest_start`, and the end of its prerequisites' last session), trying in order:

1. Inside the committed day **and** before the deadline, with energy matched; then with energy relaxed.
2. Before the deadline (day relaxed). If this succeeds after (1) failed, the minutes are recorded as **spilled**.
3. After the deadline (deadline relaxed). This records `DEADLINE_UNREACHABLE`.

**[new] Step 2a, preferred window:** `preferred_window` is tried together with energy.
Both are relaxed together before the day is relaxed.

**[new] Hard-deadline repair pass** (13.B.6). Runs only if step 3 was needed for a
HARD-deadline task.

### B.4 Never outside permitted hours **[exists]**

Working hours are part of `free`. The only out-of-hours placement is an **overtime
proposal** (13.B.12), which is a separate output (`Plan.overtimeProposals`), never a
block in `Plan.blocks`. **[new output]**

### B.5 Detecting overcommitment **[exists: capacity.ts; new: per-plan summary]**

For each local day in the horizon:

```
available_d  = |free_d| (before placement)
committed_d  = Σ remaining minutes of tasks with planned_for = d (work areas only)
scheduled_d  = Σ placed block minutes on d (work areas only)
overcommitted_d = committed_d > available_d − buffers_d
```

`Plan.days[d] = {available, committed, scheduled, overcommitted, spilledMinutes}`
**[new field]** drives the capacity meter and the "≈40 min over" copy. Overcommitment
never blocks a commitment (REQ-DAY-03).

### B.6 Handling dependencies **[exists; repair new]**

- A task is placed only after all prerequisites' sessions have ended (`finishedAt`).
- A prerequisite that could not be placed makes its dependants `BLOCKED_BY_DEPENDENCY`.
- Cycles are reported (`DEPENDENCY_CYCLE`) and are also rejected at write time (REQ-TASK-DEP).
- A prerequisite *not in the input* (completed, or owned by someone else) does not constrain the task. **[change]** If the prerequisite belongs to another person and is incomplete, its latest *planned* session end (from that owner's current plan) is passed as `earliestStart`, and the explanation names the person. **[new, P5]**

**Hard-deadline repair pass** **[new]:** if a HARD-deadline task *T* ends up past its
deadline, then:

0. **Adaptive re-chunking.** Discard T's late chunks and re-chunk the unplaced minutes greedily into the free slots before the deadline that are ≥ `minChunk`, each capped at `maxChunk`. Even chunking (`chunkTask`) is optimised to avoid stubs, but a fixed even size cannot use short slots. For a hard deadline, fitting matters more than evenness.
1. If T is still late, release lower-ranked blocks:

```
candidates = placed, unpinned, non-retained-by-commitment blocks of tasks ranked BELOW T
             that lie within [notBefore(T), deadline(T)]
for b in candidates sorted by (rank ascending, start descending):   // lowest-ranked, latest first
    tentatively release b
    if T's unplaced chunks now fit before deadline: commit releases; re-place released tasks normally
    stop when T fits or candidates exhausted
if T still does not fit → emit overtime proposal (B.12)
```

The repair is bounded (it only touches lower-ranked blocks in one window) and
deterministic.

### B.7 Placing around fixed appointments **[exists]**

External busy events, protected time and pinned sessions are subtracted from `free`.
A session may end exactly when a meeting starts (half-open intervals). The trailing
buffer is consumed only when there is room, and is never inserted *into* a meeting.

### B.8 A new urgent task **[change: preemption]**

Today the stability pass retains every still-valid previous block *before* new work
is placed. So an urgent task can find no room even though lower-ranked flexible work
occupies the time it needs. Proposed **urgent preemption**:

> When a task with priority URGENT, or a HARD deadline at risk, has unplaced chunks
> that would fit before its deadline if retained blocks of lower-ranked, non-committed,
> unpinned tasks were released, release the minimal set of those blocks (lowest rank
> first, latest start first) and re-place them after the urgent task.

Retained blocks of tasks **committed to that day** are released only if nothing else
works, and that always counts as disruptive (13.C).

### B.9 Rescheduling after interruptions **[exists in part: flow.ts]**

An interruption is any of: a new external event overlapping a session, the user
marking a session skipped, a running timer on another task, or an "I got pulled
away" action.

- **Within the day (live):** `flow.ts` re-projects the *display* times of the rest of today's sessions from the clock, without writing to the calendar.
- **Persisted:** a replan runs with trigger `interruption`. The interrupted session's unworked remainder becomes remaining minutes on the task. The stability pass keeps every other valid block.

### B.10 Tasks that take longer than estimated **[exists in part]**

1. While running past the session end, flow mode shows "running n min over" and the next fixed commitment.
2. On stop, ask for the remaining time (Done / +15 / +30 / +60 / custom).
3. If extra time is needed, `remaining = answer`, and a replan runs with trigger `overrun`. If no answer is given, use `max(15, 25% of original estimate)` and mark it assumed.
4. A `time_estimate_samples` row is recorded at completion (existing estimation coach).
5. The estimate is **never** edited automatically. The coach's adjusted estimate is shown beside it.

### B.11 Tasks completed early **[new orchestration; Sunsama precedent S3]**

On completion during or before a session:
- Truncate the current session at `now` and record actual minutes.
- Delete future unpinned sessions of that task.
- Trigger a replan with trigger `completed_early`.

The freed time is filled by the normal algorithm: retained blocks stay put. **Pull-
forward is a preference, not automatic:** with `pullForward=true` (default in
Automatic, off in Hybrid and Assisted) the stability pass is told to ignore retained
blocks on *today* only, so today's remaining work compacts towards now.

### B.12 Overdue and unschedulable tasks **[exists; overtime new]**

| Outcome | Condition | Reported as | Offered actions |
|---|---|---|---|
| Spilled | Committed-day placement failed, placed elsewhere | `Plan.spilled` → card shows `→ Fri` | Keep · Move commitment · Reduce scope (split card) |
| Deadline unreachable | Placed (fully or partly) after its deadline | `DEADLINE_UNREACHABLE` | Extend deadline · Lower others' priority · Split · **Overtime proposal** (HARD only, default) |
| No available time | Nothing fits in the horizon | `NO_AVAILABLE_TIME` | Extend hours for a day · Extend horizon · Defer · Reduce estimate |
| Blocked | Prerequisite unplaced | `BLOCKED_BY_DEPENDENCY` | Open the blocker |
| Cycle | — | `DEPENDENCY_CYCLE` | Remove a link |
| Beyond horizon | Earliest start after the horizon | `STARTS_AFTER_HORIZON` | none (informational) |
| Overdue | `deadline < now` and not completed | Still scheduled normally (slack negative = most urgent at its priority) | Same as unreachable |

**Overtime proposal [new]:** for a HARD-deadline task still short after repair,
compute candidate slots in `[now, deadline)` that lie outside working hours but not in
protected time, busy events or quiet hours, nearest to working hours first, up to the
shortfall. Emit them as `Plan.overtimeProposals[{taskId, intervals, minutes}]`. They
are **never** applied without an explicit approval, in any mode.

### B.13 Recurring tasks **[new]**

Only the *next* instance of a series exists as a task row (REQ-REC-NODUP). It is
scheduled like any task, with:
- `earliest_start` = instance local date at 00:00 (or the series' preferred time window), and
- `deadline` = end of the instance's date (SOFT) unless the series specifies otherwise.

For series that must happen at a fixed time, users should create a **routine**
(protected time, which exists today) or a pinned recurring session. That matches
Motion's own advice to use events for fixed-time routines [M21].

### B.14 Protecting locked sessions **[exists; semantics tightened]**

- Pinned sessions are passed as busy, so they are never moved, resized or deleted by the engine.
- A session becomes pinned when a human places it, drags it (in-app or in the external calendar, which existing sync treats as intent), resizes it, or rejects a proposed move of it.
- **A missed pinned session is not moved [change vs Motion M5].** At `end + grace (15 min)` with no timer and no completion, the session becomes `MISSED`. The orchestrator creates a **recovery proposal** ("You missed 'X' at 10:00. Find a new time?") that requires approval in every mode.

### B.15 Explaining placements **[new: per-block explanation]**

Each placed block carries a structured explanation, rendered to text by the UI:

```ts
interface BlockExplanation {
  rankFactors: Array<'committed_day' | 'hard_deadline_risk' | 'priority' | 'project_importance'
                     | 'slack' | 'ai_hint' | 'age'>;   // the factors that put it ahead of the next task
  bindingConstraints: Array<                          // why not earlier
    | { kind: 'now' } | { kind: 'earliest_start'; at: string }
    | { kind: 'dependency'; taskId: string; endsAt: string }
    | { kind: 'busy'; eventId: string } | { kind: 'protected'; label?: string }
    | { kind: 'working_hours' } | { kind: 'energy_mismatch_relaxed' }
    | { kind: 'committed_day' } | { kind: 'retained_from_previous_plan' }>;
  relaxed: Array<'energy' | 'preferred_window' | 'committed_day' | 'deadline'>;
}
```

The UI renders, for example: "Wednesday 10:00 because it's due Friday (HIGH priority), Tuesday is full
(Design review 13:00, Client call 15:00), and it has to follow 'Collect feedback',
which ends Tuesday 16:30."

---

## 13.C Rescheduling modes

### Mode definitions

| Mode | Engine runs on triggers? | Applies changes automatically? | Writes to external calendar | Maps to existing |
|---|---|---|---|---|
| **Manual** | Only on explicit "Schedule…" actions | Never. Proposals shown on request only | After explicit placement or accept | — (new: disables triggers) |
| **Assisted** *(default)* | Yes | No. Every plan is a proposal with diff. Optional auto-accept countdown | After accept | `PROPOSE_THEN_CONFIRM` + `autoAcceptSeconds` |
| **Hybrid** | Yes | Yes, if disruption ≤ threshold and no always-ask item; otherwise propose | After apply or accept | `AUTO_WITH_UNDO` + threshold |
| **Automatic** | Yes | Yes, everything except always-ask items | Immediately, with undo | `FULL_AUTO` |

**Always-ask items (all modes, including Automatic):**
- overtime proposals
- recovery of a missed pinned session
- moving a task off its committed day (spill created by a replan rather than by the initial commitment)
- deleting a session that has logged time
- any change to another person's calendar (P5)
- any change exceeding the per-pass cap

This mirrors the existing `NEEDS_CONFIRMATION` boundary that `FULL_AUTO` does not
override (F2 §6).

### Triggers

| Trigger | Debounce | Scope | Notes |
|---|---|---|---|
| Task created/edited (estimate, deadline, priority, dependencies, owner, auto-schedule) | 5 s per owner | owner | Coalesced |
| Card moved into/out of an `auto_schedule` or BACKLOG column | 5 s | owner | |
| Day commitment changed | 0 s (user is watching) | owner, that day first | |
| Task completed / un-completed | 0 s | owner | Completion releases sessions synchronously |
| Session skipped / missed | at detection | owner | Missed pinned = recovery proposal only |
| Timer overrun stop | 0 s | owner | |
| External event added/changed/removed overlapping the horizon | 30 s after sync batch | affected owners | Only if it overlaps a session or changes free time today/tomorrow by > 15 min |
| Working hours / protected time changed | 5 s | owner | Full horizon |
| Daily rollover | at local 00:05 | owner | Rebuild horizon; never moves commitments |
| Manual "Replan" | 0 s | owner | `fullReplan` option ignores stability |

### Disruption score (Hybrid) **[new]**

```
score = Σ_changes w(change) × m(trigger)

w(MOVED same local day)           = 1
w(MOVED to another day)           = 2
w(RESIZED)                        = 0.5
w(REMOVED accepted session)       = 2
w(ADDED)                          = 0          // adding into free time disturbs nothing
+2 if the original session starts within the next 60 min ("imminent")
+1 if the session's mirror event has attendees or was edited externally

m(trigger) = 0.5 if caused by the user's own action in the last 60 s, else 1

Hybrid auto-applies iff score ≤ hybridThreshold (default 4) AND no always-ask item AND
changes ≤ maxDailyReshuffles for each affected day.
```

Rejected or capped plans become proposals (Assisted behaviour). The threshold and
weights are user-visible in Settings → Scheduling → "How much can Fluid move without
asking?" as a 3-step slider (Cautious 2 / Balanced 4 / Relaxed 8).

### What may move, what must stay

| Item | Engine may move? |
|---|---|
| External events | **Never** (DB-enforced) |
| Protected time / routines | Never |
| Pinned sessions | Never (missed → proposal) |
| Sessions currently running (timer on) | Never |
| Sessions in the past | Never (history) |
| Accepted unpinned sessions | Yes, per mode |
| Proposed sessions | Yes, freely (superseded) |
| Day commitments (`planned_for`) | **Never**. Only humans set them. The engine reports spill |
| Deadlines, estimates, priorities | Never |

### Notifications, undo and history

- Every apply writes a `plan_versions` row (status ACCEPTED, `auto_applied=true` for Hybrid/Automatic) and `plan_changes` rows. **[exists + flag]**
- **Toast** (in-app) for auto-applied plans: one line summary plus [Undo all] [Details]. **Digest** (optional, P4): the first auto-apply of the day is pushed, later ones are batched hourly. Quiet hours are respected.
- **Undo:** per change (revert one line) and per plan (revert all). Undo is a *user decision*: a reverted session is re-created **pinned** at its old time, and a follow-up replan resolves knock-on conflicts as a proposal. History is kept for 90 days. The calendar mirror is reverted through the outbox with the same idempotency rules (§14).

---

## 13.D Safeguards

| Risk | Safeguard | Status |
|---|---|---|
| Infinite rescheduling loops | Engine is pure. The orchestrator runs it at most once per owner per debounce window, holding a **per-owner advisory lock** (`pg_try_advisory_xact_lock(hash(owner))`). Changes the engine itself causes (its own writes, sync echoes of its own events) are tagged `source=engine` and **never** count as triggers | new |
| Moving without meaningful improvement | Stability pass keeps valid blocks. A replan whose diff is empty or only RESIZED < granularity is discarded (no plan version) | exists + new discard rule |
| Thrash across replans | `maxDailyReshuffles` per day (default 3). Above it, further changes for that day become proposals. A task moved ≥3 times in 7 days triggers the existing avoidance check-in, never more moves | exists |
| Calendar sync feedback loops | Mirror events carry a deterministic iCalUID `fluid-<blockId>@fluid.local` and, on Google, a private extended property `fluidBlockId` [C4]. Inbound changes are compared against the last pushed version (etag/sequence). An inbound echo equal to what we pushed is a no-op | exists (UID), new (ext. prop) |
| Scheduling completed or blocked tasks | Eligibility filter (13.A). Completion deletes future unpinned sessions in the same transaction | new (single function) |
| Violating fixed appointments | Busy and protected time subtracted from `free`. Post-condition check: no block overlaps busy or protected (assertion in `plan()`; failing it throws, and the orchestrator alerts and discards) | exists + new assertion |
| Out-of-hours placement | Only via an overtime proposal requiring approval | new |
| Ignoring dependencies | Topological order and `finishedAt` constraint. Post-condition check | exists + new assertion |
| Silently overwriting manual decisions | Pins, day commitments and rejected moves are never altered. Rejections pin | exists + change |
| Duplicate calendar events | Outbox with unique `idempotency_key = blockId:version:op`. Deterministic iCalUID. On a create conflict, look up by UID and adopt | exists |
| Unexplained changes | Every plan change has a reason. Every block has an explanation. Activity log | exists + new |
| Concurrent replans (two triggers, two workers) | Advisory lock plus optimistic `plan_epoch` on the user. Applying a plan requires `plan_epoch` unchanged since its inputs were read; otherwise recompute | new |
| Interrupted replan (crash mid-apply) | Apply = one DB transaction (blocks + plan version + outbox rows). Calendar writes happen after commit from the outbox and are retried idempotently. Either the plan is entirely applied in Fluid or not at all | exists (outbox) |
| Integration failure | Engine never depends on provider availability. Busy data comes from the last good sync. If a calendar's last successful sync is > 6 h old, the plan is labelled "based on calendar data from 07:12" and Hybrid/Automatic downgrade to Assisted for that user until sync recovers | new |
| Mass deletion from a bad sync | Existing deletion circuit breaker: never mark events deleted without an explicit provider signal (contract suite) | exists |

---

## 13.E Scheduler architecture

### Approaches considered

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **Greedy constructive heuristic** (ranked list, earliest-fit, with stability and local repair) — *current* | Fast (ms), deterministic, every decision explainable in a sentence, trivially testable, works in-browser if needed | Not globally optimal; ranking errors cascade | **Keep as primary** |
| **Constraint programming / MILP** (OR-Tools CP-SAT, interval variables, no-overlap, precedence) | Optimal or near-optimal, handles complex rules | Opaque ("the solver decided"), harder to keep stable, heavier runtime (native deps or a service), non-trivial to explain | **Optional P3 "optimise week" mode**, run offline, its output fed back through the same validator and diff, and only accepted if it beats greedy on a published objective by a margin |
| **LLM decides times** | Natural-language preferences | Non-deterministic, unverifiable, injection-prone (F2 §3) | **Rejected** as decider. LLM may supply an ordering hint or translate preferences into structured rules |
| **ML duration prediction** | Better estimates | Needs data; must never silently change estimates | **Yes, advisory** (existing estimation coach); the engine uses the user's estimate |

### Objective (published, used by tests and by the optional optimiser)

Lexicographic, in this order:

1. Zero hard-constraint violations.
2. Minimise HARD-deadline misses (minutes late).
3. Minimise committed-day spill (minutes).
4. Minimise SOFT-deadline lateness, weighted by priority.
5. Minimise churn versus the previous plan (moved sessions, then moved minutes).
6. Maximise energy and preferred-window matches.
7. Minimise fragmentation (number of chunks).

### Where deterministic code is essential vs where AI adds value

| Deterministic (always) | AI (optional, advisory) |
|---|---|
| Availability, constraints, placement, validation of any proposal, applying changes, sync, undo | Ordering hint within a rank tier; NL → structured rule ("I prefer writing in the morning" → `preferred_window` rule for `label:writing`); task breakdown; explaining a plan in conversation; deadline-risk *narrative* |

### Runtime topology

```
 tRPC mutation / sync worker / cron
            │  emits DomainEvent (task.updated, event.synced, …)
            ▼
   ReplanQueue (BullMQ, jobId = "replan:<ownerId>", delay = debounce)   ← dedupes per owner
            │
            ▼
   ReplanWorker
     1. BEGIN; advisory lock(owner); read plan_epoch
     2. load inputs (eligible tasks, busy, pinned, rules, previous plan)
     3. plan = core.plan(input)                       ← pure, ms
     4. diff = core.diff(previous, plan)              ← plain-language reasons
     5. decision = gate(mode, diff, disruption, alwaysAsk)
     6. persist plan_version(+changes); if APPLY: upsert blocks, enqueue outbox ops
     7. bump plan_epoch; COMMIT
     8. publish realtime "plan.updated" to owner's sessions
   OutboxWorker → CalendarAdapter (idempotent) → SyncLog
```

Replanning frequency is event-driven, with a nightly 00:05 local rebuild. There is no
periodic polling replan.

---

## 13.F Pseudocode

### F.1 Orchestrator: handle a trigger

```text
function onDomainEvent(evt):
    if evt.source == 'engine' or evt.isEchoOfOwnWrite: return          // loop guard
    for owner in affectedOwners(evt):
        if modeOf(owner) == MANUAL and evt.kind not in {MANUAL_SCHEDULE, COMPLETION}: continue
        enqueue ReplanJob(owner, trigger = evt.kind, delay = debounceFor(evt.kind))
            with jobId = "replan:" + owner         // a newer job replaces a pending one; triggers are merged

function runReplan(owner, triggers):
    tx:
        if not tryAdvisoryLock(owner): requeue(owner, 2s); return
        epoch   = user.plan_epoch
        input   = buildInput(owner, now())            // 13.A, eligibility filter applied
        result  = plan(input)                         // F.2
        assertInvariants(result, input)               // no overlap with busy/protected, deps, hours
        changes = diff(input.previous, result)        // MOVED/ADDED/REMOVED/RESIZED with reasons
        if changes.isEmpty or onlySubGranularityResizes(changes): return
        decision = gate(owner, changes, triggers)     // F.4
        pv = insert plan_version(owner, status = decision.status, trigger = summarise(triggers),
                                 auto_applied = decision.apply)
        insert plan_changes(pv, changes)
        if decision.apply:
            applyBlocks(owner, result.blocks, pv)     // upsert by (taskId, chunkIndex) identity; delete superseded unpinned
            for op in mirrorOps(changes): insert outbox(op, idempotency_key = op.blockId + ':' + op.version + ':' + op.kind)
            notifyApplied(owner, pv, changes)
        else:
            insert proposed blocks (state = PROPOSED, plan_version = pv)
            notifyProposal(owner, pv, changes, autoAcceptAt = decision.autoAcceptAt)
        if user.plan_epoch != epoch: rollback; requeue(owner)    // someone else replanned meanwhile
        user.plan_epoch += 1
```

### F.2 Engine: `plan(input)` (current algorithm plus marked extensions)

```text
function plan(input):
    free   = workingHours(input) − protected(input) − input.busy − pinned(input)   // B.1
    free   = clampFrom(free, input.now)
    blocks = pinned(input)                                         // untouched
    ctx    = { free, energy, buffer, granularity, dailyWorkCap, perDayWork = {} }

    // Stability pass (B.8 change: may later be partially undone by preemption)
    retained = {}
    for prev in input.previous sorted by start:
        t = task(prev.taskId); if not t or prev.end <= now: continue
        if t.earliestStart and prev.start < t.earliestStart: continue
        if t.committedTo and prev not within t.committedTo: continue
        if not isFree(ctx.free, prev): continue
        if retainedMinutes(t) + len(prev) > t.remaining: continue
        consume(ctx, prev); retained[t] += prev

    (ordered, cyclic) = topoSort(input.tasks, key = rankKey)       // B.2
    report cyclic as DEPENDENCY_CYCLE

    for t in ordered:
        notBefore = max(now, t.earliestStart, max(finish[d] for d in t.dependsOn if d scheduled))
        if any prerequisite in input unscheduled: report BLOCKED_BY_DEPENDENCY; continue
        if notBefore >= horizonEnd: report STARTS_AFTER_HORIZON; continue
        chunks = chunk(t.remaining − minutes(retained[t]), t.min, t.max, t.splittable)
        cursor = max(notBefore, lastEnd(retained[t]))
        for c in chunks:
            p = null
            if t.committedTo:  p = findSlot(ctx, c, cursor, notAfter = t.deadline, within = t.committedTo,
                                            prefer = [energy, preferredWindow])
            leftDay = t.committedTo and p == null
            if not p:          p = findSlot(ctx, c, cursor, notAfter = t.deadline, prefer = [...])
            if not p and t.isUrgentOrHardAtRisk:                                          // [new] B.8
                p = preemptFor(ctx, t, c, cursor, retained, rankKey)                      // releases lower-ranked retained blocks
            if not p and t.deadline: p = findSlot(ctx, c, cursor, prefer = [...]); lateFlag = p != null
            if not p: break
            if leftDay: spilled[t] += c
            consume(ctx, p); place(t, p); cursor = p.end
        if t.deadlineKind == HARD and lateFlag: repairHardDeadline(ctx, t)               // [new] B.6
        record shortfall / DEADLINE_UNREACHABLE / spill with explanations
        if t.deadlineKind == HARD and still late: overtimeProposals += proposeOvertime(t) // [new] B.12

    re-place any tasks whose retained blocks were released by preemption/repair (same loop, appended)
    return { blocks sorted, unscheduled, spilled, overtimeProposals, days: perDaySummary, explanations }

function findSlot(ctx, minutes, floor, notAfter?, within?, prefer):
    narrow [floor, ceiling) by within and notAfter
    for strictness in [all prefs, drop preferredWindow, drop energy]:       // relax soft prefs first
        for slot in ctx.free:
            start = alignUp(max(slot.start, floor), granularity)
            end   = start + minutes
            if end > slot.end or (ceiling and end > ceiling): continue
            if dailyWorkCap and perDayWork[day(start)] + minutes > dailyWorkCap: continue
            if not satisfies(slot, strictness): continue
            return {start, end, relaxed = dropped prefs}
    return null
```

### F.3 Recovery after an interrupted or overrun session

```text
function onTimerStop(task, session, now, answer):
    session.actualMinutes += now − session.timerStartedAt
    if answer == DONE: complete(task); return                     // B.11
    extra = answer.minutes ?? max(15, 0.25 × task.originalEstimate)
    task.remaining = extra; task.remainingAssumed = (answer == null)
    if now < session.end: truncate(session, now)
    enqueue ReplanJob(task.owner, trigger = OVERRUN, delay = 0)

function onSessionMissed(session):                                  // at end + 15 min grace
    session.state = MISSED
    if session.isPinned: createRecoveryProposal(session)             // always asks
    else: enqueue ReplanJob(owner, trigger = MISSED)                 // normal mode gating
```

### F.4 Mode gate

```text
function gate(owner, changes, triggers):
    alwaysAsk = changes.any(c => c.overtime or c.recoversMissedPin or c.spillsCommitment
                                or c.deletesLoggedSession or c.touchesOtherUser)
    capped    = changes.perDay().any(n => n > prefs.maxDailyReshuffles)
    switch mode(owner):
        MANUAL:    return PROPOSE(onlyIfRequested = true)
        ASSISTED:  return PROPOSE(autoAcceptAt = prefs.autoAcceptSeconds > 0 and not alwaysAsk
                                                  ? now + prefs.autoAcceptSeconds : null)
        HYBRID:    return (not alwaysAsk and not capped and disruption(changes, triggers) <= prefs.hybridThreshold)
                          ? APPLY : PROPOSE
        AUTOMATIC: return (not alwaysAsk and not capped) ? APPLY : PROPOSE
```

---

## 13.G Worked examples

Common settings: time zone Europe/London, working hours 09:00–17:00, buffer 10 min,
granularity 15 min, max chunk 90, min chunk 25, no energy windows. All times local.
"Free" lists are after subtracting busy time.

### Example 1 — Busy calendar (Monday 09:00, empty previous plan)

**Calendar:** meetings 09:30–10:30, 12:00–13:00, 14:00–15:30. Tuesday is clear.
**Free Monday:** 09:00–09:30 · 10:30–12:00 · 13:00–14:00 · 15:30–17:00.

| Task | Est | Priority | Deadline | Committed |
|---|---|---|---|---|
| B Reply to Dana | 15 | MEDIUM | — | Mon |
| C Prepare slides | 60 | HIGH | Mon 17:00 HARD | — |
| A Write report | 120 | HIGH | Tue 17:00 soft | — |
| D Refactor module | 90 | LOW | — | — |

**Ranking:**
1. B is committed, so it goes first.
2. C and A are both HIGH, and C's hard deadline is not at risk (slack 420 ≥ 2×60). By slack, C (480−60 = 420) comes before A (1,920−120 = 1,800).
3. D comes last.

**Placement:**

| Task | Result | Why |
|---|---|---|
| B | Mon 09:00–09:15 | Committed day, earliest slot. Buffer to 09:25. 09:25–09:30 is too short for anything |
| C | Mon 10:30–11:30 | First slot ≥ 60 min. Buffer to 11:40 |
| A | 2 chunks (120 > 90 → 60 + 60). Chunk 1: 11:45–12:45 doesn't fit before 12:00, so **13:00–14:00**. Chunk 2: **15:30–16:30** | Even chunking. Each is the earliest fit after the previous chunk |
| D | Tue 09:00–10:30 | Monday's leftovers (11:40–12:00, 16:40–17:00) are each < 90 |

**Capacity Monday:** available 270 min, scheduled 195 min, plus buffers. Not
overcommitted. Every card's explanation names the meeting that bounds it ("10:30
because Standup ends at 10:30").

### Example 2 — Overlapping deadlines (Tuesday 13:00)

**Calendar:** Tue meeting 15:00–16:00. Wed lunch is protected 12:00–13:00.
**Free before Wed 12:00:** Tue 13:00–15:00 (120) · Tue 16:00–17:00 (60) · Wed 09:00–12:00 (180) = 360 min.

| Task | Est | Priority | Deadline |
|---|---|---|---|
| X Submit grant | 180 | HIGH | Wed 12:00 **HARD** |
| Y Budget sheet | 120 | HIGH | Wed 12:00 soft |
| Z Cover letter | 90 | HIGH | Wed 12:00 soft |

Demand is 390 min against 360 available, so it is infeasible before buffers.

**Ranking:**
- Same priority and same deadline, so slack decides: X (1,380−180 = 1,200) < Y (1,260) < Z (1,290).
- X's slack 1,200 ≥ 2×180, so it isn't flagged at risk. It would rank first anyway.

**Placement:**

| Task | Sessions | Notes |
|---|---|---|
| X | Tue 13:00–14:30 · Wed 09:00–10:30 | Chunk 2 can't fit 14:40–15:00 or 16:00–17:00 (60 < 90) |
| Y | Tue 16:00–17:00 · Wed 10:45–11:45 | |
| Z | Wed 13:00–14:30 | **After its deadline.** Before 12:00 only 11:55–12:00 remains |

**Output:** Z gets `DEADLINE_UNREACHABLE`: "'Cover letter' is scheduled, but the last
session lands after its deadline…". The resolve tray offers: extend Z's deadline,
reduce Z to 60 min, move Y's Wednesday session (Y and Z have the same deadline, so
this only shifts the problem; the copy says so), or **request** overtime.

*Variant (exposes a real limitation of the current algorithm):* suppose X is 330 min.
- X already ranks first, so the repair pass has nothing lower-ranked to release.
- Even chunking produces 4 × ~83 min. Those chunks cannot use the 60-minute Tuesday 16:00 slot, so the last chunk lands at Wed 13:00, after the deadline.
- **[new] Adaptive re-chunking** (first step of B.6 for HARD deadlines) re-chunks greedily into free slots ≥ `minChunk` before the deadline, still capped at `maxChunk`: Tue 13:00–14:30 (90), Tue 16:00–17:00 (60), Wed 09:00–10:30 (90), Wed 10:45–12:00 (75). That is 315 min, 15 short.
- The engine then emits `overtimeProposals = [{X, Tue 17:10–17:35}]`: one minimum-size chunk, nearest to working hours, outside quiet hours.
- Y and Z are both reported unreachable.

Nothing moves out of hours unless the user taps Approve.

### Example 3 — Delayed task (Monday, overrun)

**Plan in force:** Quarterly report 10:00–11:00 (HIGH) · Email triage 11:10–11:40
(MEDIUM, unpinned) · Lunch meeting 12:00–13:00 (external) · Design review prep
13:10–14:40 (MEDIUM, unpinned, due Wed).

1. 11:00: the report's timer is still running. Flow mode shows "Running over. Next fixed: Lunch meeting 12:00". Nothing is written yet.
2. 11:25: timer stopped. The user answers "need ≈30 min more". Trigger `OVERRUN`, `now = 11:25`, report remaining = 30.
3. Engine:
   - Stability retains Design prep 13:10–14:40 (still free and legal). Email triage 11:10–11:40 is not retained because it overlaps `now`.
   - The report (HIGH) is placed at 11:30–12:00.
   - Triage (MEDIUM): the next free slot after the report's buffer is 13:00–13:10 (10 min, too short), then 14:50, which aligns to **15:00–15:30**.
4. Diff:
   - ADDED "Quarterly report" 11:30–12:00: "you said it needs about 30 more minutes".
   - MOVED "Email triage" 11:10 → 15:00: "Quarterly report ran over".
   - UNCHANGED Design prep.
5. Hybrid gate: one same-day move (1), imminent (+2), times 0.5 because the user just answered = **1.5 ≤ 4**, so it is applied with an Undo toast.

### Example 4 — Urgent interruption (Tuesday 11:00)

**Plan in force:** Blog draft 11:00–12:30 (MEDIUM, soft Fri, unpinned) · Lunch
(protected) 12:30–13:30 · Client call 13:30–14:30 (external) · Inbox zero 14:40–15:10
(LOW, unpinned) · Spec review 15:20–16:50 (**pinned**).

**New:** "Fix checkout bug", URGENT, 90 min, not splittable, deadline today 17:00 HARD.

1. Stability retains Blog (plus its buffer, to 12:40) and Inbox zero (to 15:20). The bug needs 90 contiguous minutes before 17:00. Free: 14:30–14:40 and 16:50–17:00, so it doesn't fit.
2. **Urgent preemption:** lower-ranked retained blocks in the window are Inbox zero (LOW) and Blog (MEDIUM).
   - Releasing Inbox zero frees 14:30–15:20, which is 50 min. Not enough.
   - Releasing Blog frees 11:00–12:30, which is 90 min and fits.
   - The minimal set is {Blog}, because releasing Inbox zero alone doesn't help. Inbox zero is restored.
3. Bug goes to **11:00–12:30**. Blog is re-placed at the next fit: Tue 16:50–17:00 is too short, so **Wed 09:00–10:30**.
4. Diff:
   - ADDED Bug 11:00–12:30: "Urgent, due 17:00 today".
   - MOVED Blog Tue 11:00 → Wed 09:00: "made room for Fix checkout bug (due 17:00 today); Blog draft isn't due until Friday".
5. Hybrid gate: move to another day (2) + imminent (+2) = 4, times 0.5 (user just created the task) = **2 ≤ 4**, so it is applied, with a notification and Undo.
6. *If the user taps Undo on the Blog line:*
   - Blog returns to Tue 11:00 **pinned**, because undo is a decision.
   - The follow-up replan finds no 90-minute slot before 17:00 for the bug. The repair pass has no lower-ranked unpinned blocks large enough.
   - The engine emits an overtime proposal (Tue 17:00–18:30) and lists the alternatives (unpin Blog, make the bug splittable, move the deadline). This is always-ask, so nothing is applied until the user chooses.

---

## 13.H Engine test obligations (summary; full plan in [06-delivery.md §22](06-delivery.md#22-test-plan-and-acceptance-criteria))

- **Property tests (fast-check)** over random inputs:
  - no block overlaps busy, protected or pinned time
  - all blocks inside working hours
  - dependants start after prerequisites end
  - Σ placed + shortfall = remaining
  - determinism: same input gives byte-identical output
  - idempotence: re-planning with `previous = output` and an unchanged input yields an empty diff
- **Golden tests:** each worked example above becomes a fixture with exact expected blocks.
- **DST:** working hours across Europe/London and America/New_York transitions; a session spanning the 01:00 → 02:00 gap is never created.
- **Performance:** 300 tasks × 14 days × 200 events in < 500 ms on CI hardware.
