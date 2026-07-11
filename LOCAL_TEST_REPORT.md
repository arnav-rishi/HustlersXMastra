# LexGuard AI — Local Test Report

Date: 2026-07-11
Scope: Get the app running locally end-to-end, migrate LLM calls to Azure OpenAI (Azure AI Foundry), verify core functionality.

---

## 1. Project Stack

| Layer | Technology |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| API | Express (Node 20+, TypeScript, `tsx watch`) |
| Agents | Mastra (`@mastra/core`) — 13 agents, mixed `Agent.generateLegacy()` + raw `AzureOpenAI` SDK calls |
| LLM | **Azure OpenAI (Azure AI Foundry)** — migrated off raw OpenAI in this session |
| Database | PostgreSQL 16 (Docker) via Prisma ORM |
| Vector DB | Qdrant — **Qdrant Cloud** (per your choice), 8 collections |
| Cache/Queue | Redis (Docker) |
| Observability | OpenTelemetry Collector → Jaeger + Prometheus (Docker) |
| Auth | JWT RS256 (local keypair) or `LEXGUARD_DEV_BYPASS_AUTH=true` for local dev |

---

## 2. Required Environment Variables (final `.env.local`)

| Variable | Source | Notes |
|---|---|---|
| `AZURE_OPENAI_API_KEY` | Your Azure resource | Already present |
| `AZURE_OPENAI_ENDPOINT` | Your Azure resource | Already present |
| `AZURE_OPENAI_DEPLOYMENT` | Your Azure resource | `gpt-5-nano` — used for both chat tiers |
| `AZURE_OPENAI_DEPLOYMENT_MINI` | Added | Set to `gpt-5-nano` (same deployment; add a second cheaper deployment later if desired) |
| `AZURE_OPENAI_API_VERSION` | Already present | `2025-04-01-preview` |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | Added by you | `text-embedding-3-large` — same Azure resource, new deployment (see §6) |
| `DATABASE_URL` | Added | Points at local Docker Postgres |
| `REDIS_URL` | Added | Points at local Docker Redis |
| `QDRANT_URL` / `QDRANT_API_KEY` | Already present | Your live Qdrant Cloud cluster (used per your choice) |
| `JWT_RS256_PRIVATE_KEY_PATH` / `..._PUBLIC_KEY_PATH` | Added | Generated locally into `apps/api/keys/` |
| `LEXGUARD_DEV_BYPASS_AUTH` | Added | `true` — skips real JWT validation for local testing |
| `ENKRYPT_ENABLED` | Added | `false` — no Enkrypt API key configured |
| `LEXISNEXIS_ENABLED` | Added | `false` — not configured |

---

## 3. Dependencies

- `pnpm install` — clean install, no errors, Prisma client auto-generated via `postinstall`.
- No missing/incompatible packages found.

---

## 4. Commands To Run Locally

```powershell
cd lexguard-ai
pnpm install

# Generate JWT keys (one-time)
mkdir apps\api\keys
openssl genrsa -out apps\api\keys\private.pem 2048
openssl rsa -in apps\api\keys\private.pem -pubout -out apps\api\keys\public.pem

# Start Docker Desktop, then:
docker-compose up -d postgres redis otel-collector jaeger prometheus
# (Qdrant container skipped — using your Qdrant Cloud instance per .env.local)

pnpm db:migrate     # creates schema
pnpm db:seed        # creates the dev org/user used by LEXGUARD_DEV_BYPASS_AUTH
pnpm qdrant:init    # creates the 8 collections on Qdrant Cloud

pnpm dev:api        # starts API on http://localhost:4000
```

Verify:
```bash
curl http://localhost:4000/health
curl http://localhost:4000/ready
```

---

## 5. Issues Found & Fixes Applied

| # | Issue | Root Cause | Fix |
|---|---|---|---|
| 1 | Server wouldn't boot: `AZURE_OPENAI_API_KEY: Required`, `DATABASE_URL: Required` | `.env.local` was missing several required vars; `OPENAI_API_KEY` was required by schema but unused by the Azure setup | Added missing vars; made `OPENAI_API_KEY` optional in `packages/shared/src/env.ts` |
| 2 | All 13 agents called the **raw OpenAI SDK** (`new OpenAI({apiKey: env.OPENAI_API_KEY})`) directly, bypassing the Azure client entirely — Azure credentials in `.env.local` had no effect | Codebase's actual LLM call path (`openai.chat.completions.create()` / `.embeddings.create()`) never used the Mastra `Agent`/`@ai-sdk/azure` objects in `models.ts` | Rewired `packages/agents/src/models.ts` with a shared `getAzureOpenAIClient()` (native `AzureOpenAI` client from the `openai` SDK) + `getChatDeployment()` / `getChatDeploymentMini()` / `getEmbeddingDeployment()` getters. Updated all 10 files that instantiated `new OpenAI(...)` (risk, classification, compliance, reporting, benchmark, rewrite, qa, memory, retrieval, embedding agents) to use the Azure client and deployment-name env vars instead of raw model-name strings |
| 3 | `pnpm db:migrate` / `pnpm dev:api` failed with "DATABASE_URL: Required" even after adding it to `.env.local` | Root `package.json` scripts ran `prisma migrate` / `tsx watch` directly without loading `.env.local` (Prisma/`dotenv/config` only auto-load a plain `.env` in the process's cwd) — inconsistent with the `qdrant:init` script, which already used `dotenv-cli` | Wrapped `db:migrate`, `db:studio`, `db:seed`, and `dev:api` in root `package.json` with `dotenv -e .env.local --`, matching the existing `qdrant:init` pattern |
| 4 | `otel-collector` container crash-looped: `unknown type: "jaeger" for id: "jaeger"` | The pinned `otel/opentelemetry-collector-contrib:0.101.0` image removed the legacy `jaeger` exporter type; Jaeger 1.57 accepts OTLP natively (already enabled via `COLLECTOR_OTLP_ENABLED=true`) | Changed `infra/otel/collector-config.yml` exporter from `jaeger:` (gRPC 14250) to `otlp/jaeger:` pointed at `jaeger:4317` |
| 5 | `otel-collector` then crashed with `listen tcp 0.0.0.0:8888: address already in use` | The collector's own self-telemetry metrics server and the `prometheus` exporter were both configured to bind port 8888 in the same process | Added `service.telemetry.metrics.address: 0.0.0.0:8889` in the collector config so the two no longer collide |
| 6 | Any request with a malformed `:id` (e.g. `/api/v1/contracts/does-not-exist/status`) **crashed the entire API process** | Async Express route handlers had no `try/catch`; a rejected Prisma promise became an unhandled rejection, which Node treats as fatal | Added an `asyncHandler` wrapper in `apps/api/src/routes/contracts.ts` and applied it to every handler lacking error handling, forwarding errors to Express's existing JSON error middleware instead of crashing |
| 7 | The documented API paths (`/api/v1/qa`, `/api/v1/hitl/queue`, `/api/v1/gdpr/erase/:id`, `/api/v1/audit/trace/:id`) all returned `404 NOT_FOUND`; only paths like `/api/v1/contracts/hitl/queue` worked | `index.ts` mounted the **same** `contractsRouter` at 5 different prefixes (`/contracts`, `/qa`, `/hitl`, `/gdpr`, `/audit`), but internal route paths only prefixed contract-specific routes with nothing extra — every route became reachable (confusingly) under all 5 prefixes, and the documented canonical paths didn't match any of them | Prefixed the 7 contract-specific routes with `/contracts` (`/contracts/upload`, `/contracts/analyze`, `/contracts/:id/analysis`, etc.) and mounted the router **once** at `/api/v1` in `index.ts`. All documented paths now resolve exactly as specified in the README |
| 8 | `pnpm db:seed` failed — `prisma/seed.ts` referenced in `package.json` didn't exist | Never committed | Created `apps/api/prisma/seed.ts`, seeding the `Organization`/`User` rows matching the exact UUIDs hardcoded by `LEXGUARD_DEV_BYPASS_AUTH` in `middleware/auth.ts`, so uploads/analysis can be tested without real JWTs |
| 9 | Contract analysis workflow failed at the `document-validation` step: `Agent "document-agent" is using AI SDK v4 model ... not compatible with generate()` | `@mastra/core@1.50.0`'s `.generate()` expects AI SDK v5-shaped models; `@ai-sdk/azure@1.3.25` produces v4-shaped models | Changed the two call sites (`document-agent.ts`, `parsing-agent.ts`) from `.generate()` to `.generateLegacy()`, which `@mastra/core` still supports for v4 models |
| 10 | Workflow then failed at the `parsing` step: `pageCount: Number must be greater than 0` | `document-agent.ts` always output `pageCount: 0`, but its own declared output schema (`DocumentAgentOutputSchema`) requires `z.number().positive()` — a 100%-reproducible bug affecting every contract | Changed the placeholder to `pageCount: 1` |

After fixes 9 and 10, the pipeline was confirmed to make two **real** Azure OpenAI chat-completion calls (Document Agent, Parsing Agent) successfully end-to-end. You then deployed a `text-embedding-3-large` model under the same Azure resource and added `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` — the following additional bugs surfaced (and were fixed) while getting the rest of the 13-agent pipeline to complete:

| # | Issue | Root Cause | Fix |
|---|---|---|---|
| 11 | Embedding step failed: Qdrant `upsertPoints` returned `400 Bad Request` | All 8 Qdrant collections were created with a **named** vector (`dense`), but `LexGuardQdrantClient.upsertPoints`/`hybridSearch`/`denseSearch` sent plain unnamed vector arrays — Qdrant rejects those for named-vector collections | Fixed at the single client chokepoint (`packages/qdrant/src/client.ts`): upserts now wrap `vector: [...]` as `vector: { dense: [...] }`; searches now send `vector: { name: "dense", vector: [...] }` |
| 12 | Retrieval step failed: `Index required but not found for "org_id"` (then `"jurisdiction"`, then `"clause_type"`) | `packages/qdrant/src/init.ts` **logged** "Indexing payload field..." for every collection but never actually called Qdrant's index-creation API (a stub — the code comment literally says "Note: payload index creation via REST API... In production, use..."). Separately, `org_preferences`/`risk_patterns` were missing `jurisdiction`/`clause_type` from their index lists even though the Retrieval Agent filters on those fields | Implemented `createPayloadIndex()` on the Qdrant client and wired it into `init.ts` (now idempotent — runs even for already-existing collections); added the missing `jurisdiction` and `clause_type` entries to `PAYLOAD_INDEXES` for `risk_patterns`/`org_preferences` in `packages/qdrant/src/collections.ts`; re-ran `pnpm qdrant:init` to backfill indexes on your existing cloud collections |
| 13 | Classification/Risk/Compliance/QA/Benchmark/Reporting/Rewrite steps failed: `400 Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported` | Your `gpt-5-nano` deployment is a reasoning-tier model that rejects any non-default `temperature`; every one of the 7 agents making chat-completion calls hardcoded a custom value (0, 0.1, 0.2, 0.3, 0.4) | Removed the `temperature` parameter from all 7 call sites (model now uses its required default) |
| 14 | Qdrant retry failures were only logged as generic `"Bad Request"` with no detail, making root-causing #11/#12 much harder | `withRetry()` in the Qdrant client only logged `err.message`, dropping the structured error body Qdrant returns | Extended the retry log line to include `err.data`/`err.response.data`, surfacing the real Qdrant rejection reason going forward |

**Result: a full end-to-end contract analysis run completed successfully** — Document → Parsing → Embedding → Classification+Retrieval → Risk+Benchmark → Rewrite → Compliance → Evaluation → Reporting, using real Azure OpenAI calls (`gpt-5-nano` chat + `text-embedding-3-large` embeddings) and your real Qdrant Cloud instance. Sample output from the test run:

```json
{
  "status": "completed",
  "overallRisk": "Critical",
  "totalClauses": 5,
  "criticalCount": 2,
  "moderateCount": 8,
  "lowCount": 0,
  "executiveSummary": "Contract (US-CA) – risk and compliance snapshot. Five clauses were analyzed. Risk counts: There are two critical risks, eight moderate risks, and no low risks. Compliance issues: five. ... Recommendations: implement targeted redlines to remediate all critical risks and compliance gaps..."
}
```

Each of the 5 clauses (indemnification, limitation_of_liability, auto_renewal, confidentiality, data_processing) got real risk findings, financial exposure estimates, and rewrite suggestions generated by the LLM.

---

## 6. Azure AI Foundry Setup (Completed)

You deployed `text-embedding-3-large` under the same Azure resource (`arnavrishi2005-1187-resource`, same API key/endpoint) and set:
```
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-large
```
No code changes were needed for this — `packages/agents/src/models.ts`'s `getEmbeddingDeployment()` already read this env var. Note: immediately after deployment, Azure returned `404 The API deployment for this resource does not exist` for ~1 minute — this is normal Azure-side propagation delay, not a bug; it resolved itself on retry.

---

## 7. Test Results Summary

| Test | Result |
|---|---|
| `pnpm install` | ✅ Clean |
| `pnpm type-check` (all 8 packages) | ✅ Clean |
| Docker infra (Postgres, Redis, OTel, Jaeger, Prometheus) | ✅ All healthy |
| `pnpm db:migrate` | ✅ Schema created |
| `pnpm qdrant:init` | ✅ 8 collections + all payload indexes created on your Qdrant Cloud instance |
| `GET /health` | ✅ `200 healthy` |
| `GET /ready` | ✅ `200` — postgres/redis/qdrant all `ok` |
| `GET /api/v1/hitl/queue` (documented path) | ✅ `200`, empty queue |
| `POST /api/v1/contracts/analyze` | ✅ `202 processing` → **`completed`** with full analysis report |
| All 13 agents (Document → Reporting) | ✅ Full pipeline completed end-to-end with real Azure LLM + embedding calls |
| Crash resilience (malformed `:id`) | ✅ Returns clean `500` JSON, server stays up |
| Server stability under repeated requests | ✅ No crashes observed after fixes |

---

## 8. Notes / Non-Blocking Observations

- **Latency**: `gpt-5-nano` (a reasoning-tier model) is slow — individual Risk Agent calls took 14–36 seconds each, ~2+ minutes total for a 5-clause contract. This is a model characteristic, not a bug. Consider a faster deployment (e.g. `gpt-4o-mini`) for the `AZURE_OPENAI_DEPLOYMENT_MINI` tier if latency matters for your workflow.
- Contract `/status` polling doesn't reflect live workflow progress beyond the initial "queued" write — the workflow doesn't write intermediate progress back to Postgres as each step completes. Not fixed (out of scope for "get it running"); worth a follow-up if you want live progress bars to work.
- Retrieval Agent returned zero results across the board (`org_preferences`, `risk_patterns`, `legal_templates`, `legal_precedents` are all empty) — expected, since this is a fresh Qdrant instance with no seeded reference data. The pipeline correctly degrades gracefully (global-average benchmarks, no retrieved precedent citations) rather than failing.
- Mastra logs `No storage configured ... falling back to an in-memory store` on every boot — expected for local dev, not an error.
- Enkrypt and LexisNexis are disabled locally (no API keys configured) — this is expected and by design for local dev.
- The API process (`pnpm dev:api`, background PID from this session) was left running on `http://localhost:4000` for your continued testing.
