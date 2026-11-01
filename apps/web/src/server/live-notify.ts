/**
 * Announcing changes to open tabs. Called after a change has been saved.
 */
import 'server-only';
import { prisma } from '@fluid/db';
import { publish, userChannel, workspaceChannel, type LiveMessage } from './live';

/** The workspaces a user's changes are visible in. */
async function workspacesOf(userId: string): Promise<string[]> {
  const memberships = await prisma.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true } });
  return memberships.map((membership) => membership.workspaceId);
}

/** Cards, columns or boards changed. */
export async function notifyBoardChange(userId: string, message: Omit<LiveMessage, 'scope'> = {}): Promise<void> {
  const workspaces = await workspacesOf(userId).catch(() => []);
  await publish([userChannel(userId), ...workspaces.map(workspaceChannel)], { scope: 'board', ...message });
}

/** The user's calendar or schedule changed (a sync, a plan). */
export async function notifyCalendarChange(userId: string): Promise<void> {
  await publish([userChannel(userId)], { scope: 'calendar' });
}
