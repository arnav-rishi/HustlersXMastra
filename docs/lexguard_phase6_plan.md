# LexGuard AI — Phase 6: Integration & Infrastructure Plan

Our Next.js UI is beautifully scaffolded, and the Mastra agents are defined, but the platform is currently running on mock data and empty shells. This plan outlines the exact technical steps required to wire the frontend to the real AI backend, spin up the local infrastructure, and integrate external APIs.

## 1. LLM Integration & Workflow Execution (The Brains)
Currently, the Next.js UI (`/`, `/review`, `/qa`) has hardcoded mock JSON arrays. We need to replace these with real Mastra workflow executions.
* **Goal:** When a user uploads a contract, it actually triggers the 13-agent pipeline.
* **Action Items:**
  * Define a `MastraWorkflow` in `packages/workflows` that chains our 13 agents in sequential/parallel steps.
  * Update the Express API (`apps/api`) to expose a `POST /api/v1/contracts/analyze` endpoint.
  * Inside this endpoint, call `mastra.workflows.analyzeContract.execute({ contractText })`.
  * Update the Next.js frontend upload zone to `fetch('/api/v1/contracts/analyze')` instead of using `setTimeout`.
  * Wire the Q&A page to trigger `qaAgent.generate()` in real-time.

## 2. Local Infrastructure (Docker Compose)
The Sidebar links to Qdrant (`localhost:6333`), Grafana (`localhost:3000`), and Jaeger (`localhost:16686`), but clicking them results in connection errors because the containers aren't running.
* **Goal:** Spin up the local backing services required for Vector Storage (Qdrant), Tracing (Jaeger), and Metrics (Grafana/Prometheus).
* **Action Items:**
  * Ensure the `docker-compose.yml` file at the root contains definitions for Qdrant, Jaeger, and Prometheus/Grafana.
  * The user must run `pnpm infra:up` to pull the images and start the containers.
  * *Note:* If using Qdrant Cloud (as per `MASTRA_PROJECT_ID` config), we must update the UI link to point to the Qdrant Cloud Dashboard instead of `localhost:6333`.

## 3. Enkrypt AI Safety Integration (Stage 10)
We defined the `evaluationAgent` for Enkrypt, but it is currently just an OpenAI wrapper prompt. We need to hit the real Enkrypt API for robust safety scanning.
* **Goal:** Pass the final contract analysis through the Enkrypt AI Gateway before showing it to the lawyer.
* **Action Items:**
  * Install the Enkrypt Node.js SDK (or use `fetch` against `ENKRYPT_API_URL`).
  * Modify the `evaluationAgent` execution logic in the workflow to make a REST call to Enkrypt with `ENKRYPT_API_KEY`.
  * Parse the Enkrypt vulnerability response (Prompt Injection, PII, Toxicity).
  * Render the real Enkrypt confidence score dynamically in the HITL Review Queue Next.js UI.

## 4. Qdrant Vector Search Implementation
The `embeddingAgent` and `retrievalAgent` are defined, but they need to actually insert and query vectors from the database.
* **Goal:** Enable Semantic Search for the "Similar Precedents" feature in the HITL review screen.
* **Action Items:**
  * Implement the connection to Qdrant using the `@qdrant/js-client-rest` SDK.
  * Run the `qdrant:init` script to physically create the `contract_clauses` and `risk_patterns` collections.
  * Ensure the Next.js API route fetches the retrieved Qdrant vectors to display under "AI Rewrite Suggestions".

## 5. PostgreSQL & Prisma Database Layer
We need to store the raw contract files, user decisions, and audit logs persistently.
* **Goal:** Replace the `MOCK_CONTRACTS` array with a database.
* **Action Items:**
  * Ensure Prisma schema (`schema.prisma`) is finalized with `Contract`, `Clause`, and `User` models.
  * Run `npx prisma db push` to synchronize the schema with PostgreSQL.
  * Implement the API routes (`GET /api/v1/contracts/pending`) to query Prisma.

## Summary of Next Steps
To begin Phase 6, we will tackle **Item 2 (Infrastructure)** and **Item 1 (LLM Wiring)** first. We need the database and Qdrant running before the agents can store their outputs.
