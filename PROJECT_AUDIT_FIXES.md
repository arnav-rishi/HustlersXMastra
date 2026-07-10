# Project Audit — Fixes and Remaining Work

Generated: 2026-07-10 — summary of what I fixed during the session and what still remains.

## Summary
- Total audit items reviewed: 39 (see `PROJECT_AUDIT.md`).
- I ran workspace checks, fixed TypeScript errors that caused the CI/build to fail, and got `pnpm run type-check` and `pnpm run test` to succeed locally.

## What I fixed (during this session)
- Resolved multiple TypeScript portability / inferred-type errors by adding explicit type annotations to exported instances in `packages/agents` and `packages/workflows` (addresses TS2742 portability errors).
- Normalized tool result shapes in `packages/agents` (benchmark & compliance agents) so their returned objects match expected types.
- Fixed `apps/api` runtime-safe codepath for `updatedAt` to avoid tests throwing on missing timestamps.
- Added explicit types for `app` and `contractsRouter` in `apps/api` to avoid TS2742 during declaration emit.
- Fixed several implicit `any` callbacks in `packages/workflows` and `apps/api` (catch handlers and array maps).
- Re-ran `pnpm install`, `pnpm run type-check`, and `pnpm run test` — all packages now type-check and the API tests pass.

Files changed (high level):
- `packages/agents/src/*.ts` (type annotations, safe mappers)
- `packages/workflows/src/contract-analysis.ts` (type annotations in catches, `mastra` type)
- `apps/api/src/routes/contracts.ts` (safety around payload, map param types, updatedAt fallback)
- `apps/api/src/index.ts` (typed `app`)

## What remains to be fixed (not done in this session)
These are architectural or repo-level issues from `PROJECT_AUDIT.md` that I did NOT change here:

1. Two divergent agent implementations (`src/mastra/index.ts` vs `packages/agents/src/*`) — decision and porting required.
2. `@mastra/core` major-version split in package.json across the workspace — needs coordinated bump to `^1.50.0` and subsequent code updates.
3. Prisma client generation: `apps/api/node_modules/.prisma` is not present. Run `pnpm db:generate` or `pnpm --filter @lexguard/api run db:generate` before running the real server.
4. `packages/shared/src/schemas/index.ts`: the audit suggested missing exported TS types for several Zod schemas — this was not modified here.
5. Agents' `model` construction shape (should use the SDK-style `azure("gpt-4o")` pattern) — currently still implemented as plain config in many agents; needs refactor.
6. Missing `@lexguard/enkrypt` dependency in `packages/agents/package.json` (if the agents import it) — not added.
7. `packages/workflows` currently references `@prisma/client` in code; consider adding it as dependency or refactoring persistence out of workflows.
8. Missing JWT RSA keypair (`./keys/*.pem`) — generate per README when running real server.
9. No Dockerfiles / deployment artifacts — infra `docker-compose` only brings supporting services.
10. OpenTelemetry duplicate-version cleanup, `dangerouslyAllowAllBuilds` flag, rate-limiter middleware, and other security/hardening items remain.

## Why files may still show red in the editor
If you still see red squiggles in VS Code after these fixes, likely causes and remedies:

- TypeScript language server is using a stale state or the wrong TypeScript version. In VS Code: `Command Palette → TypeScript: Select TypeScript Version → Use Workspace Version` and then reload the window.
- The editor may not have the generated Prisma client available. Run the Prisma generator for the API package:

```bash
pnpm --filter @lexguard/api run db:generate
```

- After `pnpm install` or `pnpm db:generate`, restart the TS server (`Developer: Restart TS Server`) and reload the VS Code window.
- Some fixes I applied are local code workarounds (using `any` or explicit type annotations) — a future cleanup should instead adopt the intended API shapes (e.g., port `packages/agents` to the Mastra 1.x model factory pattern). Until that is done, editor/type errors may persist in places relying on the long-term fix.

## Recommended next actions (commands)

1. Generate Prisma client (required before running `apps/api` in non-test runs):

```bash
pnpm --filter @lexguard/api run db:generate
```

2. Decide Mastra strategy: either
   - Bump `@mastra/core` in `apps/api`, `packages/agents`, `packages/workflows` to `^1.50.0` and port agent construction to SDK model instances; or
   - Consolidate on the `src/mastra/index.ts` implementation and have `packages/workflows` import agents from `@lexguard/agents` (requires removing duplicate implementations).

3. Add missing workspace dependencies if intended (example):

```bash
# from repo root
pnpm --filter @lexguard/agents add -w @lexguard/enkrypt@workspace:*
pnpm --filter @lexguard/workflows add -w @prisma/client@* # or refactor to avoid direct Prisma usage
pnpm install
```

4. Consider adding `prisma generate` to `postinstall` or a turbo `build` dependency to avoid missing generated client at runtime.

5. For deployment: add `Dockerfile` for `apps/api` and `apps/web` (multi-stage builds) and update `docker-compose.yml` to reference images for local integration testing.

## Notes
- I did not change package.json versions, add/remove dependencies, or delete large duplicated agent implementations without explicit direction — those are development-policy decisions that should be approved.
- I created targeted code fixes to unblock type-checks and tests so you can iterate productively. The remaining items are larger-scope tasks that require architectural decisions.

If you want, I can:
- open a branch and create a PR for the smaller repo-level changes (add `@lexguard/enkrypt` to `packages/agents`, add `@prisma/client` to `packages/workflows`, add Prisma generate postinstall), or
- start porting `packages/agents` to the Azure-style `azure("gpt-4o")` model pattern and bump `@mastra/core` across the workspace — this is larger and I can outline a step-by-step plan first.
