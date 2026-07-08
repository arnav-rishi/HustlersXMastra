/**
 * LexGuard AI — Qdrant 8-Collection Schema Definitions
 *
 * Defines the exact collection configuration for each of the 8 Qdrant collections
 * per PRD v2.0 Section 11 (Data Requirements & Qdrant Schema).
 *
 * Collection design decisions:
 * - contracts, risk_patterns, org_preferences: Hybrid dense+BM25 sparse
 * - legal_templates, legal_precedents, jurisdiction_rules, regulatory_documents: Dense only
 * - conversation_memory: Dense with TTL indexing
 *
 * All collections use text-embedding-3-large (1536 dimensions).
 */

type CreateCollection = any;
import { EMBEDDING_DIMENSIONS, QDRANT_COLLECTIONS } from "@lexguard/shared/constants";

// ─── Vector Config Helpers ────────────────────────────────────────────────────

const DENSE_VECTOR_CONFIG = {
  size: EMBEDDING_DIMENSIONS,
  distance: "Cosine" as const,
  hnsw_config: {
    m: 16,
    ef_construct: 100,
    full_scan_threshold: 10000,
  },
  quantization_config: {
    scalar: {
      type: "int8" as const,
      quantile: 0.99,
      always_ram: true,
    },
  },
} as const;

// ─── Collection Definitions ───────────────────────────────────────────────────

/**
 * contracts — Clause-level embeddings from uploaded contracts
 * Supports: hybrid dense + BM25 sparse
 * Filter fields: org_id, tenant_id, jurisdiction, clause_type, risk_level
 */
export const contractsCollectionConfig: CreateCollection = {
  vectors: {
    dense: DENSE_VECTOR_CONFIG,
  },
  sparse_vectors: {
    bm25: {
      index: {
        full_scan_threshold: 5000,
      },
    },
  },
  optimizers_config: {
    default_segment_number: 5,
    indexing_threshold: 20000,
  },
  replication_factor: 2,
  write_consistency_factor: 1,
};

/**
 * legal_templates — Global industry-standard clause templates for benchmarking
 * Supports: dense similarity only
 * Filter fields: clause_type, industry_sector, jurisdiction
 */
export const legalTemplatesCollectionConfig: CreateCollection = {
  vectors: {
    dense: DENSE_VECTOR_CONFIG,
  },
  optimizers_config: {
    default_segment_number: 3,
    indexing_threshold: 10000,
  },
  replication_factor: 2,
};

/**
 * legal_precedents — Cached LexisNexis verified citations (30-day TTL)
 * Supports: dense similarity
 * Filter fields: jurisdiction, lexisnexis_verified
 */
export const legalPrecedentsCollectionConfig: CreateCollection = {
  vectors: {
    dense: DENSE_VECTOR_CONFIG,
  },
  // TTL handled via payload field + application-level eviction job
  optimizers_config: {
    default_segment_number: 3,
    indexing_threshold: 5000,
  },
  replication_factor: 2,
};

/**
 * risk_patterns — Learned "toxic" clause patterns from HITL rejections
 * Supports: hybrid dense + BM25 (org-scoped)
 * Filter fields: org_id, clause_type, risk_level
 * Updated: on every HITL rejection
 */
export const riskPatternsCollectionConfig: CreateCollection = {
  vectors: {
    dense: DENSE_VECTOR_CONFIG,
  },
  sparse_vectors: {
    bm25: {
      index: {
        full_scan_threshold: 5000,
      },
    },
  },
  optimizers_config: {
    default_segment_number: 3,
    indexing_threshold: 10000,
  },
  replication_factor: 2,
};

/**
 * org_preferences — Tenant-specific negotiation playbooks
 * Supports: dense similarity (strict org_id isolation)
 * Filter fields: org_id, preference_type
 * Write: HITL approve/edit actions
 */
export const orgPreferencesCollectionConfig: CreateCollection = {
  vectors: {
    dense: DENSE_VECTOR_CONFIG,
  },
  optimizers_config: {
    default_segment_number: 2,
    indexing_threshold: 5000,
  },
  replication_factor: 2,
};

/**
 * conversation_memory — Short-term multi-turn Q&A session memory (30-day TTL)
 * Supports: dense similarity
 * Filter fields: session_id, org_id, user_id
 */
export const conversationMemoryCollectionConfig: CreateCollection = {
  vectors: {
    dense: DENSE_VECTOR_CONFIG,
  },
  optimizers_config: {
    default_segment_number: 2,
    indexing_threshold: 5000,
  },
  replication_factor: 1,  // lower replication — ephemeral data
};

/**
 * jurisdiction_rules — Jurisdiction-specific compliance rules
 * Supports: dense similarity
 * Filter fields: jurisdiction_code, rule_category, applies_to_clause_types
 * Update: Manual on regulatory change
 */
export const jurisdictionRulesCollectionConfig: CreateCollection = {
  vectors: {
    dense: DENSE_VECTOR_CONFIG,
  },
  optimizers_config: {
    default_segment_number: 2,
    indexing_threshold: 5000,
  },
  replication_factor: 2,
};

/**
 * regulatory_documents — Full-text regulatory documents (512-token chunks)
 * Supports: dense similarity
 * Filter fields: jurisdiction, regulation_name
 * Chunking: 512 tokens with 64-token overlap
 */
export const regulatoryDocumentsCollectionConfig: CreateCollection = {
  vectors: {
    dense: DENSE_VECTOR_CONFIG,
  },
  optimizers_config: {
    default_segment_number: 3,
    indexing_threshold: 20000,
  },
  replication_factor: 2,
};

// ─── Collection Registry ──────────────────────────────────────────────────────

export const COLLECTION_CONFIGS: Record<string, CreateCollection> = {
  [QDRANT_COLLECTIONS.CONTRACTS]: contractsCollectionConfig,
  [QDRANT_COLLECTIONS.LEGAL_TEMPLATES]: legalTemplatesCollectionConfig,
  [QDRANT_COLLECTIONS.LEGAL_PRECEDENTS]: legalPrecedentsCollectionConfig,
  [QDRANT_COLLECTIONS.RISK_PATTERNS]: riskPatternsCollectionConfig,
  [QDRANT_COLLECTIONS.ORG_PREFERENCES]: orgPreferencesCollectionConfig,
  [QDRANT_COLLECTIONS.CONVERSATION_MEMORY]: conversationMemoryCollectionConfig,
  [QDRANT_COLLECTIONS.JURISDICTION_RULES]: jurisdictionRulesCollectionConfig,
  [QDRANT_COLLECTIONS.REGULATORY_DOCUMENTS]: regulatoryDocumentsCollectionConfig,
};

// ─── Payload Index Definitions ────────────────────────────────────────────────
// These indexes enable fast metadata-filtered search on high-cardinality fields.

export const PAYLOAD_INDEXES: Record<string, Array<{ field: string; type: string }>> = {
  [QDRANT_COLLECTIONS.CONTRACTS]: [
    { field: "org_id", type: "keyword" },
    { field: "tenant_id", type: "keyword" },
    { field: "jurisdiction", type: "keyword" },
    { field: "clause_type", type: "keyword" },
    { field: "risk_level", type: "keyword" },
    { field: "contract_id", type: "keyword" },
  ],
  [QDRANT_COLLECTIONS.RISK_PATTERNS]: [
    { field: "org_id", type: "keyword" },
    { field: "clause_type", type: "keyword" },
    { field: "risk_level", type: "keyword" },
  ],
  [QDRANT_COLLECTIONS.ORG_PREFERENCES]: [
    { field: "org_id", type: "keyword" },
    { field: "preference_type", type: "keyword" },
  ],
  [QDRANT_COLLECTIONS.CONVERSATION_MEMORY]: [
    { field: "session_id", type: "keyword" },
    { field: "org_id", type: "keyword" },
    { field: "user_id", type: "keyword" },
  ],
  [QDRANT_COLLECTIONS.LEGAL_TEMPLATES]: [
    { field: "clause_type", type: "keyword" },
    { field: "industry_sector", type: "keyword" },
    { field: "jurisdiction", type: "keyword" },
  ],
  [QDRANT_COLLECTIONS.LEGAL_PRECEDENTS]: [
    { field: "jurisdiction", type: "keyword" },
    { field: "lexisnexis_verified", type: "bool" },
  ],
  [QDRANT_COLLECTIONS.JURISDICTION_RULES]: [
    { field: "jurisdiction_code", type: "keyword" },
    { field: "rule_category", type: "keyword" },
  ],
  [QDRANT_COLLECTIONS.REGULATORY_DOCUMENTS]: [
    { field: "jurisdiction", type: "keyword" },
    { field: "regulation_name", type: "keyword" },
  ],
};
