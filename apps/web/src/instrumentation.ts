/**
 * Runs once when the Next.js server starts.
 *
 * Next compiles this file for the edge runtime as well as Node, so anything
 * Node-only must sit inside the `NEXT_RUNTIME === 'nodejs'` branch: the
 * bundler replaces that variable with a constant per build and drops the
 * whole branch from the edge bundle. An early `return` instead does not get
 * that treatment in development, and the edge build then fails to resolve
 * Node built-ins like `http` — taking every page down with it.
 */
export async function register(): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- Next's runtime discriminator, not a secret; @fluid/env cannot load on the edge.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
