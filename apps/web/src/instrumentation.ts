/**
 * Runs once when the Next.js server starts.
 *
 * Starts the push-notification dispatcher. It only makes sense in the Node
 * runtime: the edge runtime has no long-lived process to tick in, and cannot
 * load Prisma or @fluid/env at all — which is also why the runtime check below
 * reads `process.env` directly instead of going through @fluid/env.
 */
export async function register(): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- Next's runtime discriminator, not a secret; @fluid/env cannot load on the edge.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { features } = await import('@fluid/env');
  if (!features.notifications) return;

  const { startNotificationLoop } = await import('./server/services/notifications');
  startNotificationLoop();
}
