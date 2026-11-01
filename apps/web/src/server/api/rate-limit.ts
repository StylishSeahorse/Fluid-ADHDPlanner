/**
 * A fixed-window request counter in Redis, for the public API.
 *
 * Fails open: if Redis is unreachable the request is allowed. The limit is
 * there to stop a runaway script hammering the database, and a Redis outage
 * locking every integration out would be the worse failure.
 */
import 'server-only';
import IORedis from 'ioredis';
import { env } from '@fluid/env';

declare global {
  var __fluidRateLimitRedis: IORedis | undefined;
}

function redis(): IORedis {
  if (!globalThis.__fluidRateLimitRedis) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    connection.on('error', () => {});
    globalThis.__fluidRateLimitRedis = connection;
  }
  return globalThis.__fluidRateLimitRedis;
}

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  resetIn: number;
}

export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const resetIn = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
  const bucket = `ratelimit:${key}:${window}`;
  try {
    const [[, count]] = (await redis().multi().incr(bucket).expire(bucket, windowSeconds + 5).exec()) as [[Error | null, number]];
    return { ok: count <= limit, limit, remaining: Math.max(0, limit - count), resetIn };
  } catch {
    return { ok: true, limit, remaining: limit, resetIn };
  }
}
