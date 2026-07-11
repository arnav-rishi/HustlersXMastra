/**
 * LexGuard AI — Shared Constants
 *
 * All system-wide constants. Sourced from PRD v2.0.
 * Do NOT use magic numbers anywhere in the codebase — always reference here.
 */

// ─── Qdrant Collections ──────────────────────────────────────────────────────
export const QDRANT_COLLECTIONS = {
  CONTRACTS: "contracts",
  LEGAL_TEMPLATES: "legal_templates",
  LEGAL_PRECEDENTS: "legal_precedents",
  RISK_PATTERNS: "risk_patterns",
  ORG_PREFERENCES: "org_preferences",
  CONVERSATION_MEMORY: "conversation_memory",
  JURISDICTION_RULES: "jurisdiction_rules",
  REGULATORY_DOCUMENTS: "regulatory_documents",
} as const;

export type QdrantCollection =
  (typeof QDRANT_COLLECTIONS)[keyof typeof QDRANT_COLLECTIONS];

// ─── Embedding ───────────────────────────────────────────────────────────────
export const EMBEDDING_MODEL = "text-embedding-3-large";
export const EMBEDDING_DIMENSIONS = 1536;
export const CHUNK_SIZE_TOKENS = 512;
export const CHUNK_OVERLAP_TOKENS = 64;

// ─── LLM Models ──────────────────────────────────────────────────────────────
export const LLM_MODELS = {
  /** Primary reasoning — risk analysis, compliance, Q&A */
  GPT4O: "gpt-4o",
  /** Cost-efficient — rewrite generation */
  GPT4O_MINI: "gpt-4o-mini",
} as const;

// ─── Risk Severity ────────────────────────────────────────────────────────────
export const RISK_SEVERITY = {
  CRITICAL: "Critical",
  MODERATE: "Moderate",
  LOW: "Low",
} as const;

export type RiskSeverity = (typeof RISK_SEVERITY)[keyof typeof RISK_SEVERITY];

// ─── Clause Types ─────────────────────────────────────────────────────────────
export const CLAUSE_TYPES = [
  "indemnification",
  "limitation_of_liability",
  "ip_ownership",
  "auto_renewal",
  "termination",
  "payment_terms",
  "confidentiality",
  "data_processing",
  "warranty",
  "dispute_resolution",
  "force_majeure",
  "assignment",
] as const;

export type ClauseType = (typeof CLAUSE_TYPES)[number];

// ─── Retrieval ────────────────────────────────────────────────────────────────
// Calibrated against real text-embedding-3-large cosine similarities for this
// app's actual retrieval patterns (question-vs-clause, clause-vs-precedent):
// on-topic matches score ~0.15-0.55, unrelated content scores <0.05. A 0.75
// threshold (the original value) filtered out every real result, every time.
/** Minimum similarity score for a retrieval result to be used */
export const RETRIEVAL_MIN_SCORE = 0.15;
/** Score at which we classify retrieval as "High Confidence" */
export const RETRIEVAL_HIGH_CONFIDENCE_SCORE = 0.4;
/** Maximum results returned per collection query */
export const RETRIEVAL_TOP_K = 5;
/** Maximum context window assembled for downstream agents (tokens) */
export const MAX_CONTEXT_TOKENS = 8_000;

// ─── Context Priority (lower = higher priority) ───────────────────────────────
export const CONTEXT_PRIORITY = {
  ORG_PREFERENCES: 1,
  RISK_PATTERNS: 2,
  LEGAL_PRECEDENTS: 3,
  LEGAL_TEMPLATES: 4,
} as const;

// ─── Enkrypt Pipeline ─────────────────────────────────────────────────────────
/** Minimum confidence score; below this routes to HITL */
export const ENKRYPT_CONFIDENCE_THRESHOLD = 0.70;
/** Minimum confidence for Q&A delivery */
export const ENKRYPT_QA_CONFIDENCE_THRESHOLD = 0.85;
/** Latency budgets (ms) */
export const ENKRYPT_LATENCY = {
  GATE: 10,
  GROUP_A_MAX: 380,
  GROUP_B_MAX: 470,
  GROUP_C_MAX: 280,
  TOTAL_MAX: 1_200,
} as const;

// ─── SLA Targets ─────────────────────────────────────────────────────────────
export const SLA = {
  /** P95 end-to-end contract analysis (ms) */
  CONTRACT_ANALYSIS_P95_MS: 15_000,
  /** Qdrant hybrid search P95 (ms) */
  QDRANT_SEARCH_P95_MS: 500,
  /** Qdrant write max (ms) */
  QDRANT_WRITE_MAX_MS: 200,
  /** HITL workflow resume max (ms) */
  HITL_RESUME_MAX_MS: 2_000,
  /** HITL memory write after decision (ms) */
  HITL_MEMORY_WRITE_MS: 5_000,
  /** GDPR erasure SLA (hours) */
  GDPR_ERASURE_HOURS: 24,
} as const;

// ─── Retry Policy ────────────────────────────────────────────────────────────
export const RETRY = {
  MAX_ATTEMPTS: 3,
  /** Base backoff in ms; doubles each retry: 2000 → 4000 → 8000 */
  BASE_DELAY_MS: 2_000,
  /** Absolute timeout per agent step (ms) */
  STEP_TIMEOUT_MS: 30_000,
} as const;

// ─── TTL Values ───────────────────────────────────────────────────────────────
export const TTL = {
  /** LexisNexis citation cache in Qdrant legal_precedents (days) */
  LEGAL_PRECEDENTS_DAYS: 30,
  /** Conversation memory (days) */
  CONVERSATION_MEMORY_DAYS: 30,
  /** Audit log retention (years) */
  AUDIT_LOG_YEARS: 7,
  /** JWT access token (seconds) */
  JWT_ACCESS_TOKEN_S: 3_600,
  /** LexisNexis OAuth2 token (seconds) */
  LEXISNEXIS_TOKEN_S: 3_600,
} as const;

// ─── Rate Limiting ────────────────────────────────────────────────────────────
/** Requests per minute per tenant (default) */
export const RATE_LIMIT_DEFAULT_RPM = 100;

// ─── OCR ─────────────────────────────────────────────────────────────────────
/** Minimum OCR confidence score; below this routes to HITL */
export const OCR_MIN_CONFIDENCE = 0.90;
/** Target OCR accuracy */
export const OCR_TARGET_ACCURACY = 0.98;

// ─── Report ───────────────────────────────────────────────────────────────────
/** Flesch-Kincaid minimum readability score for executive summaries */
export const FK_READABILITY_MIN = 60;

// ─── HITL ────────────────────────────────────────────────────────────────────
/** Alert if HITL queue depth exceeds this */
export const HITL_QUEUE_ALERT_DEPTH = 50;

// ─── Observability ───────────────────────────────────────────────────────────
export const OTEL_SPAN_NAMES = {
  API_GATEWAY_REQUEST: "api_gateway.request",
  MASTRA_WORKFLOW_START: "mastra.workflow.start",
  MASTRA_WORKFLOW_COMPLETE: "mastra.workflow.complete",
  MASTRA_HITL_PAUSE: "mastra.hitl.pause",
  MASTRA_HITL_RESUME: "mastra.hitl.resume",
  AGENT_DOCUMENT_VALIDATE: "agent.document.validate",
  AGENT_PARSING_EXECUTE: "agent.parsing.execute",
  AGENT_EMBEDDING_EXECUTE: "agent.embedding.execute",
  AGENT_CLASSIFICATION_EXECUTE: "agent.classification.execute",
  QDRANT_HYBRID_SEARCH: "qdrant.hybrid_search",
  LLM_GPT4O_COMPLETION: "llm.gpt4o.completion",
  LLM_GPT4O_MINI_COMPLETION: "llm.gpt4o_mini.completion",
  ENKRYPT_PIPELINE_VALIDATE: "enkrypt.pipeline.validate",
  LEXISNEXIS_CITATION_LOOKUP: "lexisnexis.citation.lookup",
  MEMORY_QDRANT_WRITE: "memory.qdrant.write",
  AGENT_REPORTING_GENERATE: "agent.reporting.generate",
} as const;
