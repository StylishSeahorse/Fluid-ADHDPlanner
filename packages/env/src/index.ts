/**
 * The single audited entry point for environment configuration.
 *
 * Every other module in the monorepo imports from here; ESLint's
 * `no-restricted-syntax` rule forbids reading `process.env` anywhere else.
 * That is what keeps secrets out of the client bundle in a Next.js monolith,
 * where server and client code otherwise live in the same source tree.
 *
 * Note there is deliberately no `import 'server-only'` here. That package
 * throws when loaded outside a React Server Component, and this module is also
 * imported by plain Node processes — the seed script, and the background worker
 * — so the guard would break them. It lives in `apps/web/src/server/**`
 * instead, which is where the client/server boundary actually is.
 *
 * The guarantee is therefore carried by three things that do work everywhere:
 * the ESLint rule above, the fact that this module is only ever imported from
 * server code, and `scripts/check-bundle-secrets.mjs`, which greps the built
 * client bundle for real secret values in CI.
 */
import { z } from 'zod';

/** 32 raw bytes, base64-encoded — the AES-256 key size. */
const base64Key32 = z
  .string()
  .min(1, 'ENCRYPTION_KEK is required')
  .refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    'ENCRYPTION_KEK must be 32 bytes, base64-encoded. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
  );

/** Treat empty strings as absent — `.env` files are full of `KEY=`. */
const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const booleanFlag = z
  .enum(['0', '1', 'true', 'false'])
  .default('0')
  .transform((value) => value === '1' || value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  ENCRYPTION_KEK: base64Key32,

  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_WEBHOOK_URL: optionalString,

  ANTHROPIC_API_KEY: optionalString,
  AI_DISABLED: booleanFlag,

  /**
   * Permit a CalDAV server on localhost.
   *
   * Off by default, and it must stay off in production: the SSRF guard's whole
   * job is to stop a URL someone typed from reaching the machine the server
   * runs on. It exists for the person testing against a Radicale container on
   * their own laptop, where "the server" and "their machine" are the same thing.
   */
  CALDAV_ALLOW_LOCALHOST: booleanFlag,

  /**
   * Contact for push services, sent with every Web Push request (VAPID
   * `sub`). Must be a `mailto:` or `https:` URL. Defaults to APP_URL when that
   * is https; push services use it to reach the operator if something misbehaves.
   * The VAPID key pair itself is generated on first use and kept in the database.
   */
  VAPID_SUBJECT: optionalString,

  /** Stop the in-process notification dispatcher, e.g. on a second replica. */
  NOTIFICATIONS_DISABLED: booleanFlag,

  /**
   * Stop this process running background jobs (calendar sync, push-channel
   * renewal). Jobs are safe to run on several replicas at once — BullMQ hands
   * each to one worker — so this is for keeping a replica lean, not for safety.
   */
  WORKER_DISABLED: booleanFlag,

  /**
   * Where uploaded attachments are written. Relative paths resolve from the
   * server's working directory. In Docker this must be a mounted volume, or
   * files vanish with the container.
   */
  STORAGE_DIR: z.string().trim().min(1).default('data/uploads'),
  /** Largest attachment accepted, in megabytes. */
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(500).default(25),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    // Print field names and messages only. Never echo the values — this output
    // routinely ends up in CI logs and terminal scrollback.
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Copy .env.example to .env and fill in the missing values.',
    );
  }

  return parsed.data;
}

export const env: Env = load();

/**
 * Capability probes. Optional integrations are genuinely optional: the app has
 * to run — and be testable — with no Google credentials and no AI key at all.
 */
export const features = {
  /** Google Calendar sync can be configured at all. */
  googleCalendar: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  /** Google can push change notifications; otherwise we fall back to polling. */
  googlePush: Boolean(env.GOOGLE_WEBHOOK_URL?.startsWith('https://')),
  /** Any AI feature may run. `AI_DISABLED=1` forces the deterministic path. */
  ai: !env.AI_DISABLED,
  /** A server-side default key exists (users may still bring their own). */
  aiDefaultKey: !env.AI_DISABLED && Boolean(env.ANTHROPIC_API_KEY),
  /**
   * A locally hosted CalDAV server may be used. Never enable in production —
   * see the note on the variable.
   */
  caldavLocalhost: env.CALDAV_ALLOW_LOCALHOST && env.NODE_ENV !== 'production',
  /** The server sends push notifications on its own schedule. */
  notifications: !env.NOTIFICATIONS_DISABLED && env.NODE_ENV !== 'test',
  /** This process runs the background job worker. */
  worker: !env.WORKER_DISABLED && env.NODE_ENV !== 'test',
} as const;
