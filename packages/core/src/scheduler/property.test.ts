/**
 * Property tests (§13.H): random inputs, invariants that must always hold.
 *
 * A seeded generator rather than a library, so a failure prints a seed that
 * reproduces it exactly. Runs 10,000 cases by default (AC-3.2); set
 * PROPERTY_RUNS to change that, e.g. to explore a million while hunting a bug.
 *
 * The invariants:
 *   - the plan passes `checkPlanInvariants` (no overlap with busy, protected
 *     or pinned time; inside working hours; dependencies and earliest starts)
 *   - every task's minutes are accounted for: placed + reported shortfall
 *   - determinism: the same input gives byte-identical output
 *   - idempotence: re-planning with the output as the previous plan changes
 *     nothing
 */
import { describe, expect, it } from 'vitest';
import { addMinutes, localTimeOnDay, startOfLocalDay } from '../time/zoned';
import { diffPlans } from './diff';
import { checkPlanInvariants, plan } from './plan';
import { generate, PRIORITIES, rng } from './random-input';
import type { Plan, SchedulingInput } from './types';

// The env package forbids process.env elsewhere; tests read it through globalThis.
const RUNS = Number((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.PROPERTY_RUNS) || 10_000;

const serialize = (result: Plan) => JSON.stringify(result);

function accountedFor(input: SchedulingInput, result: Plan): string[] {
  const problems: string[] = [];
  for (const task of input.tasks) {
    const placed = result.blocks
      .filter((block) => block.taskId === task.id)
      .reduce((sum, block) => sum + (block.end.getTime() - block.start.getTime()) / 60_000, 0);
    const shortfall = result.unscheduled.find((entry) => entry.taskId === task.id)?.shortfallMinutes ?? 0;
    if (Math.abs(placed + shortfall - task.remainingMinutes) > 0.001) {
      problems.push(`${task.id}: placed ${placed} + short ${shortfall} != ${task.remainingMinutes}`);
    }
  }
  return problems;
}

describe(`scheduler properties (${RUNS} random inputs)`, () => {
  it('holds every invariant, deterministically and idempotently', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const input = generate(seed);
      let result: Plan;
      try {
        result = plan(input);
      } catch (error) {
        throw new Error(`seed ${seed}: plan() threw: ${(error as Error).message}`);
      }

      const violations = checkPlanInvariants(input, result);
      if (violations.length) throw new Error(`seed ${seed}: ${violations.join('; ')}`);

      const accounting = accountedFor(input, result);
      if (accounting.length) throw new Error(`seed ${seed}: ${accounting.join('; ')}`);

      if (serialize(plan(input)) !== serialize(result)) throw new Error(`seed ${seed}: not deterministic`);

      // Re-plan against our own output, as the orchestrator would a minute later.
      const previous = result.blocks.filter((block) => !block.isPinned);
      const again = plan({ ...input, previous });
      const changes = diffPlans(previous, again.blocks.filter((block) => !block.isPinned), {
        timeZone: input.timeZone,
        now: input.now,
        taskTitles: new Map(),
        trigger: 'manual',
      }).filter((change) => change.kind !== 'UNCHANGED');
      if (changes.length) {
        throw new Error(`seed ${seed}: replanning its own output changed ${changes.map((c) => `${c.kind} ${c.taskId}`).join(', ')}`);
      }
    }
    expect(true).toBe(true);
  }, 120_000);
});

describe('daylight saving', () => {
  const tz = 'Europe/London';
  // 29 March 2026: clocks go forward at 01:00; 25 October: back at 02:00.
  for (const [label, sunday] of [
    ['spring forward', '2026-03-29'],
    ['fall back', '2026-10-25'],
  ] as const) {
    it(`keeps 09:00–17:00 local across the ${label} weekend`, () => {
      const now = startOfLocalDay(new Date(`${sunday}T12:00:00Z`), tz, -1);
      const result = plan({
        now,
        timeZone: tz,
        horizonDays: 4,
        tasks: Array.from({ length: 8 }, (_, index) => ({
          id: `t${index}`,
          title: `t${index}`,
          remainingMinutes: 120,
          priority: 'MEDIUM' as const,
          energy: 'MEDIUM' as const,
          isSplittable: true,
          minChunkMinutes: 25,
          maxChunkMinutes: 90,
        })),
        busy: [],
        pinned: [],
        workingHours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '17:00' })),
        energyWindows: [],
        protectedTimes: [],
        preferences: { bufferMinutes: 10, slotGranularityMinutes: 15 },
      });
      const hour = (date: Date) =>
        Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(date));
      for (const block of result.blocks) {
        expect(hour(block.start)).toBeGreaterThanOrEqual(9);
        expect(hour(new Date(block.end.getTime() - 1))).toBeLessThan(17);
      }
      expect(result.blocks.length).toBeGreaterThan(0);
    });
  }
});

describe('performance', () => {
  it('plans 300 tasks over 14 days around 200 events in under 500 ms', () => {
    const r = rng(42);
    const tz = 'Europe/London';
    const monday = startOfLocalDay(new Date('2026-06-15T12:00:00Z'), tz);
    const at = (offset: number, minute: number) => localTimeOnDay(startOfLocalDay(monday, tz, offset), minute, tz);
    const input: SchedulingInput = {
      now: at(0, 8 * 60),
      timeZone: tz,
      horizonDays: 14,
      tasks: Array.from({ length: 300 }, (_, index) => ({
        id: `t${String(index).padStart(3, '0')}`,
        title: `Task ${index}`,
        remainingMinutes: r.int(1, 8) * 15,
        priority: r.pick(PRIORITIES),
        energy: r.pick(['LOW', 'MEDIUM', 'HIGH'] as const),
        isSplittable: true,
        minChunkMinutes: 25,
        maxChunkMinutes: 90,
        ...(r.chance(0.5) ? { deadline: at(r.int(0, 13), 17 * 60), deadlineKind: r.chance(0.3) ? ('HARD' as const) : ('SOFT' as const) } : {}),
        ...(index > 0 && r.chance(0.1) ? { dependsOn: [`t${String(r.int(0, index - 1)).padStart(3, '0')}`] } : {}),
      })),
      busy: Array.from({ length: 200 }, (_, index) => {
        // 15–30 minute meetings: 200 of them still take a real bite out of
        // two weeks without leaving no working time at all.
        const start = at(r.int(0, 13), r.int(8 * 60, 18 * 60));
        return { start, end: addMinutes(start, r.int(1, 2) * 15), id: `e${index}` };
      }),
      pinned: [],
      workingHours: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '17:00' })),
      energyWindows: [{ dayOfWeek: null, startTime: '09:00', endTime: '12:00', level: 'HIGH' }],
      protectedTimes: [{ kind: 'ROUTINE', label: 'Lunch', dayOfWeek: null, startTime: '12:30', endTime: '13:15' }],
      preferences: { bufferMinutes: 10, slotGranularityMinutes: 15 },
    };
    plan(input); // warm up the JIT and Intl caches, as a long-lived server would be
    const started = performance.now();
    const result = plan(input);
    const elapsed = performance.now() - started;
    // Deliberately oversubscribed (~20,000 minutes of work for ~3,500 free),
    // the worst case for the search: most tasks walk every slot and fail.
    expect(result.stats.scheduledMinutes).toBeGreaterThan(result.stats.availableMinutes * 0.6);
    const accounted = new Set([...result.blocks.map((block) => block.taskId), ...result.unscheduled.map((entry) => entry.taskId)]);
    expect(accounted.size).toBe(300);
    expect(elapsed).toBeLessThan(500);
  });
});
