/**
 * Re-registration endpoint for the service worker.
 *
 * When a push service rotates a device's subscription, the service worker gets
 * a `pushsubscriptionchange` event with no page open — so it cannot call a
 * server action. It posts here instead, with the session cookie, and this runs
 * the same tRPC procedure the settings screen uses.
 */
import { z } from 'zod';
import { env } from '@fluid/env';
import { getCaller } from '@/server/caller';

const body = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string(), auth: z.string() }),
  }),
  previousEndpoint: z.string().nullable().optional(),
});

export async function POST(request: Request): Promise<Response> {
  // JSON from another origin needs a CORS preflight we never grant, but say
  // no explicitly as well: this changes where someone's notifications go.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(env.APP_URL).origin && origin !== new URL(request.url).origin) {
    return new Response('Forbidden', { status: 403 });
  }

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response('Bad request', { status: 400 });

  const caller = await getCaller();
  try {
    await caller.notification.subscribe({
      endpoint: parsed.data.subscription.endpoint,
      keys: parsed.data.subscription.keys,
      userAgent: request.headers.get('user-agent') ?? undefined,
    });
    if (parsed.data.previousEndpoint && parsed.data.previousEndpoint !== parsed.data.subscription.endpoint) {
      await caller.notification.unsubscribe({ endpoint: parsed.data.previousEndpoint });
    }
  } catch {
    // Signed out, or a push service we do not deliver to.
    return new Response('Not accepted', { status: 401 });
  }

  return Response.json({ ok: true });
}
