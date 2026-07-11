# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**LexGuard AI** is an enterprise legal intelligence platform built on a 13-agent **Mastra swarm** architecture. It analyzes contracts through a sophisticated AI pipeline, performs risk assessment, generates alternatives, and manages human-in-the-loop (HITL) review workflows. The platform uses a monorepo (pnpm workspaces) with Turborepo orchestration.

**Stack:** Node.js ≥20 | TypeScript | Express | Mastra | PostgreSQL + Prisma | Qdrant (vector DB) | Redis | Docker | Enkrypt (safety pipeline)

---

## Quick Start

```bash
cd lexguard-ai
pnpm install                    # Install all workspaces
pnpm infra:up                   # Start Docker services (Qdrant, Postgres, Redis, OTel, Jaeger)
pnpm db:generate                # Generate Prisma types
pnpm db:migrate                 # Run migrations
pnpm qdrant:init                # Create 8 Qdrant collections
pnpm dev:api                    # Start API on http://localhost:4000
```

Generate a dev JWT to test:
```bash
node -e "
const { SignJWT } = require('jose');
const fs = require('fs');
const key = fs.readFileSync('apps/api/keys/private.pem');
const orgId = '00000000-0000-0000-0000-000000000001';
new SignJWT({ sub: '00000000-0000-0000-0000-000000000002', org_id: orgId, email: 'dev@lexguard.ai', roles: ['ADMIN'] })
  .setProtectedHeader({ alg: 'RS256' })
  .setIssuer('http://localhost:4000')
  .setAudience('lexguard-api')
  .setExpirationTime('24h')
  .sign(require('crypto').createPrivateKey(key))
  .then(t => console.log(t));
"
```

---

## Common Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev:api` | Start Express API with hot-reload |
| `pnpm dev:web` | Start Next.js web frontend |
| `pnpm dev:ui` | Launch Mastra Studio (agent/workflow visual debugger) |
| `pnpm type-check` | TypeScript check across all packages |
| `pnpm lint` | ESLint across all packages |
| `pnpm test` | Run all tests (via Turborepo) |
| `pnpm build` | Production build |
| `pnpm db:studio` | Open Prisma Studio GUI (http://localhost:5555) |
| `pnpm db:migrate` | Run Prisma migrations |
| `pnpm qdrant:init` | (Re)create all 8 Qdrant collections |
| `pnpm infra:up` | Start Docker services |
| `pnpm infra:down` | Stop Docker services |
| `pnpm infra:reset` | Wipe all Docker volumes (data loss) |
| `pnpm clean` | Remove all node_modules |

---

## Architecture

### Monorepo Structure (Turborepo + pnpm workspaces)

```
lexguard-ai/
├── apps/
│   ├── api/                 # Express gateway :4000 — 8 REST endpoints
│   │   ├── src/
│   │   │   ├── index.ts     # Entry, OTel init, middleware registration
│   │   │   ├── middleware/  # JWT RS256 validation, tenant isolation
│   │   │   └── routes/      # All REST endpoints (contracts, QA, HITL, GDPR)
│   │   ├── prisma/          # Prisma schema + migrations
│   │   ├── tests/           # Integration tests
│   │   └── keys/            # RSA keypair (gitignored)
│   │
│   └── web/                 # Next.js frontend (TBD: Phase 5)
│
├── packages/
│   ├── agents/              # 13 Mastra agents (contract analysis pipeline)
│   │   └── src/
│   │       ├── document-agent.ts      # #1  Validate, extract metadata, S3 store
│   │       ├── parsing-agent.ts       # #2  OCR (Tesseract) + clause extraction
│   │       ├── embedding-agent.ts     # #3  text-embedding-3-large → Qdrant
│   │       ├── classification-agent.ts # #4  12 clause types (keyword + GPT-4o-mini)
│   │       ├── retrieval-agent.ts     # #5  Hybrid search (keyword+dense) across 4 collections
│   │       ├── risk-agent.ts          # #6  GPT-4o + CRISPE prompt + 4-step CoT + citations
│   │       ├── benchmark-agent.ts     # #7  Percentile rank vs legal_templates collection
│   │       ├── rewrite-agent.ts       # #8  3 safer alternatives (GPT-4o-mini)
│   │       ├── compliance-agent.ts    # #9  GDPR/CCPA/jurisdiction rules (conservative)
│   │       ├── evaluation-agent.ts    # #10 Enkrypt pipeline gateway (>= 0.70 confidence)
│   │       ├── memory-agent.ts        # #11 HITL decisions → risk_patterns + org_preferences
│   │       ├── qa-agent.ts            # #12 Multi-turn Q&A + conversation_memory context
│   │       └── reporting-agent.ts     # #13 Board-ready summary (Flesch-Kincaid ≥60)
│   │
│   ├── workflows/           # Mastra 10-step DAG orchestration
│   │   └── contract-analysis.ts
│   │
│   ├── shared/              # Zod validation schemas, constants, env validation
│   ├── qdrant/              # Vector DB client + 8-collection init + schema
│   ├── enkrypt/             # Safety evaluation pipeline (10 stages, ≤1200ms)
│   └── observability/       # OTel tracer + Prometheus metrics
│
├── infra/
│   ├── otel/collector-config.yml      # OTel → Jaeger + Prometheus
│   └── prometheus/prometheus.yml
│
├── docker-compose.yml       # 7 services: Qdrant, Postgres, Redis, OTel, Jaeger, Prometheus, Grafana
├── .env.example             # Template; copy to .env.local
├── turbo.json               # Turborepo pipeline config
└── tsconfig.base.json       # Shared TypeScript config (strict mode)
```

### Agent Pipeline (10-step DAG)

```
Contract Upload (PDF/DOCX)
         │
         ├─→ Step 1:  Document Agent ──→ Validate, extract metadata, S3 store
         │
         ├─→ Step 2:  Parsing Agent ────→ OCR + clause extraction + boundaries
         │
         ├─→ Step 3:  Embedding Agent ──→ text-embedding-3-large → Qdrant
         │
         ├─→ Step 4:  Classification + Retrieval (parallel)
         │            ├─ Classification → 12 clause types
         │            └─ Retrieval → Hybrid search (org prefs first)
         │
         ├─→ Step 5:  Risk + Benchmark (parallel)
         │            ├─ Risk Agent (GPT-4o, CRISPE, CoT)
         │            └─ Benchmark Agent (percentile vs templates)
         │
         ├─→ Step 6:  Rewrite Agent ────→ 3 safer alternatives
         │
         ├─→ Step 7:  Compliance Agent ──→ GDPR/CCPA/jurisdiction validation
         │
         ├─→ Step 8:  Evaluation Agent ──→ Enkrypt 10-stage pipeline
         │            │
         │            ├─ PASS (confidence ≥ 0.70)
         │            │  └─→ Reporting Agent → Executive report + JSON
         │            │
         │            └─ FAIL / Low confidence
         │               └─→ Step 9: HITL Queue (Mastra suspend)
         │                  └─→ Step 10: Memory Agent (update org preferences)
         │                     └─→ Workflow resumes → Reporting Agent
```

### Qdrant Collections (Hybrid Search)

| Collection | Type | Purpose | Scope | TTL |
|---|---|---|---|---|
| `contracts` | Dense + BM25 | Uploaded document vectors | org_id | — |
| `legal_templates` | Dense | Industry standard clauses | Global | — |
| `legal_precedents` | Dense | LexisNexis case citations | Global | 30d |
| `risk_patterns` | Dense + BM25 | HITL-learned toxic patterns | org_id | — |
| `org_preferences` | Dense | Org negotiation playbooks | org_id | — |
| `conversation_memory` | Dense | Q&A session history | session_id | 30d |
| `jurisdiction_rules` | Dense | Compliance rules (GDPR/CCPA/etc.) | jurisdiction | — |
| `regulatory_documents` | Dense | Full regulatory text | jurisdiction | — |

Retrieval agents use org_preferences as the first collection (org-specific playbooks), then hybrid (BM25 + dense) across contracts and risk_patterns, then legal_templates.

### Enkrypt Safety Pipeline (≤1,200ms)

**Gate → [Group A ‖ Group B] → Group C**

- **Gate (E-01):** Schema validation <10ms
- **Group A (E-02 ‖ E-03 ‖ E-04):** Prompt injection, toxicity, PII redaction ≤380ms
- **Group B (E-05 ‖ E-06 ‖ E-07 ‖ E-08):** Hallucination, citation verify, bias, policy ≤470ms
- **Group C (E-09 ‖ E-10):** Bayesian confidence estimation, safe output generation ≤280ms

**Routing:** confidence < 0.70 → HITL queue | 0.70–0.85 → append disclaimer | Hard fail → blocked

---

## Key Design Decisions

1. **13-Agent Swarm:** Each agent is stateless and single-purpose; orchestrated by Mastra DAG. Enables parallel execution (steps 4–5) and clear responsibility boundaries.

2. **Qdrant for RAG:** 8 separate collections (not one catch-all) allow org isolation, jurisdiction scoping, and TTL-based auto-expiry for LexisNexis data.

3. **Mastra Suspend/Resume:** HITL queue leverages Mastra's built-in suspension mechanism — workflow pauses at step 9, resumes when a lawyer submits a decision.

4. **Enkrypt Integration:** 10-stage safety pipeline runs between Risk analysis and Reporting; gates content on confidence scores. Can be disabled locally via `ENKRYPT_ENABLED=false`.

5. **Prisma + PostgreSQL:** ACID transactions, audit logs, org-level tenant isolation via `X-Tenant-ID` header. Field-level PII encryption (AES-256 + KMS) on Organization.email, User fields.

6. **JWT RS256 Auth:** Asymmetric signing (keys in `apps/api/keys/`) ensures API can validate tokens without access to private key material.

---

## Environment & Configuration

Create `.env.local` from `.env.example`. **Minimum for local dev:**

```env
NODE_ENV=development
OPENAI_API_KEY=sk-...                                    # Required
DATABASE_URL=postgresql://lexguard:password@localhost:5432/lexguard_db?schema=public
QDRANT_URL=http://localhost:6333
REDIS_URL=redis://localhost:6379
ENKRYPT_ENABLED=false                                   # Disable Enkrypt locally
LEXISNEXIS_ENABLED=false                                # Disable LexisNexis
HITL_ENABLED=true
JWT_RS256_PRIVATE_KEY_PATH=./keys/private.pem
JWT_RS256_PUBLIC_KEY_PATH=./keys/public.pem
JWT_ISSUER=http://localhost:4000
JWT_AUDIENCE=lexguard-api
```

Generate RSA keys before first run:
```bash
mkdir -p apps/api/keys
openssl genrsa -out apps/api/keys/private.pem 2048
openssl rsa -in apps/api/keys/private.pem -pubout -out apps/api/keys/public.pem
```

---

## Database

**Prisma ORM** manages PostgreSQL schema. Key tables:

- `organizations` — Tenants (plan, rate limits, consent timestamp, PII-encrypted)
- `users` — Org members (roles: ADMIN, LAWYER, ANALYST; PII-encrypted)
- `contracts` — Uploaded documents (original S3 path, analysis status, FK to org)
- `audit_logs` — All changes (user, org, action, timestamp, IP)
- `hitl_queue_items` — Suspended workflows awaiting lawyer review
- `deletion_requests` — GDPR erasure requests (24h SLA)

**Migrations:** `pnpm db:migrate` (creates tables from schema.prisma). Schema changes:

1. Edit `apps/api/prisma/schema.prisma`
2. Run `pnpm db:migrate` and name the migration (e.g., "add_user_phone")
3. New migration file appears in `apps/api/prisma/migrations/`

**Prisma Studio:** `pnpm db:studio` opens GUI at http://localhost:5555 for data inspection/editing.

---

## Testing & Linting

```bash
pnpm test               # Run all tests (Jest) across all packages via Turborepo
pnpm type-check         # TypeScript check (no emit)
pnpm lint               # ESLint + Prettier check
```

Tests are under `apps/api/tests/` and `packages/*/tests/`. Integration tests require Docker services running.

---

## API Endpoints

All routes require `Authorization: Bearer <JWT>` and `X-Tenant-ID: <org_uuid>` headers.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/contracts/upload` | Upload PDF/DOCX → start analysis DAG |
| `GET` | `/api/v1/contracts/:id/status` | Workflow status + progress % |
| `GET` | `/api/v1/contracts/:id/analysis` | Full analysis report (risks, alternatives, benchmark) |
| `POST` | `/api/v1/qa` | Legal Q&A against contract(s) |
| `GET` | `/api/v1/hitl/queue` | Pending lawyer review queue |
| `POST` | `/api/v1/hitl/:id/decision` | Submit approve/reject/edit decision |
| `DELETE` | `/api/v1/gdpr/erase/:orgId` | GDPR data erasure (24h SLA) |
| `GET` | `/api/v1/audit/trace/:traceId` | OTel audit trail |

---

## Observability

**Jaeger** (http://localhost:16686): Distributed tracing. Every API call generates an OTel trace with spans for each agent step.

**Prometheus** (http://localhost:9090): Metrics. Scraped from `/metrics` endpoint.

**Grafana** (http://localhost:3001): Dashboards (login: admin/admin).

All instrumentation configured via `packages/observability/`.

---

## Deployment Notes

- **Phase 5 (TBD):** HITL Next.js portal, PDF export, load testing, security pen test
- **S3 Storage:** Contracts uploaded to S3 (local dev uses temp fs). Requires `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `AWS_S3_BUCKET`
- **KMS Encryption:** Org PII encrypted at rest. Requires `KMS_KEY_ARN` in prod
- **Rate Limiting:** Per-org rate limit (default 100 rpm) enforced at API gateway
- **HITL SLA:** Lawyer decisions must be submitted within 24h (configurable)

---

## Common Pitfalls

| Issue | Fix |
|---|---|
| Qdrant connection fails | `docker-compose ps qdrant` — wait ~10s after infra:up |
| JWT public key not found | Generate keys in `apps/api/keys/` (see Environment section) |
| OPENAI_API_KEY missing | Add to `.env.local` — all agents require it |
| Prisma schema out of sync | Run `pnpm db:generate` after schema.prisma edits |
| Port 4000 in use | Change `API_PORT` in `.env.local` |
| pnpm workspace resolution fails | Run `pnpm install` at repo root |
| Turbo cache stale | Run `pnpm clean && pnpm install` |

---

## File Naming & Conventions

- **Agents:** Snake case: `document-agent.ts`, `risk-agent.ts`
- **Workflows:** Snake case: `contract-analysis.ts`
- **Prisma migrations:** Auto-generated with timestamps in `prisma/migrations/`
- **Routes:** Plural nouns: `routes/contracts.ts`, `routes/qa.ts`
- **Types:** Zod schemas in `packages/shared/` for runtime validation; TypeScript interfaces generated from Prisma

---

## When Adding Features

1. **New agent?** Add to `packages/agents/src/`, integrate into DAG in `packages/workflows/contract-analysis.ts`
2. **New API route?** Add to `apps/api/src/routes/`, register in middleware chain at `apps/api/src/index.ts`
3. **Schema change?** Edit `apps/api/prisma/schema.prisma`, run `pnpm db:migrate`
4. **New Qdrant collection?** Update `packages/qdrant/src/schema.ts`, re-run `pnpm qdrant:init`
5. **New env var?** Add to `.env.example` with description, reference in `packages/shared/` env validation

---

**Last updated:** July 2026 | **Version:** 1.0 | LexGuard AI · HiDevs × Mastra Hackathon
