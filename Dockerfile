# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Fluid — production image for @fluid/web
#
# Two real stages: `builder` installs the whole monorepo and runs a real
# `next build`; `runner` keeps only what `output: 'standalone'` traced out of
# it — a `server.js` and the node_modules it actually requires at runtime, not
# devDependencies, build tooling, or the other workspace packages' source.
#
# Build from the REPO ROOT, not apps/web — the workspace packages
# (@fluid/core, @fluid/db, ...) have to be in the build context:
#
#   docker build -t fluid-web .
# -----------------------------------------------------------------------------

FROM node:22-alpine AS base
# Next.js's own Docker guidance: a couple of native addons this app depends on
# (Prisma's query engine, @node-rs/argon2) expect glibc-shaped symbols musl
# does not provide unstitched — this compatibility shim closes that gap.
RUN apk add --no-cache libc6-compat
WORKDIR /app

FROM base AS builder
# The whole workspace, not a curated subset — `output: 'standalone'` decides
# afterwards what actually ships. This stage just needs everything present to
# resolve workspace dependencies and compile.
COPY . .
# Runs @fluid/db's `postinstall` (`prisma generate`), which is what produces a
# query engine built for *this* container's musl libc — never copy a
# generated Prisma client in from the host, it will be for the wrong platform.
RUN npm ci

# @fluid/env validates its config eagerly at module load, and `next build`
# imports every route module during page-data collection to build the routes
# manifest — even a `force-dynamic` route that never runs at build time — so
# the build fails without something syntactically valid to parse. These are
# discarded the moment this stage ends: a multi-stage build starts each stage
# with a clean environment, so none of this reaches the `runner` stage or the
# final image. The real values come from the container's actual environment
# at run time — see the `runner` stage and docker-compose.yml.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    REDIS_URL="redis://localhost:6379" \
    ENCRYPTION_KEK="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

RUN npm run build --workspace @fluid/web

FROM base AS runner
# Next's standalone server has no other notion of "development" — set this
# explicitly rather than relying on the default, since a Docker image is
# never the dev environment.
ENV NODE_ENV=production

# Runs as an unprivileged user — the standard hardening step for a container
# that has no reason to run as root once its files are in place.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# ---------------------------------------------------------------------------
# Subscription sign-in providers
#
# The "browser sign-in" providers work by spawning an already-authenticated
# CLI. On a laptop that CLI is the user's own install; in a container there is
# no install and no credentials, so those providers were simply broken here —
# offering a sign-in that could never complete.
#
# Installing the CLIs *into the image* fixes that, because both vendors ship a
# first-party headless login that needs no local browser:
#
#   claude auth login          prints a URL, then "Paste code here if prompted"
#   codex login --device-auth  RFC 8628 device authorization grant
#
# So the login happens inside the container, against the vendor, using their
# own client — no credential scraping from the host, no user-agent spoofing,
# no bind-mounting a laptop's token store into a server. The container ends up
# with its own credentials, which is also what avoids the refresh race you get
# when host and container both write the same token file.
#
# Deliberately in the `runner` stage rather than `base`: the builder has no use
# for them, and this keeps them out of the build cache for source-only changes.
# ---------------------------------------------------------------------------
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
  && npm cache clean --force

# Credentials live in these directories, and they must be writable by the user
# the server actually runs as. Getting this wrong is silent: a login run as
# root writes /root/.claude, the app runs as `nextjs`, and it simply never
# sees the session. Compose mounts volumes here so a login survives a rebuild.
ENV CLAUDE_CONFIG_DIR=/home/nextjs/.claude \
    CODEX_HOME=/home/nextjs/.codex
RUN mkdir -p "$CLAUDE_CONFIG_DIR" "$CODEX_HOME" \
  && chown -R nextjs:nodejs /home/nextjs

# `output: standalone`'s tracing runs from the repo root, so it mirrors the
# monorepo's own layout: the server lands at apps/web/server.js inside the
# traced tree, not at its own root.
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
# Standalone output does not include public/ — and the installable app lives
# there: the service worker, the icons and the offline page. Without this line
# the image serves 404s for all three and Android will not offer to install.
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs

# Matches the port every other script in this repo already uses
# (`next dev -p 3030`, `next start -p 3030`) — kept consistent rather than
# defaulting to Next's usual 3000.
ENV PORT=3030
ENV HOSTNAME=0.0.0.0
EXPOSE 3030

# Configuration — DATABASE_URL, REDIS_URL, ENCRYPTION_KEK and friends — comes
# entirely from the container's real environment at run time (`docker run -e`
# / compose `environment:`), never from a file baked into the image. See
# @fluid/env for what is required and what is optional.
CMD ["node", "apps/web/server.js"]
