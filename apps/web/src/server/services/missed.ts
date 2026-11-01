/**
 * Missed pinned sessions (§13.B.14).
 *
 * A session a person placed by hand that ended — plus a 15-minute grace —
 * with no timer, no logged time and the task still open is *missed*. Fluid
 * does not move it (that would overrule a human decision); it marks it MISSED
 * and the caller asks, with a recovery proposal, whether to find a new time.
 */
import 'server-only';
import { prisma } from '@fluid/db';

const GRACE_MS = 15 * 60_000;
/** Older than this is history, not something to recover. */
const LOOKBACK_MS = 24 * 60 * 60_000;

/** Mark newly missed sessions. Returns the users who have one. */
export async function markMissedSessions(now: Date): Promise<string[]> {
  const candidates = await prisma.scheduledBlock.findMany({
    where: {
      state: 'ACCEPTED',
      isPinned: true,
      endsAt: { lt: new Date(now.getTime() - GRACE_MS), gt: new Date(now.getTime() - LOOKBACK_MS) },
      OR: [{ actualMinutes: null }, { actualMinutes: 0 }],
      task: { completedAt: null, timerStartedAt: null },
    },
    select: { id: true, task: { select: { userId: true } } },
  });
  if (candidates.length === 0) return [];
  await prisma.scheduledBlock.updateMany({ where: { id: { in: candidates.map((block) => block.id) } }, data: { state: 'MISSED' } });
  return [...new Set(candidates.map((block) => block.task.userId))];
}
