/**
 * Google's push notifications land here.
 *
 * The request says only "calendar X changed". It is checked against the
 * channel we opened (id plus a secret token, stored only as a digest) and, if
 * it matches, a sync is queued. Nothing in the request is trusted beyond that:
 * the sync re-reads over the authenticated API, so a forged notification at
 * worst causes one harmless extra sync.
 */
import { verifyToken } from '@fluid/crypto';
import { prisma } from '@fluid/db';
import { requestSync } from '@/server/jobs/calendar-jobs';

export async function POST(request: Request): Promise<Response> {
  const channelId = request.headers.get('x-goog-channel-id');
  const token = request.headers.get('x-goog-channel-token');
  const state = request.headers.get('x-goog-resource-state');
  if (!channelId || !token) return new Response(null, { status: 400 });

  const calendar = await prisma.calendar.findFirst({
    where: { watchChannelId: channelId },
    select: { connectionId: true, watchTokenDigest: true },
  });
  if (!calendar?.watchTokenDigest || !verifyToken(token, calendar.watchTokenDigest)) {
    // Unknown or stale channel. A 404 also tells Google to stop sending.
    return new Response(null, { status: 404 });
  }

  // "sync" is Google's hello when a channel opens; there is nothing to fetch yet.
  if (state !== 'sync') {
    // A short delay lets a burst of edits settle into one sync.
    await requestSync(calendar.connectionId, 'push', 2_000);
  }
  return new Response(null, { status: 200 });
}
