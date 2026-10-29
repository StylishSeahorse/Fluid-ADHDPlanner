import { describe, expect, it } from 'vitest';
import { dueNotifications, isQuietTime, type DueInput } from './due';

const TZ = 'Europe/London';

/** Thursday 29 Oct 2026 — after the clocks went back, so London is UTC+0. */
const at = (time: string) => new Date(`2026-10-29T${time}:00Z`);

const weekdays = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek,
  startTime: '09:00',
  endTime: '17:00',
}));

function input(overrides: Partial<DueInput> = {}): DueInput {
  return {
    now: at('08:00'),
    timeZone: TZ,
    prefs: {
      enabled: true,
      blockReminders: true,
      dayPrompts: true,
      leadMinutes: 5,
      quietHoursStart: null,
      quietHoursEnd: null,
    },
    workingHours: weekdays,
    blocks: [],
    // Planned already, so block tests are not also met by the planning prompt.
    day: { plannedAt: at('08:30') },
    hasWorkToday: true,
    ...overrides,
  };
}

const report = {
  id: 'blk_1',
  taskTitle: 'Write the quarterly report',
  startsAt: at('10:00'),
  endsAt: at('11:00'),
  projectName: 'Quarterly report',
};

describe('block reminders', () => {
  it('arrives lead minutes before the session, naming it and its time', () => {
    const [due] = dueNotifications(input({ now: at('09:55'), blocks: [report] }));

    expect(due).toMatchObject({
      kind: 'BLOCK_START',
      title: 'In 5 min: Write the quarterly report',
      body: '10:00–11:00 · Quarterly report',
      tag: 'block-blk_1',
    });
    expect(due?.actions?.[0]?.url).toBe('/focus');
  });

  it('stays silent before the lead window opens', () => {
    expect(dueNotifications(input({ now: at('09:54'), blocks: [report] }))).toEqual([]);
  });

  it('still fires just after the start, so a missed tick does not swallow it', () => {
    const [due] = dueNotifications(input({ now: at('10:01'), blocks: [report] }));
    expect(due?.title).toBe('Time for Write the quarterly report');
  });

  it('gives up shortly after the start rather than nagging late', () => {
    expect(dueNotifications(input({ now: at('10:02'), blocks: [report] }))).toEqual([]);
  });

  it('says nothing when a timer is already running on the task', () => {
    const running = { ...report, timerRunning: true };
    expect(dueNotifications(input({ now: at('09:58'), blocks: [running] }))).toEqual([]);
  });

  it('keys on the start time, so a moved session earns a fresh reminder', () => {
    const [first] = dueNotifications(input({ now: at('09:58'), blocks: [report] }));
    const moved = { ...report, startsAt: at('14:00'), endsAt: at('15:00') };
    const [second] = dueNotifications(input({ now: at('13:58'), blocks: [moved] }));

    expect(first?.refKey).not.toBe(second?.refKey);
    expect(first?.tag).toBe(second?.tag); // …but replaces, rather than stacks, on the device
  });

  it('respects the per-kind switch', () => {
    const prefs = { ...input().prefs, blockReminders: false };
    expect(dueNotifications(input({ now: at('09:58'), blocks: [report], prefs }))).toEqual([]);
  });
});

describe('day prompts', () => {
  it('prompts to plan at the start of the working day', () => {
    const due = dueNotifications(input({ now: at('09:00'), day: {} }));
    expect(due).toEqual([
      expect.objectContaining({ kind: 'PLAN_DAY', refKey: '2026-10-29', url: '/plan-day' }),
    ]);
  });

  it('does not prompt to plan a day that is already planned', () => {
    expect(dueNotifications(input({ now: at('09:10'), day: { plannedAt: at('08:40') } }))).toEqual([]);
  });

  it('stops offering the plan prompt an hour into the day', () => {
    expect(dueNotifications(input({ now: at('10:00'), day: {} }))).toEqual([]);
  });

  it('prompts to wrap up at the end of the working day', () => {
    const due = dueNotifications(input({ now: at('17:05') }));
    expect(due).toEqual([expect.objectContaining({ kind: 'SHUTDOWN', url: '/today#shutdown' })]);
  });

  it('does not prompt to wrap up a day with no work in it', () => {
    expect(dueNotifications(input({ now: at('17:05'), hasWorkToday: false, day: {} }))).toEqual([]);
  });

  it('does not prompt to wrap up a day already closed', () => {
    expect(dueNotifications(input({ now: at('17:05'), day: { shutdownAt: at('16:50') } }))).toEqual([]);
  });

  it('is silent on non-working days', () => {
    const saturday = new Date('2026-10-31T09:00:00Z');
    expect(dueNotifications(input({ now: saturday, day: {} }))).toEqual([]);
  });

  it('follows wall-clock working hours across a DST change', () => {
    // Monday 30 March 2026: London is UTC+1, so 09:00 local is 08:00 UTC.
    const due = dueNotifications(input({ now: new Date('2026-03-30T08:00:00Z'), day: {} }));
    expect(due.map((entry) => entry.kind)).toEqual(['PLAN_DAY']);
  });
});

describe('master switch and quiet hours', () => {
  it('sends nothing when notifications are off', () => {
    const prefs = { ...input().prefs, enabled: false };
    expect(dueNotifications(input({ now: at('09:00'), prefs, day: {} }))).toEqual([]);
  });

  it('sends nothing during quiet hours', () => {
    const prefs = { ...input().prefs, quietHoursStart: '08:30', quietHoursEnd: '09:30' };
    expect(dueNotifications(input({ now: at('09:00'), prefs, day: {} }))).toEqual([]);
  });

  it('handles quiet hours that wrap past midnight', () => {
    expect(isQuietTime(at('23:30'), TZ, '22:00', '07:00')).toBe(true);
    expect(isQuietTime(at('06:59'), TZ, '22:00', '07:00')).toBe(true);
    expect(isQuietTime(at('07:00'), TZ, '22:00', '07:00')).toBe(false);
    expect(isQuietTime(at('12:00'), TZ, '22:00', '07:00')).toBe(false);
  });

  it('treats missing or empty quiet hours as none', () => {
    expect(isQuietTime(at('03:00'), TZ, null, null)).toBe(false);
    expect(isQuietTime(at('03:00'), TZ, '22:00', '22:00')).toBe(false);
  });
});
