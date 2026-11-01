/**
 * The default estimate, for work nobody estimated.
 *
 * A task without an estimate still has to be schedulable: refusing to plan it
 * would punish exactly the quick capture this app wants. So it gets the
 * user's default and is flagged `estimateAssumed`, which every view shows and
 * which keeps the estimation coach from learning from a number nobody chose.
 */
import 'server-only';
import { prisma, type Prisma } from '@fluid/db';

export const FALLBACK_ESTIMATE_MINUTES = 30;

type Client = Prisma.TransactionClient | typeof prisma;

export async function defaultEstimate(userId: string, client: Client = prisma): Promise<number> {
  const preferences = await client.userPreferences.findUnique({
    where: { userId },
    select: { defaultEstimateMinutes: true },
  });
  return preferences?.defaultEstimateMinutes ?? FALLBACK_ESTIMATE_MINUTES;
}

/** Data for a task being created with or without an estimate. */
export async function estimateFields(
  userId: string,
  minutes: number | undefined,
  client: Client = prisma,
): Promise<{ estimateMinutes: number; estimateAssumed: boolean }> {
  return minutes === undefined
    ? { estimateMinutes: await defaultEstimate(userId, client), estimateAssumed: true }
    : { estimateMinutes: minutes, estimateAssumed: false };
}
