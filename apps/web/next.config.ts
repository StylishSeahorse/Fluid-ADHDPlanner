import type { NextConfig } from 'next';

const config: NextConfig = {
  // Traces the runtime dependency graph into `.next/standalone` — a `server.js`
  // plus only the node_modules actually required, rather than the full
  // workspace tree. This is what keeps the Docker runtime image small and
  // free of devDependencies, build tooling, and the other workspace apps.
  output: 'standalone',
  // Workspace packages ship raw TypeScript, so Next compiles them itself.
  transpilePackages: [
    '@fluid/ai',
    '@fluid/calendar',
    '@fluid/core',
    '@fluid/crypto',
    '@fluid/db',
    '@fluid/env',
    '@fluid/net',
  ],
  // Native/binary deps must not be bundled — they're required at runtime.
  // BullMQ loads its Lua scripts from files next to its own source at runtime,
  // so it must be required from node_modules rather than bundled.
  serverExternalPackages: ['@prisma/client', '@node-rs/argon2', 'bullmq', 'ioredis'],
  experimental: {
    // Server Actions receive user input; keep the body bound small.
    serverActions: { bodySizeLimit: '1mb' },
  },
  async headers() {
    return [
      {
        // The service worker must never be served stale: browsers check it
        // for updates, and an HTTP-cached copy would pin every installed app
        // to an old version until the cache expired.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            // No external origins at all: this app loads nothing it did not
            // build, which makes a stray script tag a load failure rather than
            // a data-exfiltration path.
            //
            // 'unsafe-eval' is added in development only. Next's dev-mode hot
            // reload (react-refresh) evaluates code as strings to patch modules
            // in place, and the CSP blocks that outright — the fix is a dev-only
            // relaxation, not a global one. The production bundle never calls
            // eval, so the deployed CSP stays as tight as before.
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "connect-src 'self'",
              // The service worker and the manifest are both same-origin files.
              "worker-src 'self'",
              "manifest-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default config;
