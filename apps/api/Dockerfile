# syntax=docker/dockerfile:1
#
# Production image for @lexguard/api. Built from the monorepo root:
#   docker build -f apps/api/Dockerfile -t lexguard-api .
#
# Uses `turbo prune` to cut the monorepo down to just @lexguard/api and the
# workspace packages it actually depends on, so the install/build layers stay
# small and cacheable. Debian slim (not alpine) is used deliberately — Prisma's
# query engine needs glibc/openssl, and alpine's musl libc is a common source
# of "Prisma engine not found" failures in production.

FROM node:20-slim AS base
RUN corepack enable

# ─── Prune the monorepo to @lexguard/api + its workspace deps ────────────────
FROM base AS pruner
WORKDIR /app
COPY . .
RUN npx turbo prune @lexguard/api --docker

# ─── Install deps and build ───────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Installs only the deps needed by the pruned subset (better layer caching).
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .
# turbo prune only copies files reachable from the pruned workspace graph, so
# root-level config referenced via `extends` (not a package dependency) has to
# be copied in explicitly.
COPY tsconfig.base.json ./tsconfig.base.json
RUN pnpm --filter @lexguard/api db:generate
RUN pnpm turbo run build --filter=@lexguard/api

# ─── Runtime ───────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system lexguard && useradd --system --gid lexguard lexguard

ENV NODE_ENV=production
COPY --from=builder /app .
USER lexguard

EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
