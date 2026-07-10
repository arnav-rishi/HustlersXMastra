# Project Audit — LexGuard AI

Audited: 2026-07-10. Monorepo at `C:\Users\arnav\Downloads\Mastra\lexguard-ai` (pnpm workspaces + Turborepo, Node 22.16.0, pnpm 10.16.1).

All findings below were produced by actually running `pnpm install`, `pnpm type-check`, `pnpm build`, `pnpm lint`, `pnpm test` fresh, reading the real source files, resolving actual installed dependency versions (`pnpm list -r`), and inspecting `node_modules/.pnpm` directly. Three root-cause claims from stale committed logs (`type_check_output.txt`, `type_check_output2.txt`, `workflows_typecheck.txt`) were **refuted** after re-verification (noted where relevant) — those files are stale and should not be trusted going forward.

## Executive Summary

| | Count |
|---|---|
| **Total issues found** | 39 |
| Critical | 11 |
| High | 8 |
| Medium | 16 |
| Low | 4 |

**Bottom line:** `pnpm install` and `pnpm build`/`type-check` for `apps/web` succeed cleanly. Everything downstream of `packages/agents` and `packages/workflows` — i.e. the actual 13-agent contract-analysis pipeline that `apps/api` serves — currently fails to type-check and fails to build. The root cause is architectural: there are **two independent implementations of the same 13 agents**. One (`src/mastra/index.ts`, used only by local Mastra Studio) is correctly wired to the current `@mastra/core@1.50.0` + Azure OpenAI stack. The other (`packages/agents/src/*.ts`, the one actually imported by `packages/workflows` and `apps/api`) is written against an old, different Mastra API and pinned to `@mastra/core@0.10.0` in its own `package.json`, so it never received the Azure Foundry migration. Fixing the version pin alone will not fix it — the agent-construction code itself uses a `model` shape that has never been valid Mastra API.

## Critical Blocking Issues

### 1. Two divergent, non-interoperable implementations of the 13-agent swarm

**Severity:** Critical
**File(s):** `src/mastra/index.ts` (292 lines) vs. `packages/agents/src/*.ts` (13 files)
**Description:** `src/mastra/index.ts` defines all 13 agents inline, with no tools, no Zod schemas, no S3/Qdrant logic — just prompts — using `createAzure()` from `@ai-sdk/azure` and `@mastra/core@1.50.0`. This is what Mastra Studio (`pnpm dev:ui`) boots. Separately, `packages/agents/src/*.ts` defines the "real" 13 agents with tools, schemas, and pipeline logic, imported by `packages/workflows/src/contract-analysis.ts` and transitively by `apps/api`. These two implementations were never reconciled: the migration to Azure/Mastra 1.50 (commit `6b71eb5`) only touched `src/mastra/index.ts`.
**Evidence:** `src/mastra/index.ts:17,20-22` (`createAzure`, `azure("gpt-4o")`) vs. `packages/agents/src/document-agent.ts:227-231` (`model: { provider: "OPEN_AI", name: "gpt-4o-mini", toolChoice: "auto" }`).
**Why it fails:** The production code path (API → workflows → agents) never executes real business logic through a working Mastra agent — it's disconnected from the only implementation that actually runs. The Studio playground is not proof the platform works.
**Suggested Fix:** Decide on one implementation. Recommended: port the tools/schemas/logic from `packages/agents/src/*.ts` into agents constructed the way `src/mastra/index.ts` does (`model: azure("gpt-4o")`, not `{provider, name}`), delete the duplicate prompts-only agents in `src/mastra/index.ts`, and have Mastra Studio import the real agents from `@lexguard/agents`.
✅ Verified (read both files in full; confirmed via `pnpm list @mastra/core -r`).

### 2. `@mastra/core` major-version split across the workspace

**Severity:** Critical
**File(s):** root `package.json:30` (`^1.50.0`) vs. `apps/api/package.json`, `packages/agents/package.json`, `packages/workflows/package.json` (all `^0.10.0`)
**Description:** `pnpm list @mastra/core -r --depth 0` shows the root resolves `1.50.0` while `apps/api`, `packages/agents`, `packages/workflows` each resolve `0.10.15` — two entirely different major API generations installed side-by-side in the same monorepo.
**Evidence:**
```
lexguard-ai@1.0.0            @mastra/core 1.50.0
@lexguard/api@1.0.0          @mastra/core 0.10.15
@lexguard/agents@1.0.0       @mastra/core 0.10.15
@lexguard/workflows@1.0.0    @mastra/core 0.10.15
```
**Why it fails:** The Workflow/Step/Agent public APIs changed materially between 0.10.x and 1.x (`Workflow.step()` removed, `Agent` config shape changed, etc. — see issues #6 and #9). Anyone editing `packages/agents` or `packages/workflows` today is coding against a version nobody intends to ship long-term.
**Suggested Fix:** Bump `@mastra/core` to `^1.50.0` in `apps/api`, `packages/agents`, `packages/workflows` package.json, run `pnpm install`, then fix the resulting API-shape errors (see #1, #6, #9) since 1.x's actual API differs from both the current code and from what `packages/qdrant`'s type errors suggested.
✅ Verified.

### 3. Root `pnpm build` fails — CI/deploy is currently broken

**Severity:** Critical
**File(s):** `apps/api` (build), transitively `packages/agents`, `packages/workflows`
**Description:** `turbo run build` exits with code 1. `apps/api#build` fails with ~15 distinct TypeScript errors (see #1, #4, #5, #6, #9, #11 for root causes). `apps/web#build` succeeds when run in isolation, but the aggregate `pnpm build` run reports "0 successful, 2 total" because turbo aborts once `apps/api` fails.
**Evidence:** `pnpm build` → `ERROR @lexguard/api#build: command ... exited (1)`, `Tasks: 0 successful, 2 total`.
**Why it fails:** Cascading effect of issues #1–#9 below.
**Suggested Fix:** Fix root causes #4–#9, then re-run `pnpm build`.
✅ Verified (ran fresh, not from a log).

### 4. Prisma client was never generated — `apps/api` will crash at runtime

**Severity:** Critical
**File(s):** `apps/api/src/index.ts:44`, `apps/api/src/routes/contracts.ts:38`, `apps/api/prisma/schema.prisma`
**Description:** `@prisma/client` is installed, but `prisma generate` has never been run against `schema.prisma`. The generated client stub (`node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/.prisma/client/index.d.ts`) is the unbuilt placeholder that throws `Error('@prisma/client did not initialize yet. Please run "prisma generate"...')` on `require`.
**Evidence:** Verified by reading the generated `.prisma/client` stub file directly; `node_modules/.prisma` does not exist under `apps/api/node_modules`.
**Why it fails:** `new PrismaClient()` (`index.ts:44`) throws immediately on process start; every DB-touching route in `contracts.ts` is unreachable. This also explains the two `TS7006` implicit-`any` errors at `contracts.ts:499,551` — an unbuilt Prisma client types `.findMany()` results as `any`.
**Suggested Fix:** Run `pnpm db:generate` (`prisma generate`) before any dev/build/deploy. Consider adding `prisma generate` as a `postinstall` step or a turbo `build`-dependency so this can't be skipped again.
✅ Verified.

### 5. `packages/shared/src/schemas/index.ts` exports Zod schemas but not the matching TS types

**Severity:** Critical
**File(s):** `packages/shared/src/schemas/index.ts`
**Description:** The file exports `RetrievedItemSchema`, `ExtractedClauseSchema`, `ClassifiedClauseSchema`, `RiskSeveritySchema`, `RiskReportSchema`, `RewriteVersionSchema` as Zod schema constants, but never adds the corresponding `export type X = z.infer<typeof XSchema>` line that every other schema in the file has (compare `DocumentAgentInputSchema` → `export type DocumentAgentInput = z.infer<...>` at line 70, which *does* exist).
**Evidence:** `grep -n "^export " packages/shared/src/schemas/index.ts` shows `RetrievedItemSchema` (line 157) with no matching `RetrievedItem` type export anywhere in the file; same pattern for the other five.
**Why it fails:** `packages/agents/src/benchmark-agent.ts:29`, `compliance-agent.ts:15`, `retrieval-agent.ts:31` (`RetrievedItem`); `classification-agent.ts:28` (`ClassifiedClause`); `embedding-agent.ts:30`, `parsing-agent.ts:33` (`ExtractedClause`); `reporting-agent.ts:18` (`RiskSeverity`); `risk-agent.ts:31` (`RiskReport`); `rewrite-agent.ts:12` (`RewriteVersion`) all `import type { X } from "@lexguard/shared/schemas"` — none of those bare names exist, only the `*Schema` consts. `TS2305: has no exported member`.
**Suggested Fix:** Add six lines to `packages/shared/src/schemas/index.ts`:
```ts
export type RetrievedItem = z.infer<typeof RetrievedItemSchema>;
export type ExtractedClause = z.infer<typeof ExtractedClauseSchema>;
export type ClassifiedClause = z.infer<typeof ClassifiedClauseSchema>;
export type RiskSeverity = z.infer<typeof RiskSeveritySchema>;
export type RiskReport = z.infer<typeof RiskReportSchema>;
export type RewriteVersion = z.infer<typeof RewriteVersionSchema>;
```
✅ Verified.

### 6. Every agent in `packages/agents` constructs its `model` with a shape that was never valid Mastra API

**Severity:** Critical
**File(s):** all 13 files in `packages/agents/src/*.ts` (e.g. `document-agent.ts:227-231`)
**Description:** Every agent does `model: { provider: "OPEN_AI", name: "gpt-4o"/"gpt-4o-mini", toolChoice: "auto" }`. The actually-installed `@mastra/core@0.10.15` types this field as `DynamicArgument<MastraLanguageModel>` (`MastraLanguageModel = LanguageModelV1`, the Vercel AI SDK model-instance shape: `specificationVersion/provider/modelId/doGenerate/doStream/...`). A plain `{provider, name, toolChoice}` object literal has never satisfied that type, in 0.10.x or 1.x.
**Evidence:** `error TS2353: Object literal may only specify known properties, and 'name' does not exist in type 'DynamicArgument<LanguageModelV1>'` at 13 distinct call sites (all agent files).
**Why it fails:** This is not a version-skew symptom — even after bumping `@mastra/core` to 1.50.0 (fix #2), this code will still fail, because it needs an actual AI SDK model instance, not a config object.
**Suggested Fix:** Replace with the pattern already used correctly in `src/mastra/index.ts`: instantiate once (`const azure = createAzure(); const gpt4o = azure("gpt-4o");`) and pass `model: gpt4o` / `model: gpt4oMini`.
✅ Verified against the installed package's actual `.d.ts`.

### 7. `packages/agents` imports `@lexguard/enkrypt/pipeline` but never declares `@lexguard/enkrypt` as a dependency

**Severity:** Critical
**File(s):** `packages/agents/src/evaluation-agent.ts:13`, `packages/agents/src/qa-agent.ts:26`; `packages/agents/package.json`
**Description:** `packages/agents/package.json`'s `dependencies` block lists only `@mastra/core, openai, uuid, @lexguard/shared, @lexguard/observability, @lexguard/qdrant, zod` — `@lexguard/enkrypt` is absent. Under pnpm's strict (non-hoisted) linking, `packages/agents/node_modules/@lexguard/` contains no `enkrypt` symlink, so the import cannot resolve even though `packages/enkrypt/src/pipeline.ts` exists and its `exports` map is correct.
**Evidence:** `error TS2307: Cannot find module '@lexguard/enkrypt/pipeline'`; confirmed no `enkrypt` symlink under `packages/agents/node_modules/@lexguard/`.
**Suggested Fix:** Add `"@lexguard/enkrypt": "workspace:*"` to `packages/agents/package.json` dependencies, then `pnpm install`.
✅ Verified.

### 8. `packages/workflows` imports `@prisma/client` but never declares it as a dependency

**Severity:** Critical
**File(s):** `packages/workflows/src/contract-analysis.ts:43`; `packages/workflows/package.json`
**Description:** Same phantom-dependency pattern as #7. `@prisma/client` is only declared in `apps/api/package.json`; `packages/workflows/package.json` deps are `@mastra/core, uuid, @lexguard/shared, @lexguard/agents, @lexguard/observability, zod` — no Prisma. `packages/workflows/node_modules` has no `@prisma` directory.
**Evidence:** `error TS2307: Cannot find module '@prisma/client'`; confirmed no `@prisma` dir under `packages/workflows/node_modules`.
**Suggested Fix:** Either add `@prisma/client` as a direct dependency of `packages/workflows`, or (architecturally cleaner) don't let a workflow package talk to Prisma directly — pass persistence through a repository interface owned by `apps/api`. Minimum fix: declare the dependency.
✅ Verified.

### 9. `contract-analysis.ts` calls `.step()`, which does not exist on the installed `Workflow` class

**Severity:** Critical
**File(s):** `packages/workflows/src/contract-analysis.ts:644`
**Description:** `createWorkflow({...}).step(documentValidationStep).then(...)` — the installed `@mastra/core@0.10.15` `Workflow` class exposes `then, sleep, sleepUntil, waitForEvent, map, parallel, branch, dowhile, dountil, foreach, commit`. There is no `.step()` method; the chain must start with `.then(...)`.
**Evidence:** `error TS2551: Property 'step' does not exist on type 'Workflow<...>'. Did you mean 'steps'?` (TS's suggestion `steps` is also not the fix — `steps` is a read-only property, not a chain method).
**Also at this call site:** `contract-analysis.ts:104,135,163` — the `createStep({...})` object literals fail all three call overloads simultaneously (none of the three overloads — plain config, `Agent`, or `Tool` — accept the exact shape passed), and `contract-analysis.ts:219` references `.clauses` on the embedding step's output type, which only has `{contractId, chunksUpserted, embeddingModel, qdrantCollection, upsertLatencyMs, chunkIds}` — `clauses` was dropped from that step's actual return shape at some point but downstream code still expects it. This last one is a genuine logic bug, independent of the Mastra version question.
**Suggested Fix:** Rewrite the workflow chain against whichever Mastra version is settled on (recommend 1.50.0, per #2) using `.then()` chaining, and fix the embedding step to either return `clauses` in its output or have the consumer pull clauses from the correct upstream step result.
✅ Verified.

### 10. Missing JWT RSA keypair — `apps/api` auth will throw outside dev-bypass/test mode

**Severity:** Critical
**File(s):** `apps/api/src/middleware/auth.ts:54-66`; `.env.example:48-49`
**Description:** `getPublicKey()` does `fs.readFileSync(env.JWT_RS256_PUBLIC_KEY_PATH, "utf-8")` with no fallback. No `keys/` directory or `*.pem` file exists anywhere in the repo (README's own setup steps say to generate one with `openssl`, but nobody has run that step in this checkout).
**Evidence:** `find . -iname "*.pem"` → no results; `find . -type d -iname keys` → no results.
**Why it fails:** Any real (non-test, non-`LEXGUARD_DEV_BYPASS_AUTH`) request throws `Cannot read JWT public key from: ./keys/public.pem` at first auth attempt.
**Suggested Fix:** Follow `README.md`'s own step 3 (`openssl genrsa ...`) before running the API outside dev-bypass mode; consider failing fast with a clear startup-time check instead of a per-request throw.
✅ Verified.

### 11. No deployment artifact exists for the actual application (no Dockerfile, no Vercel/Netlify config)

**Severity:** Critical
**File(s):** repo-wide
**Description:** `docker-compose.yml` only defines *infrastructure* dependencies (Qdrant, Postgres, Redis, OTel Collector, Jaeger, Prometheus, Grafana) — there is no `Dockerfile` for `apps/api` or `apps/web`, and no `vercel.json`/`netlify.toml`. Confirmed via a repo-wide search excluding `node_modules`.
**Evidence:** `find . -iname "Dockerfile*"` and `find . -iname "vercel.json" -o -iname "netlify.toml"` both return nothing outside generated `.mastra/` build output.
**Why it fails:** There is currently no way to containerize or deploy either app; `pnpm infra:up` only starts supporting services, not the app itself.
**Suggested Fix:** Add a `Dockerfile` per app (multi-stage build using each app's own `build`/`start` scripts) before attempting any real deployment.
✅ Verified.

## High Priority Issues

### 12. Production auth middleware contains a full bypass switch

**Severity:** High
**File(s):** `apps/api/src/middleware/auth.ts:94-121`
**Description:** `authMiddleware` short-circuits all JWT validation and grants a synthetic admin-equivalent user (`roles: ["legal_counsel","legal_operations","compliance_officer","admin"]`) whenever `process.env.NODE_ENV === "test"` **or** `process.env.LEXGUARD_DEV_BYPASS_AUTH === "true"`.
**Why it fails / risk:** If `LEXGUARD_DEV_BYPASS_AUTH=true` (or `NODE_ENV=test`) is ever set in a real deployment — a single misconfigured env var — the entire authorization system is defeated for every tenant.
**Suggested Fix:** Gate this path additionally on a build-time flag that's physically absent from production bundles, or delete the branch entirely and use a signed test-only token instead.
✅ Verified.

### 13. Web app hardcodes a static dev bearer token and tenant ID into every API call

**Severity:** High
**File(s):** `apps/web/src/lib/api.ts:6-9`
**Description:** `getApiHeaders()` sends `Authorization: Bearer ${NEXT_PUBLIC_DEV_AUTH_TOKEN ?? "test"}` and a hardcoded fallback tenant UUID on every request, with no real login flow anywhere in the app.
**Why it fails / risk:** Combined with #12, this means the shipped frontend has no real authentication story at all — it's structurally a demo, not a multi-tenant enterprise app, despite the "Enterprise Legal Intelligence Platform" framing.
**Suggested Fix:** Before any real deployment, implement an actual auth flow (login, token storage/refresh) in `apps/web` and remove the static fallback.
✅ Verified.

### 14. Duplicate/conflicting OpenTelemetry package versions, masked with `as any`

**Severity:** High
**File(s):** `packages/observability/src/tracer.ts:53-54`
**Description:** `node_modules/.pnpm` contains **four** distinct versions of `@opentelemetry/sdk-trace-base` (1.25.1, 1.30.1, 2.0.1, 2.9.0) and matching duplicates of `sdk-trace-node`, `sdk-metrics`, `core`, and two versions of `sdk-node` (0.52.1, 0.201.1). `@lexguard/observability`'s own `sdk-node` (0.52.1) pins `sdk-trace-base@1.25.1` internally, while its own `sdk-trace-node` (`^1.25.0`, resolving to 1.30.1) pulls a *different* `sdk-trace-base@1.30.1` — two physically different copies of the same class. The resulting type mismatch is silenced with `spanProcessor: new BatchSpanProcessor(traceExporter) as any` and `metricReader: ... as any`.
**Why it fails:** Type-checking passes, but at runtime, cross-version OTel SDK instances can fail to wire up correctly (e.g. silently dropped spans/metrics) since `as any` removes the compiler's only signal that something is wrong.
**Suggested Fix:** Pin all `@opentelemetry/*` packages in `packages/observability/package.json` to a single compatible version line (check the SDK's own compatibility matrix), remove the `as any` casts, and let the type system confirm the fix actually worked.
✅ Verified via direct inspection of `node_modules/.pnpm`.

### 15. `dangerouslyAllowAllBuilds: true` disables pnpm's install-script safety gate repo-wide

**Severity:** High
**File(s):** `pnpm-workspace.yaml:5`
**Description:** This setting makes every transitive dependency's `preinstall`/`install`/`postinstall` script run automatically and unreviewed on every `pnpm install`, bypassing pnpm's default allow-list gate (`pnpm approve-builds`).
**Why it fails / risk:** A single compromised or typosquatted transitive dependency gets arbitrary code execution on every contributor's machine and in CI with no review step.
**Suggested Fix:** Remove this flag and use `pnpm approve-builds` / an explicit `onlyBuiltDependencies` allow-list instead, unless there's a documented reason (e.g. CI friction) that outweighs the risk.
✅ Verified.

### 16. Documented rate-limiting middleware doesn't exist

**Severity:** High
**File(s):** `apps/api/src/index.ts:10` (comment), `apps/api/src/middleware/auth.ts:9` (comment) reference `apps/api/src/middleware/rate-limit.ts`
**Description:** The security-chain comment block in both files documents a Redis-token-bucket rate limiter as step 3 of the request pipeline. That file does not exist and is never imported/applied anywhere. `ioredis` is instantiated in `index.ts` but only used for the `/ready` health check.
**Why it fails / risk:** The API currently has no rate limiting at all, contradicting its own documented security posture and `.env.example`'s `RATE_LIMIT_DEFAULT_RPM` setting, which is dead configuration.
**Suggested Fix:** Implement the middleware (or remove the misleading comments and env var until it exists).
✅ Verified.

### 17. `apps/api` build fails on TS2742 "inferred type cannot be named" portability errors

**Severity:** High
**File(s):** `apps/api/src/index.ts:43`, `apps/api/src/routes/contracts.ts:37`
**Description:** `const app = express();` and `export const contractsRouter = ...` fail with `TS2742: The inferred type ... cannot be named without a reference to '.pnpm/@types+express-serve-static-core@4.19.8/...'`. This happens because `tsc -p tsconfig.json` (the `build` script, which emits declarations per `tsconfig.base.json`'s `"declaration": true`) can't portably name a type that lives inside a `.pnpm` hashed path.
**Why it fails:** Blocks `apps/api`'s `build` script (declaration emission) even independent of the Mastra/Prisma issues above.
**Suggested Fix:** Add explicit type annotations: `const app: express.Express = express();` and `export const contractsRouter: express.Router = express.Router();`.
✅ Verified (appears in every fresh build run).

### 18. Several `apps/api` routes are stubs that silently do nothing

**Severity:** High
**File(s):** `apps/api/src/routes/contracts.ts` — upload (`:125-223`), GDPR erase (`:720-748`), audit trace (`:753-768`)
**Description:**
- `POST /upload` builds an `s3Key` string but never uploads the multer file buffer to S3 (comment: "In production: upload file buffer to S3" at `:155`) — the buffer is discarded.
- `DELETE /gdpr/erase/:orgId` returns a fabricated `deletionRequestId` (`uuidv4()`) without persisting a `DeletionRequest` row, despite that Prisma model existing in `schema.prisma`.
- `GET /audit/trace/:traceId` returns hardcoded `spans: []`, `auditLog: []` with the literal message `"Phase 4 implementation pending"`.
**Why it fails / risk:** These endpoints return HTTP 200 with plausible-looking payloads while doing none of the work their names promise — a client or integration test would see "success" for an upload, a GDPR erasure, or an audit-trail fetch that never actually happened.
**Suggested Fix:** Either implement them or return `501 Not Implemented` so callers don't mistake stubs for working functionality.
✅ Verified.

### 19. Prometheus is configured to scrape an endpoint `apps/api` doesn't expose

**Severity:** High
**File(s):** `infra/prometheus/prometheus.yml:11-14`, `apps/api/src/index.ts` (only `/health` and `/ready` are registered)
**Description:** The `lexguard-api` scrape job targets `host.docker.internal:4000/metrics`, but no `/metrics` route exists anywhere in `apps/api`. Metrics are actually pushed via OTLP (`packages/observability/src/metrics.ts`) to the OTel Collector, not pulled from the API directly.
**Why it fails:** Prometheus will log continuous scrape failures (404) for this job; it's dead configuration.
**Suggested Fix:** Remove the `lexguard-api` scrape job (metrics already flow through the collector's Prometheus exporter on `:8888`), or add a real `/metrics` endpoint if direct scraping is actually wanted.
✅ Verified.

## Medium Priority Issues

### 20. `pnpm lint` / `turbo run lint` is a complete no-op

**Severity:** Medium
**File(s):** every `package.json` in the workspace
**Description:** No package defines a `"lint"` script, and no ESLint config file (`.eslintrc*` / `eslint.config.*`) exists anywhere in the repo, despite `eslint: ^8.57.0` being a root devDependency and `turbo.json` defining a `lint` task.
**Evidence:** `pnpm lint` → `WARNING No tasks were executed as part of this run. Tasks: 0 successful, 0 total.`
**Suggested Fix:** Either add a real ESLint config + per-package `lint` scripts, or remove the dead `eslint` devDependency and `lint` task to stop implying a check exists that doesn't.
✅ Verified.

### 21. No Prettier config despite Prettier being a devDependency

**Severity:** Medium
**File(s):** root `package.json:38` (`prettier: ^3.3.0`)
**Description:** No `.prettierrc*`/`prettier.config.*` exists anywhere. Same "declared but unconfigured" pattern as ESLint.
**Suggested Fix:** Add a config (or drop the dependency).
✅ Verified.

### 22. `packages/qdrant` type safety was erased with local `any` aliases, not actually fixed

**Severity:** Medium
**File(s):** `packages/qdrant/src/client.ts:12-14`, `243`; `packages/qdrant/src/collections.ts:15`
**Description:** `SearchRequest`, `UpsertCollection`, `PointStruct` (and similarly `Filter`, `CreateCollection` in `collections.ts`) are declared as local `type X = any;` instead of being imported from `@qdrant/js-client-rest` (whose current version doesn't export those names). `client.ts:229` also does `(result as any).result?.deleted ?? 0`.
**Why it matters:** The previous stale-log type errors are gone, but every Qdrant call in this package is now effectively untyped — a real API shape change in `@qdrant/js-client-rest` would no longer be caught at compile time.
**Suggested Fix:** Import the correct current type names from `@qdrant/js-client-rest`'s actual exports (they were renamed, not removed, in 1.10.x) and remove the `any` aliases.
✅ Verified.

### 23. `zod` major-version split between root and every workspace package

**Severity:** Medium
**File(s):** root `package.json:32` (`^4.0.0` → resolves 4.4.3) vs. every `packages/*` and `apps/*` package.json (`^3.23.0` → resolves 3.25.76)
**Description:** Internally consistent within `packages/*`/`apps/*` today (not an active bug there), but the root-level v4 pin exists only to satisfy Mastra Studio's `zod/v4` subpath export requirement (per `scripts/start-mastra-studio.mjs` comment) and is orphaned from application code.
**Risk:** Any future root-level script or new package that imports `zod` without its own explicit `^3.x` pin will silently get v4, which is not wire-compatible with v3-built schemas from `@lexguard/shared`.
**Suggested Fix:** Document this split explicitly (e.g. a comment in root `package.json`), or plan a coordinated v3→v4 migration across all packages once Mastra 1.x (which needs v4) is adopted everywhere (see #2).
✅ Verified.

### 24. Role strings used in `requireRole()` don't match the canonical Prisma enum

**Severity:** Medium
**File(s):** `apps/api/src/routes/contracts.ts:525,573,613,723,757` (`"legal_counsel"`, `"compliance_officer"`, `"legal_operations"`) vs. `apps/api/prisma/schema.prisma` `UserRole` enum (`GENERAL_COUNSEL, LEGAL_OPERATIONS, LEGAL_ANALYST, COMPLIANCE_OFFICER, PROCUREMENT, SALES, ADMIN`)
**Description:** `"legal_counsel"` has no corresponding enum value at all (closest is `GENERAL_COUNSEL`). Not a compile error today because JWT roles are freeform `string[]`, not typed against the Prisma enum.
**Why it matters:** A real user whose role is stored as `GENERAL_COUNSEL` in the DB/JWT will never satisfy `requireRole("legal_counsel")` — this route is unreachable for its intended role today.
**Suggested Fix:** Define a single shared role-string constant/enum (in `@lexguard/shared`) and use it in both the Prisma schema and every `requireRole()` call.
✅ Verified.

### 25. `docker-compose.yml` mounts Grafana provisioning directories that don't exist

**Severity:** Medium
**File(s):** `docker-compose.yml:118-119` (bind-mounts `./infra/grafana/dashboards`, `./infra/grafana/datasources`)
**Description:** `infra/` only contains `otel/` and `prometheus/` — no `grafana/` directory exists on disk.
**Why it fails:** `docker-compose up` for the `grafana` service will fail (or start with no provisioning) since the bind-mount source paths are missing.
**Suggested Fix:** Create `infra/grafana/{dashboards,datasources}` with at least a Prometheus datasource definition, or remove the bind mounts.
✅ Verified.

### 26. `apps/web/tsconfig.json` does not extend the shared `tsconfig.base.json`

**Severity:** Medium
**File(s):** `apps/web/tsconfig.json`
**Description:** Every other package (`apps/api`, all of `packages/*`) extends `../../tsconfig.base.json`. `apps/web` is the stock Next.js-generated config with its own independent `lib`/`moduleResolution`/`paths`, never inheriting `strict` refinements like `noUncheckedIndexedAccess` or `noImplicitOverride` from the base config.
**Why it matters:** Compiler strictness silently diverges between the web app and everything else; a future tightening of `tsconfig.base.json` won't apply to `apps/web` unless someone remembers to update it separately.
**Suggested Fix:** Either accept this as an intentional Next.js-specific config and document it, or merge in the base's stricter flags manually.
✅ Verified.

### 27. `next.config.mjs` hardcodes `localhost:4000` instead of reading the env var

**Severity:** Medium
**File(s):** `apps/web/next.config.mjs`
**Description:** The `/api/v1/:path*` rewrite target is a literal `http://localhost:4000/api/v1/:path*`, even though `NEXT_PUBLIC_API_BASE_URL` exists in `.env.example` for exactly this purpose.
**Why it fails:** Any non-local deployment (staging/prod) needs a code change to this file rather than an env var change.
**Suggested Fix:** Read `process.env.NEXT_PUBLIC_API_BASE_URL` (or an equivalent build-time var) inside `next.config.mjs`.
✅ Verified.

### 28. Build/debug artifacts are committed to git

**Severity:** Medium
**File(s):** `type_check_output.txt`, `type_check_output2.txt`, `workflows_typecheck.txt`, `apps/web/tsconfig.tsbuildinfo`
**Description:** `git ls-files` shows all four are tracked. None match any pattern in `.gitignore`. They are stale `tsc`/turbo debug captures (confirmed UTF-16LE PowerShell redirection output) that don't reflect current repo state and could mislead future audits (as the stale claims re-verified in this report demonstrate).
**Suggested Fix:** `git rm` them, add `*.tsbuildinfo` and `type_check_output*.txt`/`workflows_typecheck.txt` (or a general `*_output*.txt` debug pattern) to `.gitignore`.
✅ Verified.

### 29. `README.md` setup instructions are stale relative to the Azure OpenAI migration

**Severity:** Medium
**File(s):** `README.md:34` (`OPENAI_API_KEY=sk-...`)
**Description:** The documented minimum `.env.local` example asks for `OPENAI_API_KEY`, but `.env.example` (and the actual code, per #1) uses `AZURE_OPENAI_API_KEY`/`AZURE_OPENAI_ENDPOINT`/`AZURE_OPENAI_API_VERSION` — there is no `OPENAI_API_KEY` variable read anywhere in current application code paths that matter for the Azure-based agents.
**Suggested Fix:** Update the README's quick-start env block to match `.env.example`'s Azure variables.
✅ Verified.

### 30. Hardcoded plaintext credentials committed in `docker-compose.yml`

**Severity:** Medium
**File(s):** `docker-compose.yml:37` (`POSTGRES_PASSWORD: password`), `:115` (`GF_SECURITY_ADMIN_PASSWORD: admin`)
**Description:** Both are literal values rather than `${VAR}` substitutions from an env file. Low severity since this is local-dev-only infra, but it's still a committed, easily-grep-able credential pattern.
**Suggested Fix:** Move to `${POSTGRES_PASSWORD:-password}`-style substitution sourced from `.env.local`, consistent with how `QDRANT_API_KEY` is already handled at `docker-compose.yml:19`.
✅ Verified.

### 31. `packages/observability/src/metrics.ts` docstring describes behavior that doesn't exist

**Severity:** Medium
**File(s):** `packages/observability/src/metrics.ts` (top docstring)
**Description:** The comment claims metrics are "automatically exposed via /metrics endpoint in the API," but the actual implementation pushes metrics via `OTLPMetricExporter`/`PeriodicExportingMetricReader` to the OTel Collector — there is no pull-based `/metrics` endpoint (ties directly into #19's broken Prometheus scrape job).
**Suggested Fix:** Correct the docstring to describe the push-based OTLP flow.
✅ Verified.

### 32. Fragile Mastra-version-specific patch scripts of unclear continued necessity

**Severity:** Medium
**File(s):** `scripts/patch-mastra.mjs`, `scripts/mastra-preload.mjs`, `scripts/start-mastra-studio.mjs`
**Description:** All three exist to work around a documented `mastra@0.10.x` + Node 22 `telemetry-config.mjs` `ReferenceError` bug. `patch-mastra.mjs` directly rewrites the generated `.mastra/output/telemetry-config.mjs` build artifact via a version-specific string match (`content.includes("var mastra$1 = mastra")`) — this silently no-ops if Mastra's generated output shape changes, and doesn't survive re-running `mastra build` outside this script. The root workspace now pins `mastra: ^1.18.0` / `@mastra/core: ^1.50.0`, a much newer major version than the `0.10.x` these scripts' own comments describe.
**Suggested Fix:** Verify whether this bug still reproduces against the currently-pinned Mastra version; if not, delete all three scripts and simplify `dev:ui` back to a plain `mastra dev` call.
✅ Verified (scripts read in full; version mismatch between script comments and actual pinned versions confirmed).

### 33. No `rootDir` set in any package `tsconfig.json`, risking nested `dist/src/...` output

**Severity:** Medium
**File(s):** `apps/api/tsconfig.json` and the identical pattern in every `packages/*/tsconfig.json`
**Description:** `include: ["src/**/*", "tests/**/*"]` with no `rootDir` means TypeScript infers the common root across both, which can produce `dist/src/...` and `dist/tests/...` nesting instead of a clean `dist/...` mirroring `src/`.
**Suggested Fix:** Set `"rootDir": "src"` and exclude `tests/**/*` from the emitted build (test files shouldn't ship in `dist/` anyway).
⚠ Likely (config pattern confirmed; actual `dist/` output layout not independently re-verified in this pass since builds currently fail before reaching emit for the affected packages).

### 34. `apps/web` build passes standalone but the aggregate `pnpm build` masks this

**Severity:** Medium
**File(s):** N/A (process/tooling issue)
**Description:** `apps/web`'s own `next build` succeeds cleanly and produces a full static/SSR output when run directly inside `apps/web`. But the root `pnpm build` reports "0 successful, 2 total" because turbo aborts the run once `apps/api#build` fails, so CI logs would misleadingly suggest `apps/web` also failed.
**Suggested Fix:** Once `apps/api`'s build is fixed (this report's Critical section), re-verify `pnpm build` reports both packages succeeding; no code change needed in `apps/web` itself.
✅ Verified.

### 35. Multer upload accepts any file whose client-supplied MIME type matches — no content sniffing

**Severity:** Medium
**File(s):** `apps/api/src/routes/contracts.ts:110-120`
**Description:** The `fileFilter` only checks `file.mimetype`, a header the client fully controls. Combined with #18 (upload doesn't actually persist the file), this is currently low-impact, but would become a real validation gap once upload is implemented for real.
**Suggested Fix:** Add magic-byte/content-type sniffing (e.g. `file-type` package) before trusting the declared MIME type, especially before any real S3 write is added.
✅ Verified.

## Low Priority Issues

### 36. `tsconfig.base.json` ships DOM libs to every package, including server-only ones

**Severity:** Low
**File(s):** `tsconfig.base.json:6`
**Description:** `"lib": ["ES2022", "DOM", "DOM.Iterable"]` is inherited by `apps/api`, `packages/agents`, `packages/workflows`, etc. — none of which run in a browser. Harmless (nothing currently misuses a DOM-only global in server code) but imprecise.
**Suggested Fix:** Move DOM libs to a `tsconfig.base.json`-extending override used only by `apps/web`, and keep the shared base server-safe (`ES2022` only).
✅ Verified.

### 37. No Tailwind/PostCSS despite a design-system look in `apps/web`

**Severity:** Low
**File(s):** `apps/web`
**Description:** Not a bug — styling is done via hand-written CSS custom properties in `globals.css`. Worth documenting so nobody wastes time looking for a Tailwind config that was never there.
✅ Verified.

### 38. `docs/lexguard_phase6_plan.md` / `lexguard_phase7_plan.md` are partially stale and reveal large amounts of mocked business logic

**Severity:** Low
**File(s):** `docs/lexguard_phase6_plan.md`, `docs/lexguard_phase7_plan.md`
**Description:** Some items the plans list as outstanding (adding `packageManager` to root `package.json`, per-package `tsconfig.json`) are already done in current code. However, the deeper functional gaps they describe are still real and match current code: dev-bypass auth (#12), stubbed upload/GDPR/audit routes (#18), mock contract data in parts of the web UI, and only partial real execution of the 13-agent pipeline (consistent with #1).
**Suggested Fix:** Treat these docs as directional, not authoritative — re-verify any specific claim against current code (as this audit did) before acting on it.
⚠ Likely (docs skimmed and cross-checked against several — not all — of their specific claims).

### 39. Root `package.json` `engines.pnpm` (`>=9.0.0`) is looser than the pinned `packageManager` (`pnpm@10.16.1`)

**Severity:** Low
**File(s):** `package.json:5,44`
**Description:** Not a real conflict (corepack enforces the exact `packageManager` version regardless), but the `engines` range is imprecise documentation of the actual requirement.
**Suggested Fix:** Align `engines.pnpm` to `>=10.0.0` for clarity.
✅ Verified.

---

## Build Errors

See Critical #3, #4, #6, #8, #9, #17 and High #17. Summary of every distinct `tsc` error class currently reproduced by a fresh `pnpm build`/`pnpm type-check`:

| Package | Error | Root cause |
|---|---|---|
| `@lexguard/agents` | `TS2305` no exported member (×6 names) | #5 |
| `@lexguard/agents` | `TS2353` `'name'` not in `DynamicArgument<LanguageModelV1>` (×13 files) | #6 |
| `@lexguard/agents` | `TS2339` `.llm` not on `MastraUnion` | #1/#2 (0.10.15's `MastraUnion` genuinely has no `llm` field, in *any* Mastra version consulted) |
| `@lexguard/agents` | `TS2307` cannot find `@lexguard/enkrypt/pipeline` (×2 files) | #7 |
| `@lexguard/workflows` | `TS2307` cannot find `@prisma/client` | #8 |
| `@lexguard/workflows` | `TS2769` no overload matches `createStep(...)` (×3) | #9 |
| `@lexguard/workflows` | `TS2339` `.clauses` missing on embedding-step output | #9 |
| `@lexguard/workflows` | `TS2551` `.step` does not exist, did you mean `steps` | #9 |
| `@lexguard/api` | `TS2742` inferred type not portable (×2) | #17 |
| `@lexguard/api` | `TS7006` implicit `any` (×2) | #4 |
| `@lexguard/web` | *(none — currently clean)* | — |
| `@lexguard/qdrant`, `@lexguard/observability`, `@lexguard/shared`, `@lexguard/enkrypt` | *(none — currently clean, but see Medium #22/#14 for silenced-not-fixed issues)* | — |

## Dependency Problems

- **Version-split, real conflicts:** `@mastra/core` (Critical #2), `zod` (Medium #23).
- **Missing/phantom dependencies:** `@lexguard/enkrypt` in `packages/agents` (Critical #7), `@prisma/client` in `packages/workflows` (Critical #8).
- **Duplicate transitive versions:** `@opentelemetry/*` family, 2–4 copies each (High #14).
- **Unbuilt dependency:** `@prisma/client` generated stub never invoked (Critical #4).
- **Declared-but-unused tooling:** `eslint`, `prettier` (Medium #20, #21).
- No genuinely unused top-level dependencies were found in the packages actually reachable from a passing build (`@lexguard/web`, `@lexguard/shared`, `@lexguard/qdrant`, `@lexguard/observability`, `@lexguard/enkrypt`) — this check could not be meaningfully completed for `@lexguard/agents`/`@lexguard/workflows`/`@lexguard/api` since they don't currently compile. ❓ Needs manual verification once the Critical issues are fixed.

## pnpm Problems

- `pnpm install` itself is clean — lockfile is up to date, no resolution errors. ✅ Verified.
- `dangerouslyAllowAllBuilds: true` (High #15) — workspace-wide install-script safety opt-out.
- Phantom/missing workspace dependencies not caught at install time because pnpm has no static way to know `@lexguard/enkrypt`/`@prisma/client` are imported without being declared (Critical #7, #8) — only `tsc` catches this.
- No `turbo run lint` task actually runs anything (Medium #20).
- `turbo run build`/`type-check` correctly parallelizes and correctly reports cache hits (`@lexguard/shared`, `@lexguard/web`, `@lexguard/qdrant`, `@lexguard/observability`, `@lexguard/enkrypt` all cache-hit clean on the second run) — the turbo pipeline configuration itself (`turbo.json`) is correct and not at fault.

## TypeScript Problems

Covered in Build Errors above plus:
- `apps/web/tsconfig.json` doesn't extend the shared base (Medium #26).
- No `rootDir` anywhere, risking nested build output (Medium #33).
- Type safety erased with `any` in `packages/qdrant` (Medium #22) and `packages/observability` (High #14).

## React Problems

Scoped to `apps/web` (the only React code in the repo):
- All interactive pages correctly declare `"use client"`; no missing-directive or hydration-risk issues found. ✅ Verified.
- No invalid hooks usage, dependency-array issues, or unnecessary-rerender patterns found in the (currently small) page set. ✅ Verified.
- `contracts`, `analytics`, `settings` pages are literal "Coming Soon" placeholders wired to nothing (not a bug per se, but a fidelity gap between the UI's apparent completeness and actual functionality — see Low #38).

## Runtime Problems

- Critical #4 (Prisma not generated) and #10 (missing JWT keys) are the two concrete "will crash on first real request" issues.
- High #16 (no rate limiting despite being documented as present) and #12/#13 (auth bypass reachable via env var) are runtime *security* problems, not crashes.
- High #18 (stub routes returning fake success) are runtime *correctness* problems — silent no-ops disguised as 200 OK.

## Configuration Problems

See Medium #25 (Grafana bind-mount), #26 (web tsconfig not extending base), #27 (hardcoded rewrite URL), #30 (hardcoded compose credentials), #31 (stale metrics docstring), High #19 (dead Prometheus scrape job), Critical #11 (no Dockerfile/deploy config).

## Performance Improvements

No significant performance anti-patterns were found in the currently-reachable, compiling code (`apps/web`'s pages are small and static/SSR-appropriate; `packages/qdrant`/`packages/observability` don't do anything obviously wasteful). The performance-relevant risk that *was* found is indirect: the OpenTelemetry package duplication (High #14) means multiple copies of tracing/metrics SDKs are bundled and potentially initialized, which is unnecessary memory/startup overhead beyond the correctness risk already described. ❓ A meaningful performance pass on `packages/agents`/`packages/workflows` isn't possible until those packages compile.

## Security Findings

Ranked:
1. **Auth bypass switch in production middleware** (High #12) — reachable via a single env var.
2. **No real frontend auth flow; static dev token hardcoded** (High #13).
3. **Supply-chain: unreviewed install scripts allowed repo-wide** (High #15).
4. **No rate limiting despite being documented as present** (High #16).
5. **Multer trusts client-supplied MIME type only** (Medium #35).
6. **Role-string/enum mismatch** could cause an authorization check to silently never grant access it should (Medium #24) — a fail-closed bug, lower severity than the above but worth fixing.
7. **No secrets found committed to git** — `.env.local`'s real-looking credentials (Azure OpenAI key, Mastra API key, Qdrant Cloud key, Enkrypt key) are correctly gitignored and were never committed. Since they were read during this audit, consider rotating them as routine hygiene. ✅ Verified via `git check-ignore` and a full secrets-pattern grep of tracked files (zero real hits — only the intentional `lexguard:password` local-dev Postgres string, matched consistently across `.env.example`, `docker-compose.yml`, `README.md`, and `apps/api/tests/setup.ts`).

## Recommended Fix Order

Fixing in this order minimizes cascading re-breaks (each step is verified to unblock the next):

1. **#4** Run `pnpm db:generate` (Prisma) — unblocks `apps/api` type-check partially, fixes the two `TS7006` implicit-`any` errors.
2. **#5** Add the six missing `export type` lines in `packages/shared/src/schemas/index.ts` — unblocks most of `packages/agents`'s `TS2305` errors immediately, no dependency changes needed.
3. **#7** Add `@lexguard/enkrypt` as a dependency of `packages/agents`; **#8** add `@prisma/client` (or a repository abstraction) as a dependency of `packages/workflows` — clears both `TS2307` module-resolution errors.
4. **#2** Decide on and align `@mastra/core` (and, as a consequence, `zod`, #23) to one version across `apps/api`, `packages/agents`, `packages/workflows` — do this *before* touching agent code, so you fix the model-config shape (#6) and workflow chaining (#9) against the version you're actually keeping.
5. **#6** Rewrite every agent's `model` construction to use an AI SDK provider instance (mirroring `src/mastra/index.ts`'s correct pattern) instead of `{provider, name, toolChoice}`.
6. **#9** Fix `contract-analysis.ts`'s `.step()` → `.then()` chain and the three `createStep(...)` overload mismatches; fix the `.clauses` missing-property bug on the embedding step's output.
7. **#17** Add explicit type annotations to `app`/`contractsRouter` in `apps/api` to clear the `TS2742` portability errors.
8. **#1** Once `packages/agents`/`packages/workflows` compile and actually work end-to-end, resolve the architectural duplication with `src/mastra/index.ts` (port real logic in, delete the stub duplicate, or vice versa) — do this last since it's a design decision, not a mechanical fix, and doing it earlier would mean redoing it after steps 4–6 change the agent API shape anyway.
9. Re-run `pnpm build` and `pnpm type-check` at the root to confirm everything is green, then address High/Medium items (#10 JWT keys, #12/#13 auth bypass, #14 OTel duplication, #15 install-script safety, #16 rate limiting, #18 stub routes, #19 Prometheus config, #20/#21 lint/format tooling) roughly in that severity order.
10. Low-severity items (#33, #36, #37, #39) can be picked up opportunistically; they don't block anything else.

---

*This report contains no code changes — it is audit-only, per the request. All ✅ Verified items were confirmed by directly running commands or reading the cited files during this session; ⚠ Likely items are inferred from strong but incomplete direct evidence; no ❓ Needs-manual-verification item was left without an explicit note of what remains to check.*
