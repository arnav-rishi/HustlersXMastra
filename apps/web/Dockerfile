# syntax=docker/dockerfile:1
#
# Production image for @lexguard/web. Built from the monorepo root:
#   docker build -f apps/web/Dockerfile -t lexguard-web \
#     --build-arg NEXT_PUBLIC_API_BASE_URL= \
#     --build-arg NEXT_PUBLIC_DEV_TENANT_ID=... \
#     --build-arg API_INTERNAL_URL=http://<api-internal-fqdn>:4000 .
#
# NEXT_PUBLIC_* vars are baked into the client bundle at build time (Next.js
# behavior) — passed as build args, not runtime env vars.
#
# API_INTERNAL_URL is ALSO required as a build arg, not just a runtime one:
# `next build` calls next.config.mjs's rewrites() once and freezes the result
# into .next/routes-manifest.json — the standalone production server does not
# re-evaluate rewrites() per request, so setting API_INTERNAL_URL only at
# `docker run` time silently has no effect (verified locally: the proxy kept
# hitting the build-time default until this was passed as --build-arg).
# Practically: deploy/build the api service first, then build this image with
# its internal address known.

FROM node:20-slim AS base
RUN corepack enable

# ─── Prune the monorepo to @lexguard/web + its workspace deps ────────────────
FROM base AS pruner
WORKDIR /app
COPY . .
RUN npx turbo prune @lexguard/web --docker

# ─── Install deps and build ───────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .
# turbo prune only copies files reachable from the pruned workspace graph, so
# root-level config referenced via `extends` (not a package dependency) has to
# be copied in explicitly.
COPY tsconfig.base.json ./tsconfig.base.json

ARG NEXT_PUBLIC_API_BASE_URL=
ARG NEXT_PUBLIC_QDRANT_DASHBOARD_URL=
ARG NEXT_PUBLIC_DEV_TENANT_ID=
ARG NEXT_PUBLIC_DEV_AUTH_TOKEN=
ARG API_INTERNAL_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    NEXT_PUBLIC_QDRANT_DASHBOARD_URL=$NEXT_PUBLIC_QDRANT_DASHBOARD_URL \
    NEXT_PUBLIC_DEV_TENANT_ID=$NEXT_PUBLIC_DEV_TENANT_ID \
    NEXT_PUBLIC_DEV_AUTH_TOKEN=$NEXT_PUBLIC_DEV_AUTH_TOKEN \
    API_INTERNAL_URL=$API_INTERNAL_URL

RUN pnpm turbo run build --filter=@lexguard/web

# ─── Runtime ───────────────────────────────────────────────────────────────────
# `output: "standalone"` (next.config.mjs) traces only the deps actually used
# at runtime into .next/standalone, so this stage doesn't need node_modules at all.
FROM base AS runner
WORKDIR /app
RUN groupadd --system lexguard && useradd --system --gid lexguard lexguard

ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
# No apps/web/public directory exists in this app today — add a COPY line
# here if one is introduced later (static assets aren't traced automatically).

USER lexguard
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
