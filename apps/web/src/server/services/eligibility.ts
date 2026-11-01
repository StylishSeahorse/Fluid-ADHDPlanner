/**
 * Which tasks the scheduler may place, in one function (§13.A, REQ-SCH-ELIG).
 *
 * A task is passed to the engine when all of these hold:
 *   1. It belongs to the user.
 *   2. It is not finished, archived, or on an archived board.
 *   3. Auto-scheduling resolves to on — task override, then its column, then
 *      the mode's default (on, except in Manual) — or it is committed to a day
 *      inside the horizon: a day commitment always counts.
 *   4. It is not in a BACKLOG column (or BACKLOG status) unless committed.
 *   5. It still has minutes left.
 *
 * Pinned sessions of any task, eligible or not, are always busy time; that is
 * handled by the caller.
 */
import 'server-only';
import { prisma, type Prisma, type SchedulingMode } from '@fluid/db';
import { startOfLocalDay, type SchedulableTask } from '@fluid/core';

const PREFERRED_WINDOWS = {
  MORNING: { startMinute: 6 * 60, endMinute: 12 * 60, label: 'morning' },
  AFTERNOON: { startMinute: 12 * 60, endMinute: 17 * 60, label: 'afternoon' },
  EVENING: { startMinute: 17 * 60, endMinute: 22 * 60, label: 'evening' },
} as const;

const taskInclude = {
  blockedBy: true,
  column: { select: { category: true, autoSchedule: true } },
  board: { select: { archivedAt: true } },
  project: { select: { name: true, importance: true } },
  area: { select: { countsTowardCapacity: true } },
} satisfies Prisma.TaskInclude;

export type EligibleTask = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

export interface Eligibility {
  /** Tasks for the engine, as rows (for titles, AI hints, gate checks). */
  rows: EligibleTask[];
  /** The same tasks, as the engine's input. */
  schedulable: SchedulableTask[];
}

/** Rule 3 and 4, on one row. Exported for tests and for the card panel's hint. */
export function isEligible(
  task: Pick<EligibleTask, 'status' | 'autoSchedule' | 'plannedFor' | 'estimateMinutes' | 'actualMinutes'> & {
    column: { category: string | null; autoSchedule: boolean | null } | null;
  },
  options: { mode: SchedulingMode; horizonStart: Date; horizonEnd: Date },
): boolean {
  const committed = task.plannedFor !== null && task.plannedFor >= options.horizonStart && task.plannedFor < options.horizonEnd;
  if (task.estimateMinutes - task.actualMinutes <= 0) return false;
  const inBacklog = task.status === 'BACKLOG' || task.column?.category === 'BACKLOG';
  if (inBacklog && !committed) return false;
  const auto = task.autoSchedule ?? task.column?.autoSchedule ?? options.mode !== 'MANUAL';
  return auto || committed;
}

export async function eligibleTasks(
  userId: string,
  options: { now: Date; timeZone: string; horizonDays: number; mode: SchedulingMode },
): Promise<Eligibility> {
  const horizonStart = startOfLocalDay(options.now, options.timeZone);
  const horizonEnd = startOfLocalDay(options.now, options.timeZone, options.horizonDays);

  const candidates = await prisma.task.findMany({
    where: {
      userId,
      completedAt: null,
      archivedAt: null,
      status: { in: ['READY', 'IN_PROGRESS', 'BACKLOG'] },
      OR: [{ boardId: null }, { board: { archivedAt: null } }],
    },
    include: taskInclude,
  });

  const rows = candidates.filter((task) => isEligible(task, { ...options, horizonStart, horizonEnd }));
  const ids = new Set(rows.map((task) => task.id));

  const schedulable: SchedulableTask[] = rows.map((task) => {
    const window = task.preferredWindow ? PREFERRED_WINDOWS[task.preferredWindow] : null;
    return {
      id: task.id,
      title: task.title,
      // Net of work already done, so a half-finished task is not re-planned whole.
      remainingMinutes: Math.max(5, task.estimateMinutes - task.actualMinutes),
      priority: task.priority,
      energy: task.energy,
      ...(task.deadline ? { deadline: task.deadline, deadlineKind: task.deadlineKind } : {}),
      ...(task.earliestStart ? { earliestStart: task.earliestStart } : {}),
      isSplittable: task.isSplittable,
      minChunkMinutes: task.minChunkMinutes,
      maxChunkMinutes: task.maxChunkMinutes,
      // A prerequisite that is not itself eligible (finished, or someone
      // else's) does not hold this task back.
      dependsOn: task.blockedBy.map((dependency) => dependency.prerequisiteId).filter((id) => ids.has(id)),
      ...(task.plannedFor
        ? {
            // A day the user put this on becomes a scheduling window, expanded
            // here because a DST day is not 24 hours long.
            committedTo: {
              start: startOfLocalDay(task.plannedFor, options.timeZone),
              end: startOfLocalDay(task.plannedFor, options.timeZone, 1),
            },
          }
        : {}),
      ...(task.project ? { projectName: task.project.name, projectImportance: task.project.importance } : {}),
      createdAt: task.createdAt,
      ...(window ? { preferredWindow: { ...window } } : {}),
      countsAsWork: task.area?.countsTowardCapacity !== false,
    };
  });

  return { rows, schedulable };
}
