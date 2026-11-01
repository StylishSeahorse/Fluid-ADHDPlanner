# 0004 — Finishing Phase 2: side calendar, assumed estimates, both timers

Status: accepted, 1 November 2026. Context: [roadmap Phase 2](../blueprint/06-delivery.md#phase-2--planning-on-boards-calendar-integrations-worker),
REQ-DAY-01, REQ-TASK-EST, REQ-FOCUS-TIMERS. Microsoft 365 / Outlook was dropped
from scope at the owner's request, so with these three Phase 2 is complete.

## What was built

- **Side calendar on every board.** "Calendar" in the view bar, or `C`, opens
  the next seven days beside the board. Each day shows how full it is and what
  is planned on it. Dropping a card on a day plans it for that day. Planned
  cards can be dragged from one day to another. On a phone the days become a
  horizontal strip above the board.
- **"Estimate assumed".** Work added without an estimate gets the user's
  default (Settings → Your day, 30 min to start with), is flagged, and is
  still scheduled. The flag shows as `~30m` on cards, in the table, on Today,
  Week, Projects, the plan-day ritual and the timeline, on sessions, in the
  plan diff, in Focus and in the API. Changing the estimate clears it, and so
  does "keep it" on the card.
- **Both timers in Focus.** While a task is running, Focus shows the time
  until the next break and the total time on the task against its estimate,
  side by side. Before it starts, it says how much is already logged.

## Decisions

1. **The side calendar plans days, not times.** The blueprint's journey J3
   imagined dragging a session chip to "Tue 15:00". Fluid's model is
   that a person commits work to a *day* and the scheduler finds the time,
   respecting pinned sessions. So a drop sets `plannedFor`, exactly like the
   Week board and "Plan for…". Times the scheduler has already found are shown
   on the chips. Pinning an exact time stays on the Week calendar, which has a
   real time grid. A second, smaller time grid in a 288 px panel would
   be worse at the job.

2. **One formula for "how full is this day".** The Week board computed load
   inline. It now lives in `components/day-load.ts` and both views use it, so
   the board's side calendar and the Week board cannot disagree about the
   same Tuesday.

3. **The calendar lives in the URL (`?cal=1`).** Like the filter, the table
   and the open card, it survives a refresh and is kept when a card is opened
   and closed. Its chips use their own drag type, so a chip dropped on a board
   column is ignored instead of moving a card from another board onto this
   one.

4. **An assumed estimate is cleared by a choice, not by a save.** Both the
   card form and the task editor send every field on every save. So "an
   estimate arrived" cannot mean "someone chose it". Otherwise changing a
   card's priority would quietly certify its default 30 minutes. The flag
   clears when the number changes, or when the person says the default is
   right ("keep it"). Through the API, sending `estimateMinutes` counts as a
   choice.

5. **Assumed estimates never reach the estimation coach.** Finishing a task
   records "estimated vs. actual" only when someone actually estimated it.
   Otherwise the coach would learn that everything takes "about 30 minutes".

6. **Existing tasks start unflagged.** There is no way to tell which existing
   30s were typed and which were defaults. Guessing would flag real
   estimates as assumed, which is worse than missing old defaults.

7. **The break clock and the break prompt share one start.** Both count from
   when the timer last started. The countdown reaching zero and the prompt
   appearing are the same moment, and taking a break resets both.

## Verified

- Unit: the day-load formula (zones, booked plus unplaced, ledger split),
  the focus clock arithmetic, and the diff's assumed-estimate note. 465 tests.
- In a browser against the real database:
  - The default estimate setting is saved, and quick add uses it and flags it.
    The card shows `~20m`.
  - "Keep it" clears the flag. A priority-only save keeps the flag; changing
    the estimate clears it.
  - `C` opens the calendar and `C` again closes it. Typing "c" in the filter
    box does not.
  - Dropping a card on tomorrow plans it, and dragging the chip to the next
    day moves it. The card stays in its board column.
  - Opening a card keeps the calendar open, and a phone-width page does not
    scroll sideways.
  - Focus shows "Until a break 37:58" beside "On this task 32:01 — past the
    ~30 min estimate (assumed)" for a task with 20 minutes logged and 12
    running. Stop logs 32.

## Not done

- Dragging to a *time* from the board (see decision 1).
- Quick-add tokens (`~45m`, `>today`) from the blueprint's board spec.
