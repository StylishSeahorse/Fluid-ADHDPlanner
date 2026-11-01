import { describe, expect, it } from 'vitest';
import { dayKeyOf, plannedMinutes } from './day-load';

const task = (estimateMinutes: number, extra: Partial<Parameters<typeof plannedMinutes>[2][number]> = {}) => ({
  status: 'READY',
  estimateMinutes,
  area: null,
  scheduledBlocks: [],
  ...extra,
});

describe('day load', () => {
  it('keys instants by the local day', () => {
    expect(dayKeyOf(new Date('2026-11-02T23:30:00Z'), 'UTC')).toBe('2026-11-02');
    expect(dayKeyOf(new Date('2026-11-02T23:30:00Z'), 'Europe/Berlin')).toBe('2026-11-03');
  });

  it('adds unplaced committed work to what the scheduler booked', () => {
    const placed = task(60, { scheduledBlocks: [{ startsAt: new Date('2026-11-02T09:00:00Z') }] });
    expect(plannedMinutes('2026-11-02', 60, [placed, task(30)], 'UTC')).toBe(90);
  });

  it('counts a card placed on another day at its estimate here', () => {
    const elsewhere = task(45, { scheduledBlocks: [{ startsAt: new Date('2026-11-04T09:00:00Z') }] });
    expect(plannedMinutes('2026-11-02', 0, [elsewhere], 'UTC')).toBe(45);
  });

  it('leaves out done work and areas that do not count as work', () => {
    const errands = task(30, { area: { countsTowardCapacity: false } });
    expect(plannedMinutes('2026-11-02', 0, [task(30, { status: 'DONE' }), errands, task(15)], 'UTC')).toBe(15);
  });
});
