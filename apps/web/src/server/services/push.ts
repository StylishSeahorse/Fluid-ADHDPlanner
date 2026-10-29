/**
 * Web Push delivery.
 *
 * The VAPID key pair is generated on first use and stored in the database
 * rather than required as configuration: rotating it silently invalidates every
 * device's subscription, so the safest key is one nobody has to manage. The
 * private half is envelope-encrypted under the KEK like every other secret.
 */
import 'server-only';
import webpush, { type PushSubscription as WebPushSubscription } from 'web-push';
import { env } from '@fluid/env';
import { prisma } from '@fluid/db';
import { openSecret, sealSecret } from '@fluid/crypto';
import { classifyPushFailure, isAllowedPushEndpoint, MAX_PUSH_FAILURES } from './push-endpoint';

const PUBLIC_KEY_ID = 'vapid-public';
const PRIVATE_KEY_ID = 'vapid-private';
/** Server-wide secrets are bound to this owner in the envelope's AAD. */
const SYSTEM_CONTEXT = { userId: 'system', purpose: 'vapid-private-key' } as const;

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let cached: Promise<VapidKeys> | null = null;

async function loadOrCreateKeys(): Promise<VapidKeys> {
  const read = async () => {
    const rows = await prisma.serverKey.findMany({
      where: { id: { in: [PUBLIC_KEY_ID, PRIVATE_KEY_ID] } },
    });
    const publicKey = rows.find((row) => row.id === PUBLIC_KEY_ID)?.value;
    const sealed = rows.find((row) => row.id === PRIVATE_KEY_ID)?.value;
    return publicKey && sealed ? { publicKey, privateKey: openSecret(sealed, SYSTEM_CONTEXT) } : null;
  };

  const existing = await read();
  if (existing) return existing;

  // Two instances starting together may both get here. `skipDuplicates` makes
  // the first insert win, and both then read back the same pair.
  const fresh = webpush.generateVAPIDKeys();
  await prisma.serverKey.createMany({
    data: [
      { id: PUBLIC_KEY_ID, value: fresh.publicKey },
      { id: PRIVATE_KEY_ID, value: sealSecret(fresh.privateKey, SYSTEM_CONTEXT) },
    ],
    skipDuplicates: true,
  });

  const stored = await read();
  if (!stored) throw new Error('Could not store the push notification keys.');
  return stored;
}

function vapidKeys(): Promise<VapidKeys> {
  cached ??= loadOrCreateKeys().catch((error: unknown) => {
    cached = null; // A failed first attempt must not poison every later one.
    throw error;
  });
  return cached;
}

/** The key browsers need to subscribe. Public by design. */
export async function vapidPublicKey(): Promise<string> {
  return (await vapidKeys()).publicKey;
}

function vapidSubject(): string {
  if (env.VAPID_SUBJECT) return env.VAPID_SUBJECT;
  if (env.APP_URL.startsWith('https://')) return env.APP_URL;
  // Push services require a mailto: or https: contact. A local install has
  // neither, and a non-routable address is honest about that.
  return 'mailto:notifications@fluid.invalid';
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  actions?: Array<{ action: string; title: string; url: string }>;
}

export interface DeliveryResult {
  sent: number;
  /** Devices that may succeed later — worth retrying the notification. */
  retryable: number;
  /** Devices removed because the push service said they are gone. */
  removed: number;
}

/** Send one notification to every device the user has subscribed. */
export async function sendToUser(userId: string, payload: PushPayload): Promise<DeliveryResult> {
  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  const result: DeliveryResult = { sent: 0, retryable: 0, removed: 0 };
  if (subscriptions.length === 0) return result;

  const keys = await vapidKeys();
  const body = JSON.stringify(payload);

  await Promise.all(
    subscriptions.map(async (subscription) => {
      // Re-checked at send time, not only at subscribe time, so a row written
      // before the rule existed (or by hand) still cannot be used for SSRF.
      if (!isAllowedPushEndpoint(subscription.endpoint)) {
        await prisma.pushSubscription.delete({ where: { id: subscription.id } }).catch(() => {});
        result.removed += 1;
        return;
      }

      const target: WebPushSubscription = {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      };

      try {
        await webpush.sendNotification(target, body, {
          vapidDetails: { subject: vapidSubject(), ...keys },
          // A reminder that arrives an hour late is worse than none.
          TTL: 15 * 60,
          urgency: 'high',
          timeout: 10_000,
        });
        result.sent += 1;
        await prisma.pushSubscription.update({
          where: { id: subscription.id },
          data: { lastSuccessAt: new Date(), failureCount: 0 },
        });
      } catch (error) {
        const status = error instanceof webpush.WebPushError ? error.statusCode : undefined;
        if (classifyPushFailure(status) === 'GONE') {
          await prisma.pushSubscription.delete({ where: { id: subscription.id } }).catch(() => {});
          result.removed += 1;
          return;
        }

        result.retryable += 1;
        const updated = await prisma.pushSubscription.update({
          where: { id: subscription.id },
          data: { failureCount: { increment: 1 } },
        });
        if (updated.failureCount >= MAX_PUSH_FAILURES) {
          await prisma.pushSubscription.delete({ where: { id: subscription.id } }).catch(() => {});
        }
      }
    }),
  );

  return result;
}
