import { describe, expect, it } from 'vitest';
import { formatClock, intervalClock, taskClock } from './focus-timers';

describe('focus clocks', () => {
  it('formats short and long durations', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatClock(-5_000)).toBe('0:00');
  });

  it('counts down the interval and then counts past it', () => {
    expect(intervalClock(10 * 60_000, 50)).toEqual({ remainingMs: 40 * 60_000, overMs: 0, fraction: 0.2 });
    const past = intervalClock(53 * 60_000, 50);
    expect(past.remainingMs).toBe(0);
    expect(past.overMs).toBe(3 * 60_000);
    expect(past.fraction).toBe(1);
  });

  it('adds the running session to what was logged before', () => {
    const clock = taskClock(20, 10 * 60_000, 60);
    expect(clock.totalMs).toBe(30 * 60_000);
    expect(clock.fraction).toBe(0.5);
    expect(clock.overEstimate).toBe(false);
    expect(taskClock(55, 10 * 60_000, 60)).toMatchObject({ fraction: 1, overEstimate: true });
  });
});
