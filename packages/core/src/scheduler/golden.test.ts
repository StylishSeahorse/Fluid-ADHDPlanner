/**
 * Golden tests: the worked examples of the scheduling spec (§13.G), exactly.
 *
 * Common settings: Europe/London, working hours 09:00–17:00, buffer 10 min,
 * granularity 15, max chunk 90, min chunk 25, no energy windows. Monday is
 * 15 June 2026 (British Summer Time, UTC+1), so a wrong zone shows up as an
 * hour off rather than passing by accident.
 */
import { describe, expect, it } from 'vitest';
import { localTimeOnDay, parseTimeOfDay, startOfLocalDay } from '../time/zoned';
import { diffPlans } from './diff';
import { describeExplanation } from './explain';
import { disruptionScore, gatePlan } from './gate';
import { plan } from './plan';
import type { PlannedBlock, SchedulableTask, SchedulingInput } from './types';

const TZ = 'Europe/London';
const MONDAY = startOfLocalDay(new Date('2026-06-15T12:00:00Z'), TZ);
const DAYS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4 } as const;

/** "Tue 13:00" in London. */
function at(when: string): Date {
  const [day, time] = when.split(' ') as [keyof typeof DAYS, string];
  return localTimeOnDay(startOfLocalDay(MONDAY, TZ, DAYS[day]), parseTimeOfDay(time), TZ);
}
const span = (from: string, to: string) => ({ start: at(from), end: at(to) });

function local(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get('weekday')} ${get('hour')}:${get('minute')}`;
}
const sessions = (blocks: PlannedBlock[], taskId: string) =>
  blocks.filter((block) => block.taskId === taskId).map((block) => `${local(block.start)}–${local(block.end).slice(4)}`);

function task(overrides: Partial<SchedulableTask> & { id: string; remainingMinutes: number }): SchedulableTask {
  return {
    title: overrides.id,
    priority: 'MEDIUM',
    energy: 'MEDIUM',
    isSplittable: true,
    minChunkMinutes: 25,
    maxChunkMinutes: 90,
    ...overrides,
  };
}

function input(overrides: Partial<SchedulingInput>): SchedulingInput {
  return {
    now: at('Mon 09:00'),
    timeZone: TZ,
    horizonDays: 7,
    tasks: [],
    busy: [],
    pinned: [],
    workingHours: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '17:00' })),
    energyWindows: [],
    protectedTimes: [],
    preferences: { bufferMinutes: 10, slotGranularityMinutes: 15 },
    ...overrides,
  };
}

describe('Example 1 — busy calendar', () => {
  const scenario = input({
    busy: [
      { ...span('Mon 09:30', 'Mon 10:30'), id: 'standup', title: 'Standup' },
      { ...span('Mon 12:00', 'Mon 13:00'), title: 'Lunch with Sam' },
      { ...span('Mon 14:00', 'Mon 15:30'), title: 'Design review' },
    ],
    tasks: [
      task({ id: 'B', title: 'Reply to Dana', remainingMinutes: 15, committedTo: span('Mon 00:00', 'Tue 00:00') }),
      task({ id: 'C', title: 'Prepare slides', remainingMinutes: 60, priority: 'HIGH', deadline: at('Mon 17:00'), deadlineKind: 'HARD' }),
      task({ id: 'A', title: 'Write report', remainingMinutes: 120, priority: 'HIGH', deadline: at('Tue 17:00') }),
      task({ id: 'D', title: 'Refactor module', remainingMinutes: 90, priority: 'LOW' }),
    ],
  });
  const result = plan(scenario);

  it('places every task exactly as the spec says', () => {
    expect(sessions(result.blocks, 'B')).toEqual(['Mon 09:00–09:15']);
    expect(sessions(result.blocks, 'C')).toEqual(['Mon 10:30–11:30']);
    expect(sessions(result.blocks, 'A')).toEqual(['Mon 13:00–14:00', 'Mon 15:30–16:30']);
    expect(sessions(result.blocks, 'D')).toEqual(['Tue 09:00–10:30']);
    expect(result.unscheduled).toEqual([]);
  });

  it('names the meeting that bounds a session', () => {
    const slides = result.blocks.find((block) => block.taskId === 'C')!;
    expect(slides.explanation?.bindingConstraints).toEqual([{ kind: 'busy', eventId: 'standup', title: 'Standup', endsAt: at('Mon 10:30') }]);
    const text = describeExplanation('C', slides.start, slides.explanation!, {
      timeZone: TZ,
      now: scenario.now,
      tasks: new Map(scenario.tasks.map((t) => [t.id, t])),
    });
    expect(text).toContain('Not earlier: “Standup” runs until today at 10:30.');
    expect(text).toContain('it’s high priority');
  });

  it('reports Monday as not overcommitted', () => {
    const monday = result.days[0]!;
    expect(monday.availableMinutes).toBe(270);
    expect(monday.overcommitted).toBe(false);
    expect(monday.committedMinutes).toBe(15);
  });
});

describe('Example 2 — overlapping deadlines', () => {
  const base = input({
    now: at('Tue 13:00'),
    busy: [{ ...span('Tue 15:00', 'Tue 16:00'), title: 'Meeting' }],
    protectedTimes: [{ kind: 'ROUTINE', label: 'Lunch', dayOfWeek: 3, startTime: '12:00', endTime: '13:00' }],
  });
  const grant = (minutes: number) =>
    task({ id: 'X', title: 'Submit grant', remainingMinutes: minutes, priority: 'HIGH', deadline: at('Wed 12:00'), deadlineKind: 'HARD' });
  const others = [
    task({ id: 'Y', title: 'Budget sheet', remainingMinutes: 120, priority: 'HIGH', deadline: at('Wed 12:00') }),
    task({ id: 'Z', title: 'Cover letter', remainingMinutes: 90, priority: 'HIGH', deadline: at('Wed 12:00') }),
  ];

  it('places X and Y in time, and Z after its deadline, said plainly', () => {
    const result = plan({ ...base, tasks: [grant(180), ...others] });
    expect(sessions(result.blocks, 'X')).toEqual(['Tue 13:00–14:30', 'Wed 09:00–10:30']);
    expect(sessions(result.blocks, 'Y')).toEqual(['Tue 16:00–17:00', 'Wed 10:45–11:45']);
    expect(sessions(result.blocks, 'Z')).toEqual(['Wed 13:00–14:30']);
    expect(result.unscheduled).toEqual([expect.objectContaining({ taskId: 'Z', reason: 'DEADLINE_UNREACHABLE' })]);
    expect(result.overtimeProposals).toEqual([]);
  });

  it('variant: adaptive chunking, then an overtime proposal for the last 15 minutes', () => {
    const result = plan({ ...base, tasks: [grant(330), ...others] });
    expect(sessions(result.blocks, 'X')).toEqual(['Tue 13:00–14:30', 'Tue 16:00–17:00', 'Wed 09:00–10:30', 'Wed 10:45–12:00']);
    expect(result.blocks.filter((block) => block.taskId === 'X').every((block) => block.explanation?.adaptive)).toBe(true);
    expect(result.overtimeProposals).toHaveLength(1);
    const overtime = result.overtimeProposals[0]!;
    expect(overtime.taskId).toBe('X');
    expect(overtime.shortfallMinutes).toBe(15);
    expect(overtime.intervals.map((interval) => `${local(interval.start)}–${local(interval.end).slice(4)}`)).toEqual(['Tue 17:10–17:35']);
    // Nothing is ever placed out of hours: the proposal is not a block.
    expect(result.blocks.some((block) => block.start >= at('Tue 17:00') && block.start < at('Wed 09:00'))).toBe(false);
    const reasons = new Map(result.unscheduled.map((entry) => [entry.taskId, entry.reason]));
    expect(reasons.get('X')).toBe('DEADLINE_UNREACHABLE');
    expect(reasons.get('Y')).toBe('DEADLINE_UNREACHABLE');
    expect(reasons.get('Z')).toBe('DEADLINE_UNREACHABLE');
  });

  it('variant: an overtime proposal is always-ask, even in Automatic mode', () => {
    const result = plan({ ...base, tasks: [grant(330), ...others] });
    const decision = gatePlan({
      mode: 'AUTOMATIC',
      changes: diffPlans([], result.blocks, { timeZone: TZ, now: base.now, taskTitles: new Map(), trigger: 'manual' }),
      now: base.now,
      timeZone: TZ,
      requested: false,
      userInitiated: false,
      hybridThreshold: 4,
      maxDailyReshuffles: 3,
      autoAcceptSeconds: 30,
      overtimeProposals: result.overtimeProposals.length,
      spillsCommitment: false,
      recoversMissedPin: false,
      staleCalendar: false,
      granularityMinutes: 15,
    });
    expect(decision.action).toBe('PROPOSE');
    expect(decision.autoAcceptAt).toBeNull();
  });
});

describe('Example 3 — a delayed task', () => {
  const scenario = input({
    now: at('Mon 11:25'),
    busy: [{ ...span('Mon 12:00', 'Mon 13:00'), title: 'Lunch meeting' }],
    tasks: [
      task({ id: 'report', title: 'Quarterly report', remainingMinutes: 30, priority: 'HIGH' }),
      task({ id: 'triage', title: 'Email triage', remainingMinutes: 30 }),
      task({ id: 'design', title: 'Design review prep', remainingMinutes: 90, deadline: at('Wed 17:00') }),
    ],
    // What the orchestrator passes: unpinned sessions still ending after now.
    previous: [
      { taskId: 'triage', ...span('Mon 11:10', 'Mon 11:40'), isPinned: false, chunkIndex: 1, chunkCount: 1 },
      { taskId: 'design', ...span('Mon 13:10', 'Mon 14:40'), isPinned: false, chunkIndex: 1, chunkCount: 1 },
    ],
  });
  const result = plan(scenario);

  it('keeps design prep, fits the report before lunch, and moves triage', () => {
    expect(sessions(result.blocks, 'report')).toEqual(['Mon 11:30–12:00']);
    expect(sessions(result.blocks, 'design')).toEqual(['Mon 13:10–14:40']);
    expect(sessions(result.blocks, 'triage')).toEqual(['Mon 15:00–15:30']);
  });

  it('diffs as added / moved / unchanged and passes the Hybrid gate at 1.5', () => {
    const changes = diffPlans(scenario.previous!, result.blocks, {
      timeZone: TZ,
      now: scenario.now,
      taskTitles: new Map(scenario.tasks.map((t) => [t.id, t.title])),
      trigger: 'task_overran',
    });
    const kinds = Object.fromEntries(changes.map((change) => [change.taskId, change.kind]));
    expect(kinds).toEqual({ report: 'ADDED', triage: 'MOVED', design: 'UNCHANGED' });
    const score = disruptionScore(changes, { now: scenario.now, timeZone: TZ, userInitiated: true });
    expect(score).toBe(1.5);
    const decision = gatePlan({
      mode: 'HYBRID',
      changes,
      now: scenario.now,
      timeZone: TZ,
      requested: false,
      userInitiated: true,
      hybridThreshold: 4,
      maxDailyReshuffles: 3,
      autoAcceptSeconds: 30,
      overtimeProposals: 0,
      spillsCommitment: false,
      recoversMissedPin: false,
      staleCalendar: false,
      granularityMinutes: 15,
    });
    expect(decision.action).toBe('APPLY');
  });
});

describe('Example 4 — an urgent interruption', () => {
  const scenario = input({
    now: at('Tue 11:00'),
    protectedTimes: [{ kind: 'ROUTINE', label: 'Lunch', dayOfWeek: 2, startTime: '12:30', endTime: '13:30' }],
    busy: [{ ...span('Tue 13:30', 'Tue 14:30'), title: 'Client call' }],
    pinned: [{ taskId: 'spec', blockId: 'spec-1', ...span('Tue 15:20', 'Tue 16:50') }],
    tasks: [
      task({ id: 'blog', title: 'Blog draft', remainingMinutes: 90, deadline: at('Fri 17:00') }),
      task({ id: 'inbox', title: 'Inbox zero', remainingMinutes: 30, priority: 'LOW' }),
      task({
        id: 'bug',
        title: 'Fix checkout bug',
        remainingMinutes: 90,
        priority: 'URGENT',
        isSplittable: false,
        deadline: at('Tue 17:00'),
        deadlineKind: 'HARD',
      }),
    ],
    previous: [
      { taskId: 'blog', ...span('Tue 11:00', 'Tue 12:30'), isPinned: false, chunkIndex: 1, chunkCount: 1 },
      { taskId: 'inbox', ...span('Tue 14:40', 'Tue 15:10'), isPinned: false, chunkIndex: 1, chunkCount: 1 },
    ],
  });
  const result = plan(scenario);

  it('releases the minimal set — the blog, not the inbox — for the bug', () => {
    expect(sessions(result.blocks, 'bug')).toEqual(['Tue 11:00–12:30']);
    expect(sessions(result.blocks, 'blog')).toEqual(['Wed 09:00–10:30']);
    expect(sessions(result.blocks, 'inbox')).toEqual(['Tue 14:40–15:10']);
    expect(sessions(result.blocks, 'spec')).toEqual(['Tue 15:20–16:50']);
    expect(result.displaced).toEqual([{ taskId: 'blog', forTaskId: 'bug', from: span('Tue 11:00', 'Tue 12:30') }]);
    expect(result.blocks.find((block) => block.taskId === 'bug')?.explanation?.displaced).toEqual(['blog']);
  });

  it('says the blog made room, and passes Hybrid at 2', () => {
    const changes = diffPlans(scenario.previous!, result.blocks, {
      timeZone: TZ,
      now: scenario.now,
      taskTitles: new Map(scenario.tasks.map((t) => [t.id, t.title])),
      trigger: 'new_urgent_task',
      displacedFor: new Map(result.displaced.map((entry) => [entry.taskId, entry.forTaskId])),
    });
    const blog = changes.find((change) => change.taskId === 'blog')!;
    expect(blog.kind).toBe('MOVED');
    expect(blog.reason).toContain('made room for Fix checkout bug');
    expect(changes.find((change) => change.taskId === 'bug')?.kind).toBe('ADDED');
    expect(disruptionScore(changes, { now: scenario.now, timeZone: TZ, userInitiated: true })).toBe(2);
  });

  it('never releases a pinned session, even for an urgent task', () => {
    const tight = plan({
      ...scenario,
      previous: [],
      pinned: [...scenario.pinned, { taskId: 'blog', blockId: 'blog-1', ...span('Tue 11:00', 'Tue 12:30') }],
      tasks: scenario.tasks.filter((t) => t.id !== 'blog'),
    });
    expect(sessions(tight.blocks, 'blog')).toEqual(['Tue 11:00–12:30']);
    // No room before 17:00 and no out-of-hours time before the deadline: the
    // work still gets a home, after the deadline, and says so.
    expect(sessions(tight.blocks, 'bug')).toEqual(['Wed 09:00–10:30']);
    expect(tight.unscheduled.find((entry) => entry.taskId === 'bug')?.reason).toBe('DEADLINE_UNREACHABLE');
    expect(tight.displaced).toEqual([]);
  });
});

describe('“Why here?” text', () => {
  it('names the dependency a session has to wait for', () => {
    const scenario = input({
      tasks: [
        task({ id: 'feedback', title: 'Collect feedback', remainingMinutes: 60, priority: 'HIGH' }),
        task({ id: 'revise', title: 'Revise the draft', remainingMinutes: 60, dependsOn: ['feedback'], deadline: at('Fri 17:00') }),
      ],
    });
    const result = plan(scenario);
    const revise = result.blocks.find((block) => block.taskId === 'revise')!;
    expect(revise.explanation?.bindingConstraints[0]).toMatchObject({ kind: 'dependency', taskId: 'feedback' });
    const text = describeExplanation('revise', revise.start, revise.explanation!, {
      timeZone: TZ,
      now: scenario.now,
      tasks: new Map(scenario.tasks.map((t) => [t.id, t])),
    });
    expect(text).toBe('Today at 10:15 because it’s due Friday at 17:00. Not earlier: it has to follow “Collect feedback”, which ends today at 10:00.');
  });

  it('says when a preferred time of day was given up', () => {
    const scenario = input({
      busy: [{ ...span('Mon 09:00', 'Mon 12:00'), title: 'Workshop' }],
      tasks: [task({ id: 'w', title: 'Write', remainingMinutes: 60, preferredWindow: { startMinute: 9 * 60, endMinute: 12 * 60 } })],
      horizonDays: 1,
    });
    const block = plan(scenario).blocks[0]!;
    expect(block.explanation?.relaxed).toEqual(['preferred_window']);
    expect(local(block.start)).toBe('Mon 12:00');
  });

  it('honours a daily work cap and says so', () => {
    const scenario = input({
      preferences: { bufferMinutes: 0, slotGranularityMinutes: 15, maxDailyWorkMinutes: 120 },
      tasks: [
        task({ id: 'a', remainingMinutes: 90, priority: 'HIGH' }),
        task({ id: 'b', remainingMinutes: 60 }),
      ],
    });
    const result = plan(scenario);
    expect(sessions(result.blocks, 'a')).toEqual(['Mon 09:00–10:30']);
    expect(sessions(result.blocks, 'b')).toEqual(['Tue 09:00–10:00']);
    expect(result.blocks.find((block) => block.taskId === 'b')?.explanation?.bindingConstraints).toEqual([{ kind: 'daily_cap' }]);
  });
});
