# syntax=docker/dockerfile:1.7

# Multi-stage build for both runtime images. `--target web` and `--target worker` share every
# layer up to the build, so a deploy pulls one dependency install rather than two.

# ── base ─────────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# ── dependencies ─────────────────────────────────────────────────────────────────────────
# Only the manifests are copied first, so a source-only change does not invalidate the install
# layer. The lockfile is frozen: a build that would change it should fail, not silently resolve
# different versions than were tested.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/banking/package.json packages/banking/
COPY packages/core/package.json packages/core/
COPY packages/crypto/package.json packages/crypto/
COPY packages/db/package.json packages/db/
COPY packages/detection/package.json packages/detection/
COPY packages/env/package.json packages/env/
COPY packages/logger/package.json packages/logger/
COPY packages/notify/package.json packages/notify/
COPY packages/providers/package.json packages/providers/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ── build ────────────────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so they must be present
# here rather than at runtime. Everything else is read on first request.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build
# Fails the build if a server-only env var name reached the client bundle (brief §9.7).
RUN node scripts/check-client-bundle.mjs

# ── web ──────────────────────────────────────────────────────────────────────────────────
FROM base AS web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Runs unprivileged. The node image ships a `node` user; using it costs nothing and means a
# container escape does not start as root.
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 -G nodejs ledger
COPY --from=build --chown=ledger:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=ledger:nodejs /app/apps/web ./apps/web
COPY --from=build --chown=ledger:nodejs /app/packages ./packages
COPY --from=build --chown=ledger:nodejs /app/package.json /app/pnpm-workspace.yaml ./
USER ledger
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /app/apps/web
CMD ["node_modules/.bin/next", "start", "--port", "3000"]

# ── worker ───────────────────────────────────────────────────────────────────────────────
FROM base AS worker
ENV NODE_ENV=production
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 -G nodejs ledger
COPY --from=build --chown=ledger:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=ledger:nodejs /app/apps/worker ./apps/worker
COPY --from=build --chown=ledger:nodejs /app/packages ./packages
COPY --from=build --chown=ledger:nodejs /app/package.json /app/pnpm-workspace.yaml ./
USER ledger
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /app/apps/worker
# SIGTERM reaches node directly (exec form, no shell wrapper), which is what lets the worker
# drain in-flight jobs instead of being killed mid-sync.
CMD ["node", "dist/index.js"]

# ── migrate ──────────────────────────────────────────────────────────────────────────────
# A one-shot image so migrations run as their own step in the deploy rather than as a side
# effect of the app starting — two web replicas racing the same migration is a bad afternoon.
FROM base AS migrate
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
WORKDIR /app/packages/db
# `node_modules/.bin` here is the PACKAGE's bin dir, not the repo root's: pnpm links a
# dependency's binaries into the node_modules of whichever package declares it, and tsx is a
# dependency of @ledger/db. The root .bin only ever held root-level tooling, so the previous
# `../../node_modules/.bin/tsx` pointed at a file that never existed — and the node image's
# entrypoint masked it by prepending `node`, turning a bad path into MODULE_NOT_FOUND.
CMD ["node_modules/.bin/tsx", "src/migrate.ts"]
