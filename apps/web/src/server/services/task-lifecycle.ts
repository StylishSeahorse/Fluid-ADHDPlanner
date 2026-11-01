/**
 * Finishing a task, and putting it back.
 *
 * Shared by every surface that can complete work — the Today list, the Tasks
 * page, the board — so the side effects (estimate samples, freeing the
 * calendar, where the card goes on its board) are identical no matter where
 * the tap happened. Two copies of this logic is how "done on the board" and
 * "done in My Day" quietly come to mean different things.
 */
import 'server-only';
import type { Prisma, Task, TaskStatus } from '@fluid/db';
import { moveToCategoryColumn } from './boards';

type Tx = Prisma.TransactionClient;

/**
 * Which estimation bucket a task feeds. Plain keyword matching, kept off the
 * AI path on purpose so calibration always runs, AI or not.
 */
export function categoryFor(title: string): string {
  const lower = title.toLowerCase();
  if (/\b(email|reply|respond|message|call)\b/.test(lower)) return 'communication';
  if (/\b(write|draft|report|document|notes?)\b/.test(lower)) return 'writing';
  if (/\b(review|read|check)\b/.test(lower)) return 'review';
  if (/\b(plan|organi[sz]e|prep)\b/.test(lower)) return 'planning';
  if (/\b(code|build|fix|debug|deploy)\b/.test(lower)) return 'development';
  return 'general';
}

/**
 * Mark done. Completion is a property of the task, not a column: the card is
 * moved to its board's Done column as a consequence, not as the definition.
 */
export async function completeTaskInTx(
  tx: Tx,
  userId: string,
  task: Task,
  now: Date,
  options: { moveOnBoard?: boolean } = {},
): Promise<void> {
  await tx.task.update({
    where: { id: task.id },
    data: { status: 'DONE', completedAt: now, lastTouchedAt: now },
  });

  // Feed the estimation coach. Only real observations count — a task
  // completed without any tracked time teaches us nothing.
  // An assumed estimate was nobody's guess, so there is nothing to calibrate.
  if (task.actualMinutes > 0 && !task.estimateAssumed) {
    await tx.timeEstimateSample.create({
      data: {
        userId,
        taskId: task.id,
        category: categoryFor(task.title),
        estimatedMinutes: task.estimateMinutes,
        actualMinutes: task.actualMinutes,
      },
    });
  }

  // Free the calendar: proposed blocks vanish, accepted ones are marked
  // complete rather than deleted, so the week's history stays honest.
  await tx.scheduledBlock.deleteMany({ where: { taskId: task.id, state: 'PROPOSED' } });
  await tx.scheduledBlock.updateMany({
    where: { taskId: task.id, state: 'ACCEPTED' },
    data: { state: 'COMPLETED' },
  });

  if (options.moveOnBoard !== false) await moveToCategoryColumn(tx, task.id, 'DONE');
}

/**
 * Put a finished task back. Reversible means undoing the side effects too,
 * not just flipping the status.
 */
export async function uncompleteTaskInTx(
  tx: Tx,
  userId: string,
  task: Task,
  now: Date,
  options: { status?: TaskStatus; moveOnBoard?: boolean } = {},
): Promise<void> {
  await tx.task.update({
    where: { id: task.id },
    data: { status: options.status ?? 'READY', completedAt: null, lastTouchedAt: now },
  });

  // Drop the sample completing it produced. Leaving it would teach the
  // estimation coach from an event the user just said did not happen.
  const sample = await tx.timeEstimateSample.findFirst({
    where: { taskId: task.id, userId },
    orderBy: { recordedAt: 'desc' },
  });
  if (sample) await tx.timeEstimateSample.delete({ where: { id: sample.id } });

  // Only sessions still ahead of us go back to ACCEPTED. A block whose time
  // has already passed was genuinely sat through.
  await tx.scheduledBlock.updateMany({
    where: { taskId: task.id, state: 'COMPLETED', endsAt: { gt: now } },
    data: { state: 'ACCEPTED' },
  });

  if (options.moveOnBoard !== false) await moveToCategoryColumn(tx, task.id, 'TODO', ['DONE']);
}
