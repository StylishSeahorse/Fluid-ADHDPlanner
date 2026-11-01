/**
 * Random scheduling inputs for the property tests and for profiling. Seeded,
 * so any failing case is reproducible from its seed alone.
 */
import { addMinutes, localTimeOnDay, startOfLocalDay } from '../time/zoned';
import type { Priority, SchedulableTask, SchedulingInput } from './types';

/** mulberry32: tiny, fast, good enough for test data. */
export function rng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]!,
    chance: (p: number) => next() < p,
  };
}

const ZONES = ['UTC', 'Europe/London', 'America/New_York', 'Asia/Kathmandu', 'Australia/Lord_Howe'] as const;
/** Mondays chosen to sit on or near DST changes in the zones above. */
const ANCHORS = ['2026-03-23', '2026-03-30', '2026-10-26', '2026-11-02', '2026-06-15', '2026-04-06'] as const;
export const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

export function generate(seed: number): SchedulingInput {
  const r = rng(seed);
  const timeZone = r.pick(ZONES);
  const monday = startOfLocalDay(new Date(`${r.pick(ANCHORS)}T12:00:00Z`), timeZone);
  const horizonDays = r.int(1, 5);
  const now = addMinutes(monday, r.int(0, 2 * 24 * 60));
  const dayStart = (offset: number) => startOfLocalDay(monday, timeZone, offset);
  const localAt = (offset: number, minute: number) => localTimeOnDay(dayStart(offset), minute, timeZone);

  const startHour = r.int(6, 10);
  const workingHours = [0, 1, 2, 3, 4, 5, 6]
    .filter(() => r.chance(0.8))
    .map((dayOfWeek) => ({
      dayOfWeek,
      startTime: `${String(startHour).padStart(2, '0')}:00`,
      endTime: `${String(startHour + r.int(4, 9)).padStart(2, '0')}:${r.pick(['00', '30'])}`,
    }));

  const busy = Array.from({ length: r.int(0, 12) }, (_, index) => {
    const start = localAt(r.int(0, horizonDays + 1), r.int(6 * 60, 19 * 60));
    return { start, end: addMinutes(start, r.int(1, 12) * 15), id: `ev${index}`, title: `Event ${index}` };
  });

  // Pinned sessions never overlap each other: a person cannot be in two places.
  const pinned: SchedulingInput['pinned'] = [];
  for (let index = 0; index < r.int(0, 3); index += 1) {
    const start = localAt(r.int(0, horizonDays), r.int(8 * 60, 17 * 60));
    const candidate = { start, end: addMinutes(start, r.int(2, 6) * 15) };
    if (pinned.some((other) => other.start < candidate.end && candidate.start < other.end)) continue;
    pinned.push({ taskId: `pinned${index}`, blockId: `pb${index}`, ...candidate });
  }

  const protectedTimes: SchedulingInput['protectedTimes'] = r.chance(0.5)
    ? [{ kind: 'ROUTINE', label: 'Lunch', dayOfWeek: null, startTime: '12:00', endTime: `12:${r.pick(['30', '45'])}` }]
    : [];

  const count = r.int(0, 10);
  const tasks: SchedulableTask[] = Array.from({ length: count }, (_, index) => {
    const id = `t${index}`;
    const deadline = r.chance(0.5) ? localAt(r.int(0, horizonDays + 2), r.int(9 * 60, 18 * 60)) : undefined;
    const minChunk = r.pick([15, 25, 30]);
    const committedDay = r.chance(0.3) ? r.int(0, horizonDays) : null;
    const task: SchedulableTask = {
      id,
      title: `Task ${index}`,
      remainingMinutes: r.int(1, 16) * 15 - r.pick([0, 0, 5]),
      priority: r.pick(PRIORITIES),
      energy: r.pick(['LOW', 'MEDIUM', 'HIGH'] as const),
      isSplittable: r.chance(0.7),
      minChunkMinutes: minChunk,
      maxChunkMinutes: r.pick([45, 60, 90, 120]),
      ...(deadline ? { deadline, deadlineKind: r.chance(0.4) ? ('HARD' as const) : ('SOFT' as const) } : {}),
      ...(r.chance(0.15) ? { earliestStart: localAt(r.int(0, horizonDays), r.int(9 * 60, 15 * 60)) } : {}),
      ...(committedDay !== null ? { committedTo: { start: dayStart(committedDay), end: dayStart(committedDay + 1) } } : {}),
      ...(r.chance(0.2) ? { preferredWindow: r.pick([{ startMinute: 360, endMinute: 720 }, { startMinute: 720, endMinute: 1020 }]) } : {}),
      ...(r.chance(0.3) ? { projectImportance: r.int(0, 2) } : {}),
      ...(r.chance(0.2) ? { countsAsWork: false } : {}),
    };
    // Dependencies only point backwards, plus the occasional deliberate cycle.
    if (index > 0 && r.chance(0.25)) task.dependsOn = [`t${r.int(0, index - 1)}`];
    return task;
  });
  if (count >= 2 && r.chance(0.05)) tasks[0]!.dependsOn = [`t${count - 1}`];

  return {
    now,
    timeZone,
    horizonDays,
    tasks,
    busy,
    pinned,
    workingHours,
    energyWindows: r.chance(0.3) ? [{ dayOfWeek: null, startTime: '09:00', endTime: '12:00', level: 'HIGH' as const }] : [],
    protectedTimes,
    preferences: {
      bufferMinutes: r.pick([0, 5, 10, 15]),
      slotGranularityMinutes: r.pick([5, 15, 30]),
      ...(r.chance(0.2) ? { maxDailyWorkMinutes: r.int(2, 6) * 60 } : {}),
    },
    ...(r.chance(0.3) ? { quietHours: { start: '21:00', end: '07:00' } } : {}),
  };
}
