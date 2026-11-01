/**
 * The database refuses two accepted sessions of one person at once — unless a
 * person deliberately put one there (`overlapAck`). These are the places a
 * person does that: dragging a session in the app, moving it in their own
 * calendar app, undoing a change. A move like that is a decision, not a
 * mistake to block, so it is acknowledged instead of refused; the next plan
 * then moves whatever is in the way.
 */
import 'server-only';
import type { Prisma } from '@fluid/db';

type Db = Pick<Prisma.TransactionClient, 'scheduledBlock'>;

/** Would this block, at this time, overlap another accepted session of its owner? */
export async function overlapsOtherSession(db: Db, blockId: string, startsAt: Date, endsAt: Date): Promise<boolean> {
  const block = await db.scheduledBlock.findUnique({ where: { id: blockId }, select: { userId: true, taskId: true } });
  if (!block) return false;
  const clash = await db.scheduledBlock.count({
    where: {
      id: { not: blockId },
      state: 'ACCEPTED',
      overlapAck: false,
      userId: block.userId,
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
  });
  return clash > 0;
}
