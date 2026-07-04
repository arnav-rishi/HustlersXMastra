# LexGuard AI

> **Enterprise Legal Intelligence Platform** — 13-Agent Mastra Swarm × Qdrant × Enkrypt AI

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 20 | [nodejs.org](https://nodejs.org) |
| pnpm | ≥ 9 | `npm i -g pnpm` |
| Docker Desktop | Latest | [docker.com](https://docker.com) |
| OpenSSL | Any | Pre-installed on Mac/Linux; [slproweb.com](https://slproweb.com/products/Win32OpenSSL.html) on Windows |

---

## Step-by-Step: Run on Localhost

### 1 · Clone & install

```powershell
cd C:\Users\arnav\Downloads\Mastra\lexguard-ai
pnpm install
```

### 2 · Configure environment

```powershell
Copy-Item .env.example .env.local
notepad .env.local
```

Minimum values for local dev (no paid 3rd-party APIs needed except OpenAI):

```env
NODE_ENV=development
OPENAI_API_KEY=sk-...

# These match the docker-compose defaults — keep as-is
DATABASE_URL=postgresql://lexguard:password@localhost:5432/lexguard_db?schema=public
QDRANT_URL=http://localhost:6333
REDIS_URL=redis://localhost:6379

# Disable paid external APIs for local dev
ENKRYPT_ENABLED=false
LEXISNEXIS_ENABLED=false
HITL_ENABLED=true
```

### 3 · Generate JWT keys

```powershell
New-Item -ItemType Directory -Force -Path apps\api\keys

# Generate RSA-2048 key pair
openssl genrsa -out apps\api\keys\private.pem 2048
openssl rsa -in apps\api\keys\private.pem -pubout -out apps\api\keys\public.pem
```

Add to `.env.local`:

```env
JWT_RS256_PRIVATE_KEY_PATH=./keys/private.pem
JWT_RS256_PUBLIC_KEY_PATH=./keys/public.pem
JWT_ISSUER=http://localhost:4000
JWT_AUDIENCE=lexguard-api
```

### 4 · Start infrastructure

```powershell
pnpm infra:up
# Starts: Qdrant, PostgreSQL, Redis, OTel Collector, Jaeger, Prometheus, Grafana

# Check all 7 containers are healthy
docker-compose ps
```

Expected — all `Up`:

```
lexguard-qdrant       Up (healthy)   0.0.0.0:6333->6333
lexguard-postgres     Up (healthy)   0.0.0.0:5432->5432
lexguard-redis        Up (healthy)   0.0.0.0:6379->6379
lexguard-otel         Up             0.0.0.0:4317->4317
lexguard-jaeger       Up             0.0.0.0:16686->16686
lexguard-prometheus   Up             0.0.0.0:9090->9090
lexguard-grafana      Up             0.0.0.0:3001->3000
```

### 5 · Database setup

```powershell
# Generate Prisma client types
pnpm db:generate

# Run migrations (creates all tables)
pnpm db:migrate
# When prompted for migration name, type: init
```

### 6 · Initialise Qdrant (8 collections)

```powershell
pnpm qdrant:init
```

Expected:

```
✅ Qdrant connection healthy
🔨 Creating collection: "contracts"...         ✅ Created
🔨 Creating collection: "legal_templates"...   ✅ Created
🔨 Creating collection: "legal_precedents"...  ✅ Created
🔨 Creating collection: "risk_patterns"...     ✅ Created
🔨 Creating collection: "org_preferences"...   ✅ Created
🔨 Creating collection: "conversation_memory"  ✅ Created
🔨 Creating collection: "jurisdiction_rules"   ✅ Created
🔨 Creating collection: "regulatory_documents" ✅ Created
🎉 Qdrant initialization complete!
```

### 7 · Start the API

```powershell
pnpm dev:api
```

Expected:

```
╔════════════════════════════════════════╗
║       LexGuard AI — API Gateway        ║
╚════════════════════════════════════════╝
  Listening: http://0.0.0.0:4000
  Environment: development
  Enkrypt: ⚠️  disabled
  LexisNexis: ⚠️  disabled
  HITL: ✅ enabled
```

---

## Verify

```powershell
# Health check
curl http://localhost:4000/health

# Readiness check  
curl http://localhost:4000/ready
```

---

## Service URLs

| Service | URL | Notes |
|---|---|---|
| **API Gateway** | http://localhost:4000 | JWT required for all routes |
| **Qdrant Dashboard** | http://localhost:6333/dashboard | Browse collections |
| **Jaeger Tracing** | http://localhost:16686 | Full distributed traces |
| **Prometheus** | http://localhost:9090 | Raw metrics |
| **Grafana** | http://localhost:3001 | admin / admin |
| **Prisma Studio** | `pnpm db:studio` then http://localhost:5555 | DB GUI |

---

## API Endpoints

All routes require `Authorization: Bearer <JWT>` and `X-Tenant-ID: <org_uuid>`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/contracts/upload` | Upload contract (PDF/DOCX) → starts analysis |
| `GET` | `/api/v1/contracts/:id/status` | Workflow status + progress |
| `GET` | `/api/v1/contracts/:id/analysis` | Full analysis report |
| `POST` | `/api/v1/qa` | Legal Q&A against a contract |
| `GET` | `/api/v1/hitl/queue` | HITL pending review queue |
| `POST` | `/api/v1/hitl/:id/decision` | Submit approve/reject/edit |
| `DELETE` | `/api/v1/gdpr/erase/:orgId` | GDPR erasure (24h SLA) |
| `GET` | `/api/v1/audit/trace/:traceId` | Retrieve OTel audit trace |

### Quick test (generate a dev JWT)

```powershell
# Install jose for one-off JWT generation
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
  .then(t => console.log('JWT:', t));
"
```

Then upload a contract:

```powershell
$jwt = "paste-jwt-here"
$orgId = "00000000-0000-0000-0000-000000000001"

curl -X POST http://localhost:4000/api/v1/contracts/upload `
  -H "Authorization: Bearer $jwt" `
  -H "X-Tenant-ID: $orgId" `
  -F "contract=@C:\path\to\your\contract.pdf" `
  -F "jurisdiction=US-CA"
```

---

## Development Commands

```powershell
pnpm infra:up          # Start Docker services
pnpm infra:down        # Stop Docker services
pnpm infra:reset       # Wipe all Docker volumes (fresh start)
pnpm infra:logs        # Follow container logs

pnpm dev:api           # Start API with hot-reload
pnpm qdrant:init       # (Re)create Qdrant 8 collections
pnpm db:generate       # Regenerate Prisma client
pnpm db:migrate        # Run DB migrations
pnpm db:studio         # Open Prisma Studio GUI
pnpm type-check        # TypeScript check across all packages
pnpm build             # Production build (all packages)
pnpm clean             # Remove node_modules everywhere
```

---

## Project Structure

```
lexguard-ai/
├── apps/
│   └── api/                        # Express API Gateway :4000
│       ├── src/
│       │   ├── index.ts            # Entry point + OTel init
│       │   ├── middleware/auth.ts  # JWT RS256 + tenant isolation
│       │   └── routes/contracts.ts # 8 REST endpoints
│       ├── prisma/schema.prisma    # PostgreSQL schema
│       └── keys/                   # RSA key pair (gitignored)
│
├── packages/
│   ├── shared/                     # Zod schemas, constants, env validation
│   ├── agents/src/                 # 13 Mastra agents
│   │   ├── document-agent.ts       # #1  Validate + S3 store
│   │   ├── parsing-agent.ts        # #2  OCR + clause extraction
│   │   ├── embedding-agent.ts      # #3  text-embedding-3-large → Qdrant
│   │   ├── classification-agent.ts # #4  12 clause types (keyword + GPT-4o-mini)
│   │   ├── retrieval-agent.ts      # #5  Hybrid Qdrant search (4 collections)
│   │   ├── risk-agent.ts           # #6  GPT-4o + CRISPE + CoT
│   │   ├── benchmark-agent.ts      # #7  Percentile rank vs templates
│   │   ├── rewrite-agent.ts        # #8  3 safer alternatives (GPT-4o-mini)
│   │   ├── compliance-agent.ts     # #9  GDPR/CCPA jurisdiction check
│   │   ├── evaluation-agent.ts     # #10 Enkrypt pipeline gateway
│   │   ├── memory-agent.ts         # #11 HITL learning → Qdrant
│   │   ├── qa-agent.ts             # #12 Multi-turn Q&A + memory
│   │   └── reporting-agent.ts      # #13 Board-ready report (FK>60)
│   │
│   ├── workflows/
│   │   └── contract-analysis.ts    # Master Mastra 10-step DAG
│   ├── qdrant/                     # Client + 8-collection schema + init script
│   ├── enkrypt/                    # 10-stage safety pipeline (Groups A+B+C)
│   └── observability/              # OTel tracer + Prometheus metrics
│
├── infra/
│   ├── otel/collector-config.yml   # OTel → Jaeger + Prometheus
│   └── prometheus/prometheus.yml   # Scrape config
│
├── docker-compose.yml              # Qdrant, Postgres, Redis, OTel, Jaeger, Prometheus, Grafana
├── .env.example                    # All env vars with descriptions
├── turbo.json                      # Turborepo pipeline
└── README.md                       # This file
```

---

## Agent Pipeline (Visual)

```
Upload (PDF/DOCX)
    │
    ▼ JWT + Rate Limit
  API Gateway :4000
    │
    ▼ Step 1
  Document Agent ──── validate format, extract metadata, S3 store
    │
    ▼ Step 2
  Parsing Agent ───── OCR (Tesseract) or Unstructured.io → clause boundaries
    │
    ▼ Step 3
  Embedding Agent ─── text-embedding-3-large → Qdrant contracts collection
    │
    ▼ Step 4 (Parallel)
  ┌──────────────────────────────────────────────┐
  │ Classification Agent   Retrieval Agent       │
  │ 12 clause types        4-collection search   │
  │ keyword + GPT-4o-mini  org_prefs first       │
  └──────────────────────────────────────────────┘
    │
    ▼ Step 5 (Parallel)
  ┌──────────────────────────────────────────────┐
  │ Risk Agent             Benchmark Agent       │
  │ GPT-4o + CRISPE        Percentile rank       │
  │ 4-step CoT             vs legal_templates    │
  └──────────────────────────────────────────────┘
    │
    ▼ Step 6
  Rewrite Agent ────── 3 safer alternatives (GPT-4o-mini + CRISPE)
    │
    ▼ Step 7
  Compliance Agent ─── GDPR/CCPA/jurisdiction check (conservative)
    │
    ▼ Step 8
  Evaluation Agent ─── Enkrypt 10-stage DAG ≤1.2s
    │                   Gate → [A ‖ B] → C
    ├── PASS (confidence ≥ 0.70)
    │     │
    │     ▼ Step 9
    │   Reporting Agent ─ Executive summary + full JSON report
    │
    └── FAIL / Low confidence
          │
          ▼ HITL Queue (Mastra suspend)
        Lawyer Review
          │
          ▼ Decision (approve/reject/edit)
        Memory Agent ──── update Qdrant risk_patterns + org_preferences
          │
          ▼ Workflow resumes
        Reporting Agent
```

---

## 13-Agent Summary

| # | Agent | Model | Key Responsibility |
|---|---|---|---|
| 1 | Document | GPT-4o-mini | Validate, metadata, S3 |
| 2 | Parsing | GPT-4o | OCR + clause extraction |
| 3 | Embedding | text-embedding-3-large | Vectorise → Qdrant |
| 4 | Classification | GPT-4o-mini | 12 clause types |
| 5 | Retrieval | — | Hybrid search (4 collections) |
| 6 | Risk | GPT-4o | CRISPE + 4-step CoT + citations |
| 7 | Benchmark | GPT-4o | Percentile rank vs templates |
| 8 | Rewrite | GPT-4o-mini | 3 safer alternatives |
| 9 | Compliance | GPT-4o | GDPR/CCPA jurisdiction check |
| 10 | Evaluation | — | Enkrypt 10-stage gateway |
| 11 | Memory | — | HITL learning → Qdrant |
| 12 | Q&A | GPT-4o | Multi-turn conversational |
| 13 | Reporting | GPT-4o-mini | Board-ready report (FK > 60) |

---

## Qdrant Collections

| Collection | Type | Purpose | Scope |
|---|---|---|---|
| `contracts` | Dense + BM25 | Uploaded clause vectors | org_id |
| `legal_templates` | Dense | Industry standard clauses | Global |
| `legal_precedents` | Dense | LexisNexis citations (30d TTL) | Global |
| `risk_patterns` | Dense + BM25 | HITL-learned toxic patterns | org_id |
| `org_preferences` | Dense | Negotiation playbooks | org_id |
| `conversation_memory` | Dense | Q&A history (30d TTL) | session_id |
| `jurisdiction_rules` | Dense | Compliance rules | Jurisdiction |
| `regulatory_documents` | Dense | Full regulatory text | Jurisdiction |

---

## Enkrypt Safety Pipeline (≤ 1,200ms)

```
E-01 Schema Validation (Gate)          <10ms
   ↓
E-02 Prompt Injection  ─┐              Group A  ≤380ms
E-03 Toxicity Detection  ├─ Parallel
E-04 PII Redaction     ─┘
E-05 Hallucination     ─┐              Group B  ≤470ms
E-06 Citation Verify    ├─ Parallel
E-07 Bias Detection     │
E-08 Policy Validation ─┘
   ↓
E-09 Confidence Estimation (Bayesian)  Group C  ≤280ms
E-10 Safe Output Generation
```

Routing: `confidence < 0.70` → HITL | `confidence < 0.85` → disclaimer appended | Hard fail → blocked

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Qdrant not reachable` | Run `docker-compose up -d qdrant` and wait 10s |
| `DATABASE_URL error` | Ensure Postgres is healthy: `docker-compose ps postgres` |
| `JWT public key not found` | Run Step 3 (generate RSA keys) |
| `OPENAI_API_KEY missing` | Add to `.env.local` — required for all agents |
| `pnpm: command not found` | Run `npm install -g pnpm` |
| `Port 4000 in use` | Change `API_PORT` in `.env.local` |
| `docker-compose not found` | Use `docker compose` (v2 syntax, no hyphen) |
| `tsx: command not found` | Run `pnpm install` at the repo root first |

---

## Environment Variables Reference

See [`.env.example`](.env.example) for the full list with descriptions.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | ✅ | — | GPT-4o + embeddings |
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `QDRANT_URL` | ✅ | `http://localhost:6333` | Local Docker |
| `REDIS_URL` | ✅ | `redis://localhost:6379` | Local Docker |
| `NODE_ENV` | — | `development` | |
| `API_PORT` | — | `4000` | |
| `ENKRYPT_ENABLED` | — | `true` | Set `false` for local dev |
| `LEXISNEXIS_ENABLED` | — | `true` | Set `false` for local dev |
| `JWT_RS256_PRIVATE_KEY_PATH` | ✅ | `./keys/private.pem` | |
| `JWT_RS256_PUBLIC_KEY_PATH` | ✅ | `./keys/public.pem` | |
| `ENKRYPT_API_KEY` | Optional | — | Only if ENKRYPT_ENABLED=true |
| `AWS_ACCESS_KEY_ID` | Optional | — | Only for S3 storage in prod |
| `KMS_KEY_ARN` | Optional | — | Only for encryption in prod |

---

## Implementation Status

| Phase | Status | Description |
|---|---|---|
| **Phase 1** | ✅ Complete | Monorepo, Docker stack, Qdrant 8-collection init, Agents 1–3, Mastra workflow skeleton |
| **Phase 2** | ✅ Complete | Agents 4–9 (Classification, Retrieval, Risk, Benchmark, Rewrite, Compliance) |
| **Phase 3** | ✅ Complete | Enkrypt 10-stage pipeline, Evaluation Agent (#10), Memory Agent (#11) |
| **Phase 4** | ✅ Complete | Q&A Agent (#12), Reporting Agent (#13), full REST API, Prisma schema |
| **Phase 5** | 🔄 Planned | HITL Next.js portal, PDF export, load testing, pen test |

---

*LexGuard AI · HiDevs × Mastra Hackathon · v1.0 · July 2026*
