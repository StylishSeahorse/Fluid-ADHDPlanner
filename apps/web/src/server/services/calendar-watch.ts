/**
 * Google push channels: asking Google to tell us when a calendar changes.
 *
 * A channel lives a few days at most and is never renewed in place — a new one
 * is opened before the old expires, and the old one stopped. Push only works
 * when Google can reach this server over public HTTPS (GOOGLE_WEBHOOK_URL);
 * without it, the 10-minute poll is the whole story, and nothing breaks.
 *
 * A notification carries no data we trust. It only says "something changed";
 * the sync that follows re-reads everything over the authenticated API. That
 * is what makes a forged webhook harmless.
 */
import 'server-only';
import { env, features } from '@fluid/env';
import { hashToken } from '@fluid/crypto';
import { prisma } from '@fluid/db';
import { supportsPush } from '@fluid/calendar';
import { adapterFor, connectionRef } from './calendar-sync';

/** Open a replacement when a channel has less than this left. */
const RENEW_WITHIN_MS = 24 * 60 * 60_000;

export async function renewWatches(): Promise<{ opened: number; failed: number }> {
  if (!features.googlePush || !env.GOOGLE_WEBHOOK_URL) return { opened: 0, failed: 0 };

  const calendars = await prisma.calendar.findMany({
    where: {
      connection: { status: 'ACTIVE', provider: 'GOOGLE' },
      OR: [{ isSelected: true }, { isWriteTarget: true }],
      AND: [{ OR: [{ watchExpiresAt: null }, { watchExpiresAt: { lt: new Date(Date.now() + RENEW_WITHIN_MS) } }] }],
    },
    include: { connection: true },
  });

  let opened = 0;
  let failed = 0;

  for (const calendar of calendars) {
    const adapter = adapterFor('GOOGLE');
    if (!supportsPush(adapter)) continue;
    const ref = connectionRef(calendar.connection);

    try {
      const subscription = await adapter.watch(
        ref,
        { id: calendar.id, externalId: calendar.externalId, timeZone: calendar.timeZone },
        env.GOOGLE_WEBHOOK_URL,
      );

      const previous = calendar.watchChannelId && calendar.watchResourceId
        ? { channelId: calendar.watchChannelId, resourceId: calendar.watchResourceId }
        : null;

      await prisma.calendar.update({
        where: { id: calendar.id },
        data: {
          watchChannelId: subscription.channelId,
          watchResourceId: subscription.resourceId,
          watchExpiresAt: subscription.expiresAt,
          // Only the digest is kept: a database read must not be enough to
          // forge a notification.
          watchTokenDigest: hashToken(subscription.token),
        },
      });
      opened += 1;

      if (previous) {
        await adapter
          .unwatch(ref, { ...previous, expiresAt: new Date(), token: '' })
          .catch(() => {}); // An expired channel is already stopped.
      }
    } catch (error) {
      failed += 1;
      console.warn(`[watch] could not open a channel for calendar ${calendar.id}:`, error instanceof Error ? error.message : error);
    }
  }

  return { opened, failed };
}
