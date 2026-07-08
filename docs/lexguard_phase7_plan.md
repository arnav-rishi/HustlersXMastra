# LexGuard AI — Phase 7: Finalization, Production Readiness & Launch Plan

Phase 6 connected the first live paths between the UI and backend, but LexGuard is not yet in a true end-to-end, production-ready state. The final phase should focus on removing the remaining mocks and stubs, persisting workflow outputs, hardening the platform, and making every primary screen reflect real contract state.

## 1. Complete the 13-Agent Workflow
The current Mastra workflow only executes the first three stages for real. Steps 4 through 10 still return stubbed outputs, so the platform is not performing a real contract review yet.

* **Goal:** Run the full analysis pipeline from upload through final report generation.
* **Action Items:**
  * Replace the workflow stubs in `packages/workflows/src/contract-analysis.ts` with real calls to:
    * `executeClassificationAgent()`
    * `executeRetrievalAgent()`
    * `executeRiskAgent()`
    * `executeBenchmarkAgent()`
    * `executeRewriteAgent()`
    * `executeComplianceAgent()`
    * `executeEvaluationAgent()`
    * `executeReportingAgent()`
    * `executeMemoryAgent()` where appropriate after HITL decisions
  * Thread `orgId`, `tenantId`, `jurisdiction`, trace metadata, and real clause payloads through every workflow step instead of the current empty-string placeholders.
  * Return the real `contractId` from the workflow instead of reusing `workflowId`.
  * Persist step outputs after each major stage so retries and status polling survive process restarts.
  * Define failure behavior for partial pipeline errors, including resumable states and user-visible failure reasons.

## 2. Persist Contracts, Clauses, Reports, and Workflow State
Phase 6 added a `Clause` model and a pending contracts query, but the live upload path still does not create or update database records consistently.

* **Goal:** Make Postgres the source of truth for all contract lifecycle state.
* **Action Items:**
  * Create a `Contract` row as soon as analysis starts, with `QUEUED` or `PROCESSING` status.
  * Persist parsed clauses into the `clauses` table after the parsing stage.
  * Persist risk scores, rewrite options, compliance findings, Enkrypt confidence, and report metadata.
  * Add a report persistence model if needed, or store the generated report JSON on the contract record with a durable reference.
  * Store workflow run state and timestamps so `GET /status` and `GET /analysis` can return real data.
  * Run `npx prisma db push` locally after the schema is finalized.
  * Add seed data or fixtures for local review/demo environments.

## 3. Replace Remaining Mock UI Screens
The dashboard upload is now live, but the review queue and review detail screens are still fully mock-driven.

* **Goal:** Every primary user-facing page should load real backend data.
* **Action Items:**
  * Replace the hardcoded queue in `apps/web/src/app/review/page.tsx` with a fetch to `GET /api/v1/hitl/queue`.
  * Replace the hardcoded contract/clause/rewrite data in `apps/web/src/app/review/[id]/page.tsx` with live review-item data.
  * Show the real Enkrypt confidence score, flagged clauses, and assigned reviewer information in the queue UI.
  * Load real rewrite suggestions and supporting retrieval context in the review detail screen.
  * Replace any remaining fixed counters on the dashboard with live metrics or derived backend totals.
  * Add explicit loading, empty, and failure states for every screen that now depends on backend calls.

## 4. Finish HITL Workflow Resume and Lawyer Actions
The user-facing review flow currently implies that decisions resume the workflow, but the backend still returns placeholder success responses.

* **Goal:** Make human review a real operational gate.
* **Action Items:**
  * Implement `POST /api/v1/hitl/:id/decision` to:
    * persist the reviewer action,
    * update the queue item status,
    * resume the suspended Mastra workflow,
    * trigger memory updates into Qdrant if the clause was edited or overridden.
  * Add decision-specific validation:
    * `approve`
    * `reject`
    * `edit` with required edited text
  * Track reviewer identity, timestamps, notes, and resulting contract/report state.
  * Make the review detail page submit to the real endpoint and reflect the saved result.
  * Add SLA visibility for overdue HITL items.

## 5. Finish API Coverage for Real Product Flows
Several routes still return placeholder payloads or are only partially wired.

* **Goal:** Ensure every UI action has a reliable API contract behind it.
* **Action Items:**
  * Implement `GET /api/v1/contracts/:id/status` from stored workflow state.
  * Implement `GET /api/v1/contracts/:id/analysis` from persisted report data.
  * Decide whether Q&A should live at `/api/v1/contracts/qa` or `/api/v1/qa` and make route usage consistent across frontend and backend.
  * Add request/response typing for all newly live routes.
  * Add structured error responses for unavailable infra dependencies such as Qdrant, Postgres, and external APIs.
  * Add pagination and filtering to list endpoints where needed.

## 6. Replace Development-Only Document Handling
The current Phase 6 upload path sends inline text to the workflow and uses a fake file URL. That is good for scaffolding, but not for real contracts.

* **Goal:** Accept real files and process them through the intended ingestion pipeline.
* **Action Items:**
  * Use the existing upload endpoint as the main ingestion path for PDF/DOCX files.
  * Store uploaded files in S3 or a local dev-equivalent object store and pass real object references to downstream agents.
  * Connect the dashboard upload zone to multipart upload if the UI is meant to accept binaries directly.
  * Make parsing agents consume real document content instead of mock clause arrays.
  * Add file-type, file-size, and OCR failure feedback to the UI.

## 7. Replace Remaining Simulated Agent Logic
Some agents are defined, but still operate on mock or simplified behavior internally.

* **Goal:** Remove last-mile simulation from core legal analysis paths.
* **Action Items:**
  * Replace mock extraction in `packages/agents/src/parsing-agent.ts` with real Unstructured/Tesseract integration.
  * Ensure scanned PDFs use the OCR path instead of always falling back to the digital extraction helper.
  * Replace any fixed/default report fields like empty `traceId`, placeholder export formats, or hardcoded readability scores.
  * Review agent implementations for dev shortcuts such as fallback defaults, mock citations, and synthetic clause payloads.

## 8. Productionize Enkrypt and External Verification Integrations
Enkrypt is more advanced than the original Phase 6 note implied, but some external validation paths are still simulated.

* **Goal:** Make safety and legal verification trustworthy enough for production use.
* **Action Items:**
  * Validate that `packages/enkrypt/src/pipeline.ts` behaves correctly for plain-text outputs as well as structured JSON outputs.
  * Replace the LexisNexis verification placeholder with real citation verification or explicitly gate the feature behind a flag until ready.
  * Persist Enkrypt stage results and confidence scores so they can be inspected later from the UI and audit logs.
  * Make low-confidence and hard-fail outcomes visible in both the review queue and final report.

## 9. Reporting, Export, and Contract Detail Pages
The report generation step is still stubbed in the workflow, and the UI lacks a true contract detail/report experience.

* **Goal:** Deliver a real analysis artifact lawyers can review and export.
* **Action Items:**
  * Wire the workflow reporting step to `executeReportingAgent()`.
  * Persist the generated report and expose it through `GET /api/v1/contracts/:id/analysis`.
  * Implement a real contract detail or report page for `/contracts/[id]` if that is the intended destination from the dashboard.
  * Support JSON export first, then PDF export once report rendering is stable.
  * Include clause-by-clause findings, rewrite suggestions, compliance flags, Enkrypt confidence, and HITL outcomes in the exported report.

## 10. Security, Auth, and Tenant Isolation for Real Usage
Some live routes currently rely on fallback UUIDs and unauthenticated access so local development can proceed.

* **Goal:** Remove development bypasses before the platform is considered complete.
* **Action Items:**
  * Require auth consistently on production-facing analyze, pending, status, analysis, Q&A, and HITL routes.
  * Remove fallback org/user IDs used for unauthenticated local requests.
  * Enforce tenant scoping on all database reads and writes.
  * Make sure Qdrant filters always include `org_id` where tenant isolation is required.
  * Audit any route that currently accepts client-supplied `orgId` and replace that with server-derived tenant context in production mode.

## 11. Observability, Ops, and Readiness Checks
The observability scaffolding exists, but the runtime still does not expose the true health of dependencies and workflow stages.

* **Goal:** Make the system operable under real load and debuggable when failures happen.
* **Action Items:**
  * Expand `/ready` to check Postgres, Qdrant, Redis, and external service reachability.
  * Emit workflow-stage metrics for counts, latency, failures, and HITL frequency.
  * Persist audit log entries for key agent and review events.
  * Add trace correlation from API request to workflow run to final report.
  * Confirm Grafana and Jaeger dashboards reflect the newly live workflow stages.

## 12. Testing, Tooling, and Release Hardening
The repository still has friction around validation and release confidence.

* **Goal:** Make the project verifiable before launch.
* **Action Items:**
  * Add missing workspace TypeScript configuration so package-level `type-check` commands actually validate code.
  * Add a `packageManager` field in the root `package.json` so workspace tooling like `turbo` resolves correctly.
  * Add focused integration tests for:
    * analyze endpoint,
    * pending contracts query,
    * Q&A endpoint,
    * HITL decision submission,
    * workflow status/analysis retrieval.
  * Add smoke tests for the review queue and review detail pages once they are live.
  * Add a production-readiness checklist covering env vars, infra startup, Prisma sync, Qdrant init, and external API credentials.

## Recommended Phase 7 Execution Order
To complete the product cleanly, Phase 7 should be tackled in this order:

1. Finish workflow execution and persistence.
2. Implement real status, analysis, and HITL APIs.
3. Replace the review queue and review detail UI mocks.
4. Restore real file ingestion and parsing.
5. Finish reporting/export flows.
6. Remove auth/tenant bypasses and add release-grade testing.

## Exit Criteria for Phase 7
Phase 7 should be considered complete only when all of the following are true:

* Uploading a real contract creates a persisted contract record and starts a full workflow run.
* The workflow executes all intended agent stages or pauses cleanly for HITL.
* Review queue and review detail pages show live backend data.
* Lawyer decisions persist and resume the workflow correctly.
* Contract analysis reports can be retrieved after completion.
* No primary screen depends on mock arrays or placeholder backend responses.
* Auth, tenant scoping, and infra health checks are enabled for real operation.
* The project can be type-checked and smoke-tested reliably before release.
