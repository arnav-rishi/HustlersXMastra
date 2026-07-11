# LexGuard AI

> **Enterprise Legal Intelligence Platform** — a 13-agent Mastra swarm that reads contracts, finds the risky parts, explains them in plain English, suggests safer wording, and routes anything uncertain to a human lawyer before it ever reaches a decision-maker.

Built for the HiDevs × Mastra Hackathon. Stack: **Node.js 20+ · TypeScript · Express · Mastra · PostgreSQL (Prisma) · Qdrant · Redis · Docker · Enkrypt AI**.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Problem Statement](#problem-statement)
3. [Solution](#solution)
4. [AI Workflow](#ai-workflow)
5. [Mastra Integration](#mastra-integration)
6. [Qdrant Usage](#qdrant-usage)
7. [Enkrypt AI Integration](#enkrypt-ai-integration)
8. [Architecture & Repo Layout](#architecture--repo-layout)
9. [Setup Instructions](#setup-instructions)
10. [API Reference](#api-reference)
11. [Observability](#observability)
12. [Challenges Faced](#challenges-faced)
13. [Future Improvements](#future-improvements)

---

## Project Overview

LexGuard AI takes a contract (PDF or Word document), runs it through a pipeline of 13 specialised AI agents, and comes back with:

- A **risk score** for every clause (liability, IP ownership, auto-renewal traps, data-privacy gaps, etc.)
- **Plain-English explanations** of why a clause is risky, written for someone who isn't a lawyer
- **Three safer rewrite options** for anything flagged as risky
- A check against **GDPR/CCPA and other jurisdiction-specific rules**
- A **board-ready executive report**, written to be easy to read (Flesch-Kincaid readability score ≥ 60)
- Automatic **routing to a human lawyer** whenever the AI isn't confident enough in its own answer

Everything the AI produces is filtered through a safety layer (Enkrypt AI) before it's shown to anyone, and every decision a lawyer makes is fed back into the system so it gets smarter about *that specific organisation's* preferences over time.

---

## Problem Statement

Reviewing contracts is slow, expensive, and inconsistent:

- **Lawyers spend hours on repetitive clauses.** Most contracts reuse the same 10–15 clause types (liability caps, termination, IP assignment, indemnification...) — but every one still needs manual review because a single bad clause can cost a company millions.
- **Risk knowledge lives in people's heads.** A senior lawyer "just knows" that a 24-month auto-renewal clause is a red flag. That knowledge rarely gets written down or reused by the rest of the team.
- **Compliance requirements change by jurisdiction.** GDPR, CCPA, and dozens of other regulations apply differently depending on where a contract is signed and who it covers — easy to miss under deadline pressure.
- **Plain AI chatbots aren't good enough for legal work.** A general-purpose LLM can hallucinate a legal citation, miss a jurisdiction-specific rule, or give confidently wrong advice — none of which is acceptable when real contracts and real money are involved.
- **There's no audit trail.** When something goes wrong, teams need to know exactly what the AI saw, what it decided, and who signed off on it.

## Solution

LexGuard AI addresses this with a **pipeline of narrow, specialised AI agents** instead of one big general-purpose model doing everything:

- Each agent has **one job** (parse the document, classify clauses, assess risk, check compliance, etc.), which makes each step easier to test, debug, and trust than a single do-everything prompt.
- A **safety gateway (Enkrypt AI)** double-checks every AI output for hallucinated citations, bias, toxicity, prompt injection, and low confidence *before* it's shown to a human.
- Anything the AI isn't confident about is **automatically queued for a human lawyer** to review (Human-in-the-Loop, or "HITL") — the AI never gets the final word on a genuinely uncertain call.
- Every lawyer decision is **remembered** (via Qdrant vector storage) so the system builds an organisation-specific playbook over time instead of starting from zero on every contract.
- Every step is **traced** (via OpenTelemetry) so any output can be traced back to exactly which agent produced it, with what input, and how long it took.

---

## AI Workflow

Contract analysis runs as a **10-step pipeline** (a Mastra "workflow" — think of it as a strict, ordered assembly line where some stations run in parallel). Steps 4 and 5 run two agents at once because their outputs don't depend on each other, which cuts total processing time.

```
Contract Upload (PDF/DOCX)
        │
        ▼  Step 1 — Document Agent
   Validates the file, extracts basic metadata (title, page count, format),
   flags corrupted or unreadable documents.
        │
        ▼  Step 2 — Parsing Agent
   Reads the actual file content (PDF via pdf-parse, DOCX via mammoth),
   splits it into individual clauses using numbered-section detection,
   paragraph breaks, or fixed-size chunking as a fallback.
        │
        ▼  Step 3 — Embedding Agent
   Converts each clause into a vector (a list of numbers that captures its
   meaning) using an embedding model, and stores it in Qdrant.
        │
        ▼  Step 4 — Classification + Retrieval (run in parallel)
   ┌────────────────────────────────┬──────────────────────────────────┐
   │ Classification Agent           │ Retrieval Agent                  │
   │ Labels each clause as one of   │ Searches Qdrant for similar past │
   │ 12 clause types (liability,    │ clauses, org-specific playbooks, │
   │ IP, termination, payment...)   │ and known risk patterns          │
   └────────────────────────────────┴──────────────────────────────────┘
        │
        ▼  Step 5 — Risk + Benchmark (run in parallel)
   ┌────────────────────────────────┬──────────────────────────────────┐
   │ Risk Agent                     │ Benchmark Agent                  │
   │ Scores each clause's risk with │ Compares each clause against     │
   │ a structured reasoning process │ industry-standard templates to   │
   │ and cites its sources          │ see how favourable/unusual it is │
   └────────────────────────────────┴──────────────────────────────────┘
        │
        ▼  Step 6 — Rewrite Agent
   Drafts up to 3 safer alternative versions for every risky clause,
   preserving the original commercial intent.
        │
        ▼  Step 7 — Compliance Agent
   Checks data-processing, IP, and liability clauses against GDPR, CCPA,
   and other jurisdiction-specific rules stored in Qdrant.
        │
        ▼  Step 8 — Evaluation Agent (Enkrypt AI gateway)
   Runs all AI-generated text through a 10-stage safety pipeline
   (see "Enkrypt AI Integration" below) and produces a confidence score.
        │
        ├── confidence ≥ 0.70 ──────────────────────────────┐
        │                                                    ▼
        │                                       Step 10 — Reporting Agent
        │                                       Produces the executive report
        │
        └── confidence < 0.70 or a hard safety failure
                    │
                    ▼  Step 9 — HITL Gate (workflow pauses here)
             A lawyer reviews the flagged clause(s) in a review queue and
             approves, rejects, or edits the AI's output.
                    │
                    ▼
             Memory Agent updates the organisation's playbook in Qdrant
             with the lawyer's decision, then the workflow resumes and
             continues on to the Reporting Agent.
```

This "pause and wait for a human, then resume exactly where it left off" behaviour is handled natively by Mastra's **suspend/resume** mechanism — the workflow doesn't need any custom code to remember where it stopped.

---

## Mastra Integration

[Mastra](https://mastra.ai) is the TypeScript framework this whole platform is built on. It provides two building blocks used throughout the codebase:

- **`Agent`** — wraps an LLM (Azure OpenAI's GPT-4o / GPT-4o-mini in this project) together with instructions, a personality, and a set of callable **tools** (e.g. "extract text from a PDF", "search Qdrant"). Each of the 13 agents in `packages/agents/src/` is one of these.
- **`Workflow`** (`createWorkflow` / `createStep`) — chains agents together into the 10-step DAG described above, using `.then(...)` to run steps in sequence. This lives in `packages/workflows/src/contract-analysis.ts`.

**Where things live:**

| Layer | Location | Purpose |
|---|---|---|
| Agent definitions (production) | `packages/agents/src/*.ts` | The 13 real agents — with tools, Zod schemas, and Qdrant/Prisma access — imported by the API and the workflow |
| Model wiring | `packages/agents/src/models.ts` | Wires every agent to Azure OpenAI (`@ai-sdk/azure`) using deployment names from environment variables |
| Workflow DAG | `packages/workflows/src/contract-analysis.ts` | The 10-step pipeline described above, built with `createWorkflow(...).then(...)` |
| Mastra Studio playground | `src/mastra/index.ts` | A lighter, prompt-only registration of all 13 agents used purely for interactive testing in Mastra Studio (`pnpm dev:ui`) — it does not carry the tools/DB access that the production agents have |

**Why 13 separate agents instead of one big prompt?** Each agent is stateless and single-purpose, which means:
- Steps 4 and 5 can run **in parallel**, cutting total latency.
- A bug or bad output in one agent (say, Benchmark) doesn't corrupt the reasoning of another (say, Compliance).
- Each agent's prompt is short and focused, which measurably reduces hallucination compared to one long prompt trying to do everything at once.

---

## Qdrant Usage

[Qdrant](https://qdrant.tech) is the vector database that gives every agent long-term memory and semantic search. Instead of one catch-all collection, the platform uses **8 separate collections**, each scoped and configured for its specific job:

| Collection | Search type | What it stores | Scoped by |
|---|---|---|---|
| `contracts` | Hybrid (dense + keyword/BM25) | Every clause from every uploaded contract | Organisation |
| `legal_templates` | Dense only | Industry-standard "gold standard" clauses used for benchmarking | Global |
| `legal_precedents` | Dense only | Verified case-law citations (30-day cache) | Global |
| `risk_patterns` | Hybrid | Clause patterns a lawyer has previously rejected — the AI's learned "red flag" list | Organisation |
| `org_preferences` | Dense only | An organisation's own negotiation playbook, built from past HITL decisions | Organisation |
| `conversation_memory` | Dense only | Q&A chat history so multi-turn conversations stay context-aware (30-day expiry) | Session |
| `jurisdiction_rules` | Dense only | GDPR/CCPA/etc. compliance rules | Jurisdiction |
| `regulatory_documents` | Dense only | Full regulatory text, chunked for retrieval | Jurisdiction |

**Why this design:**
- **Isolation** — one organisation's contracts and negotiation preferences never leak into another's search results (`org_preferences`, `risk_patterns`, and `contracts` are all filtered by `org_id`).
- **Hybrid search where it matters** — `contracts` and `risk_patterns` combine dense vector similarity (meaning-based) with BM25 keyword search, so an exact legal term ("indemnification") is never missed just because its embedding wasn't the closest match.
- **Automatic expiry** — cached legal citations and chat history age out automatically after 30 days so the database doesn't grow unbounded with stale data.
- **Fast filtering** — every collection has payload indexes (see `packages/qdrant/src/collections.ts`) on fields like `org_id`, `jurisdiction`, and `clause_type`, so metadata-filtered searches stay fast even as the collections grow.

The **Retrieval Agent** (Step 4) is the main consumer: for every clause, it checks the organisation's own playbook first, then does a hybrid search across contracts and known risk patterns, and finally compares against the global template library.

Run `pnpm qdrant:init` to create all 8 collections locally — the script reads the configuration in `packages/qdrant/src/collections.ts` and applies it against your local Qdrant instance.

---

## Enkrypt AI Integration

Every piece of AI-generated text — risk explanations, rewrites, compliance findings — passes through a **10-stage safety pipeline** before a human ever sees it. This is implemented in `packages/enkrypt/src/pipeline.ts` and modeled as a small DAG of its own, designed to finish in **under 1.2 seconds**:

```
E-01 Schema Validation (Gate)                      < 10ms
        │
        ▼  Group A ‖ Group B — run in parallel
┌──────────────────────────────┬──────────────────────────────┐
│ Group A (≤ 380ms)            │ Group B (≤ 470ms)            │
│ E-02 Prompt Injection        │ E-05 Hallucination Check     │
│ E-03 Toxicity Detection      │ E-06 Citation Verification   │
│ E-04 PII Detection/Redact    │ E-07 Bias Detection          │
│                              │ E-08 Legal Policy Validation │
└──────────────────────────────┴──────────────────────────────┘
        │
        ▼  Group C — sequential (≤ 280ms)
E-09 Confidence Estimation (Bayesian-weighted pass rate)
E-10 Safe Output Generation (adds disclaimers where needed)
```

**What each stage actually checks (current implementation):**
- **E-01 Schema Validation** — rejects malformed output immediately, before spending time on the rest of the pipeline.
- **E-02 Prompt Injection** — pattern-matches for attempts to hijack the AI (e.g. "ignore previous instructions") that might be hidden inside an uploaded contract's text.
- **E-03 Toxicity Detection** — screens for hateful, harassing, or discriminatory language.
- **E-04 PII Detection & Redaction** — finds and redacts SSNs, emails, phone numbers, and credit card numbers before output leaves the pipeline.
- **E-05 Hallucination Check** — flags legal citations mentioned in the output that don't actually appear in the retrieved source material.
- **E-06 Citation Verification** — optionally cross-checks citations against LexisNexis (disabled locally by default via `LEXISNEXIS_ENABLED=false`).
- **E-07 Bias Detection** — flags language that ties protected characteristics (race, gender, religion, etc.) to exclusionary or discriminatory framing.
- **E-08 Legal Policy Validation** — blocks unsafe patterns like guaranteeing a legal outcome or discouraging someone from hiring a lawyer.
- **E-09 Confidence Estimation** — combines the pass/fail results from every stage into a single confidence score (0–1), weighting failures more heavily than passes.
- **E-10 Safe Output Generation** — appends disclaimers (e.g. "verify with a qualified attorney") when confidence is below 0.85, or when citations couldn't be verified.

**Routing logic:**
- Confidence **≥ 0.70** → passes straight through to the Reporting Agent.
- Confidence **< 0.70**, or a hard failure on prompt injection / toxicity / policy → routed to the **HITL queue** for a lawyer to review before anything is finalised.

This can be disabled entirely for local development with `ENKRYPT_ENABLED=false` in `.env.local`, in which case the Evaluation Agent step is skipped and everything flows straight to reporting — useful for fast iteration, but never recommended for anything touching real data.

---

## Architecture & Repo Layout

Monorepo managed with **pnpm workspaces** and **Turborepo**.

```
HustlersXMastra/
├── apps/
│   ├── api/                          # Express API gateway — :4000
│   │   ├── src/
│   │   │   ├── index.ts              # Entry point, OTel init, middleware
│   │   │   ├── middleware/auth.ts    # JWT (RS256) validation + tenant isolation
│   │   │   └── routes/contracts.ts   # All REST endpoints
│   │   ├── prisma/                   # Database schema + migrations
│   │   └── keys/                     # RSA keypair (gitignored — you generate this)
│   │
│   └── web/                          # Next.js dashboard frontend
│
├── packages/
│   ├── agents/src/                   # The 13 production agents (see table below)
│   ├── workflows/                    # The 10-step Mastra DAG
│   ├── shared/                       # Zod schemas, constants, environment validation
│   ├── qdrant/                       # Qdrant client + 8-collection schema + init script
│   ├── enkrypt/                      # The 10-stage safety pipeline
│   └── observability/                # OpenTelemetry tracer + Prometheus metrics
│
├── src/mastra/index.ts               # Mastra Studio playground registration
├── infra/                            # OTel Collector + Prometheus config
├── docker-compose.yml                # Qdrant, Postgres, Redis, OTel, Jaeger, Prometheus, Grafana
└── .env.example                      # All environment variables, documented
```

### The 13 Agents

| # | Agent | Model | Job |
|---|---|---|---|
| 1 | Document | GPT-4o-mini | Validate the uploaded file, extract metadata |
| 2 | Parsing | GPT-4o + `pdf-parse`/`mammoth` | Extract real text and split it into clauses |
| 3 | Embedding | Azure embedding deployment | Turn clauses into vectors, store in Qdrant |
| 4 | Classification | GPT-4o-mini | Label each clause with 1 of 12 clause types |
| 5 | Retrieval | — (Qdrant search) | Hybrid search across 4 Qdrant collections |
| 6 | Risk | GPT-4o | Score risk with structured, cited reasoning |
| 7 | Benchmark | GPT-4o | Compare clauses against industry templates |
| 8 | Rewrite | GPT-4o-mini | Draft up to 3 safer alternative clauses |
| 9 | Compliance | GPT-4o | Check against GDPR/CCPA/jurisdiction rules |
| 10 | Evaluation | — (Enkrypt pipeline) | Safety-check every AI output, score confidence |
| 11 | Memory | — (Qdrant write) | Save lawyer decisions to the org's playbook |
| 12 | Q&A | GPT-4o | Multi-turn conversational Q&A about a contract |
| 13 | Reporting | GPT-4o-mini | Compile the final executive report |

---

## Setup Instructions

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | [nodejs.org](https://nodejs.org) |
| pnpm | ≥ 10 | `npm install -g pnpm` |
| Docker Desktop | Latest | Runs Qdrant, Postgres, Redis, and the observability stack |
| OpenSSL | Any | Used once to generate a JWT signing key. Pre-installed on Mac/Linux; on Windows, install via [slproweb.com](https://slproweb.com/products/Win32OpenSSL.html) or use Git Bash's bundled OpenSSL |
| An Azure OpenAI resource | — | With `gpt-4o`, `gpt-4o-mini`, and a text-embedding deployment created |

### 1 · Install dependencies

```bash
pnpm install
```

### 2 · Configure environment variables

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in, at minimum:

```env
NODE_ENV=development

# Azure OpenAI — required for every agent
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_VERSION=2024-02-15-preview
AZURE_OPENAI_DEPLOYMENT=gpt-4o
AZURE_OPENAI_DEPLOYMENT_MINI=gpt-4o-mini
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-large

# These match the docker-compose defaults — keep as-is for local dev
DATABASE_URL=postgresql://lexguard:password@localhost:5432/lexguard_db?schema=public
QDRANT_URL=http://localhost:6333
REDIS_URL=redis://localhost:6379

# Turn off paid/external integrations for local development
ENKRYPT_ENABLED=false
LEXISNEXIS_ENABLED=false
HITL_ENABLED=true
```

> The full list of variables (Mastra Cloud, AWS S3, KMS, rate limiting, feature flags) is documented with inline comments in `.env.example`.

### 3 · Generate a JWT signing key

The API validates every request with an RSA-signed JWT (RS256). Generate a local keypair once:

```bash
mkdir -p apps/api/keys
openssl genrsa -out apps/api/keys/private.pem 2048
openssl rsa -in apps/api/keys/private.pem -pubout -out apps/api/keys/public.pem
```

Then add to `.env.local`:

```env
JWT_RS256_PRIVATE_KEY_PATH=./keys/private.pem
JWT_RS256_PUBLIC_KEY_PATH=./keys/public.pem
JWT_ISSUER=http://localhost:4000
JWT_AUDIENCE=lexguard-api
```

### 4 · Start supporting infrastructure

```bash
pnpm infra:up
```

This starts 7 Docker containers: Qdrant, PostgreSQL, Redis, an OpenTelemetry Collector, Jaeger, Prometheus, and Grafana. Confirm they're healthy:

```bash
docker-compose ps
```

### 5 · Set up the database

```bash
pnpm db:generate    # Generates the Prisma client from schema.prisma
pnpm db:migrate      # Creates all tables — you'll be prompted for a migration name (e.g. "init")
```

### 6 · Create the Qdrant collections

```bash
pnpm qdrant:init
```

You should see all 8 collections created successfully.

### 7 · Start the API

```bash
pnpm dev:api
```

The API starts on **http://localhost:4000** with hot-reload enabled.

### 8 · (Optional) Start the web dashboard

```bash
pnpm dev:web
```

### 9 · (Optional) Explore agents interactively in Mastra Studio

```bash
pnpm dev:ui
```

Opens Mastra Studio at **http://localhost:4111**, where you can chat with each of the 13 agents individually and inspect their instructions and tool calls.

### Verify everything is working

```bash
curl http://localhost:4000/health
curl http://localhost:4000/ready
```

### Generate a test JWT and upload a contract

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

```bash
curl -X POST http://localhost:4000/api/v1/contracts/upload \
  -H "Authorization: Bearer <paste-jwt-here>" \
  -H "X-Tenant-ID: 00000000-0000-0000-0000-000000000001" \
  -F "contract=@test-fixtures/sample-msa-contract.pdf" \
  -F "jurisdiction=US-CA"
```

A sample contract is already included at `test-fixtures/sample-msa-contract.pdf` for quick testing.

---

## API Reference

All routes require `Authorization: Bearer <JWT>` and `X-Tenant-ID: <org_uuid>` headers.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/contracts/upload` | Upload a PDF/DOCX contract, kicks off the 10-step analysis pipeline |
| `POST` | `/api/v1/contracts/analyze` | Re-run analysis on an already-uploaded contract |
| `GET` | `/api/v1/contracts` | List an organisation's contracts |
| `GET` | `/api/v1/contracts/:id/status` | Check workflow progress (which step it's on, % complete) |
| `GET` | `/api/v1/contracts/:id/analysis` | Retrieve the full report (risks, rewrites, benchmark, compliance) |
| `GET` | `/api/v1/contracts/:id/report` | Retrieve the board-ready executive summary |
| `GET` | `/api/v1/contracts/:id/metrics` | Retrieve per-stage workflow timing (how long each agent took) |
| `POST` | `/api/v1/contracts/qa` | Ask a natural-language question about an analysed contract |
| `GET` | `/api/v1/contracts/hitl/queue` | List contracts/clauses waiting for lawyer review |
| `GET` | `/api/v1/contracts/hitl/:id` | Retrieve the detail of a single HITL review item |
| `POST` | `/api/v1/contracts/hitl/:id/decision` | Submit a lawyer's approve / reject / edit decision |
| `GET` | `/api/v1/analytics/summary` | Live dashboard metrics (contract counts, risk breakdown, HITL/compliance rates) |
| `DELETE` | `/api/v1/gdpr/erase/:orgId` | Erase an organisation's data (GDPR "right to be forgotten") |
| `GET` | `/api/v1/audit/trace/:traceId` | Retrieve the audit log for a specific request trace |
| `GET`/`PUT` | `/api/v1/settings` | Read or update organisation settings |

> **On GDPR erasure and audit trace retrieval:** both are wired to real Postgres data — erasure genuinely deletes the organisation's contracts and HITL records from the database, and audit trace lookup genuinely queries the real audit log table. Two production-only pieces are intentionally stubbed for local development: deleting the underlying files from S3, and deleting the organisation's vectors from Qdrant's 8 collections (Qdrant only supports delete-by-filter, which needs a real cloud cluster to exercise safely) — as well as fetching raw distributed-tracing spans from Jaeger (you can view those directly at `http://localhost:16686` instead). Both endpoints say so explicitly in their response payload.

---

## Observability

Every request generates a distributed trace with one span per agent step, so you can see exactly how long each stage took and what it returned.

| Tool | URL | Purpose |
|---|---|---|
| Jaeger | http://localhost:16686 | Full distributed traces — one timeline per contract analysis run |
| Prometheus | http://localhost:9090 | Raw metrics |
| Grafana | http://localhost:3001 | Dashboards (login: `admin` / `admin`) |
| Prisma Studio | `pnpm db:studio` → http://localhost:5555 | Browse/edit database rows directly |
| Qdrant Dashboard | http://localhost:6333/dashboard | Browse vector collections |

---

## Challenges Faced

Building a 13-agent pipeline with a hard safety gate surfaced some real engineering challenges along the way:

- **Keeping the Mastra Studio playground in sync with the production agents.** The production agents (with tools and database access) and the lighter Studio playground agents evolved separately during development and drifted against different framework API shapes at points. Consolidating them into a single definition is an ongoing cleanup — see [Future Improvements](#future-improvements).
- **Framework version drift.** Different packages in the monorepo ended up pinned to different major versions of the underlying Mastra library at different points in development, which caused build failures until every package was aligned to the same version (`@mastra/core@^1.50.0`).
- **Turning mock data into real data.** Early milestones used hardcoded/simulated clause data to prove the pipeline shape worked end-to-end before wiring up real document parsing. The Parsing Agent's clause extraction (real PDF/DOCX text extraction via `pdf-parse` and `mammoth`) and the GDPR/audit endpoints (real Postgres reads/writes) were later swapped in — a deliberate "prove the shape, then make it real" sequencing, but one that requires discipline to make sure every mock actually does get replaced.
- **Balancing safety-pipeline speed against thoroughness.** The Enkrypt pipeline has a strict sub-1.2-second budget across 10 checks. Getting prompt-injection, toxicity, hallucination, and bias detection to run in parallel (rather than one after another) was necessary to hit that budget without cutting corners on what gets checked.
- **Local dev vs. cloud-only features.** Several production capabilities (S3 file storage, Qdrant Cloud delete-by-filter, LexisNexis citation verification, Jaeger span retrieval by trace ID) genuinely require paid cloud services to exercise for real. The platform is designed to run fully locally with these disabled/stubbed, which meant carefully drawing the line between "stub this for local dev" and "never silently pretend this worked" — every stub responds honestly about what it did and didn't do, rather than returning a fake success.
- **Multi-tenant isolation everywhere.** Because every organisation's contracts, risk patterns, and negotiation playbooks live in the same Qdrant collections and the same Postgres tables, every single query needed an `org_id` filter — a single missed filter would leak one client's contract data into another's search results.

---

## Future Improvements

- **Unify the two agent implementations** into a single source of truth (port the production tools/logic into the same agent-construction pattern used by Mastra Studio, and have Studio import the real agents directly) so there's exactly one version of "what the 13 agents do."
- **Real S3 and Qdrant Cloud wiring** for GDPR erasure, so a right-to-be-forgotten request removes uploaded files and vector data, not just database rows.
- **A proper login flow for the web dashboard**, replacing the current static development token with real user authentication and session management.
- **API rate limiting**, using the Redis connection that's already provisioned, to protect the platform from abuse or runaway clients.
- **A production deployment path** — containerising the API and web app and documenting a real cloud deployment (the current Docker Compose file only provisions supporting infrastructure, not the applications themselves).
- **Citation verification against LexisNexis** enabled by default, rather than the local-dev "assume verified" fallback.
- **Expanded automated test coverage** for the 10-stage Enkrypt pipeline and the 10-step workflow, so future refactors of either can be made with confidence.
- **A PDF/branded export** for the executive report, so results can be shared outside the platform in a boardroom-ready format.

---

*LexGuard AI · HiDevs × Mastra Hackathon · v1.0*
