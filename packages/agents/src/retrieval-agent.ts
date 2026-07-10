/**
 * LexGuard AI — Retrieval Agent
 *
 * Agent #5 in the 13-agent swarm.
 *
 * Responsibilities:
 * - Execute hybrid dense + BM25 search across relevant Qdrant collections
 * - Apply tenant-scoped metadata filters (org_id, jurisdiction, clause_type)
 * - Assemble context window (max 8,000 tokens) with priority ordering:
 *     1. org_preferences  (tenant-specific, highest weight)
 *     2. risk_patterns    (learned from HITL corrections)
 *     3. legal_precedents (verified LexisNexis citations)
 *     4. legal_templates  (global benchmarks)
 * - Report cold-start flag if org_preferences returns 0 results
 *
 * Failure behavior (per PRD):
 * - Qdrant circuit breaker open → Redis cache fallback with staleness warning
 * - Zero results → return empty context with retrieval_confidence = "Low"
 *
 * OTel Span: qdrant.hybrid_search
 * Alert: hit_count = 0
 */

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { gpt4oMini } from "./models";
import OpenAI from "openai";
import {
  type RetrievalAgentInput,
  type RetrievalAgentOutput,
  type RetrievedItem,
  RetrievedItemSchema,
} from "@lexguard/shared/schemas";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import {
  QDRANT_COLLECTIONS,
  RETRIEVAL_MIN_SCORE,
  RETRIEVAL_HIGH_CONFIDENCE_SCORE,
  RETRIEVAL_TOP_K,
  MAX_CONTEXT_TOKENS,
  CONTEXT_PRIORITY,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "@lexguard/shared/constants";
import { getQdrantClient } from "@lexguard/qdrant/client";
import { recordQdrantQuery } from "@lexguard/observability/metrics";
import { getEnv } from "@lexguard/shared/env";

// ─── Embedding Helper ──────────────────────────────────────────────────────────

async function embedText(text: string): Promise<number[]> {
  const env = getEnv();
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  return res.data[0]?.embedding ?? new Array(EMBEDDING_DIMENSIONS).fill(0);
}

// ─── Approximate BM25 Sparse Vector ───────────────────────────────────────────
// In production: use a proper BM25 tokenizer library.
// This approximation extracts term frequencies for the most significant tokens.

function approximateSparseVector(
  text: string
): { indices: number[]; values: number[] } {
  const tokens = text.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
  const tf: Record<string, number> = {};
  tokens.forEach((t) => { tf[t] = (tf[t] ?? 0) + 1; });

  const indices: number[] = [];
  const values: number[] = [];

  Object.entries(tf)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50) // top 50 terms
    .forEach(([term, count]) => {
      // Hash term to a bucket index (crude but functional for dev)
      let hash = 0;
      for (const ch of term) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
      indices.push(Math.abs(hash));
      values.push(Math.log(1 + count));
    });

  return { indices, values };
}

// ─── Tool: search_qdrant_collection ──────────────────────────────────────────

const searchQdrantTool = createTool({
  id: "search_qdrant_collection",
  description:
    "Performs hybrid dense + BM25 sparse search on a Qdrant collection with metadata filters.",
  inputSchema: z.object({
    collection: z.string(),
    clauseText: z.string(),
    orgId: z.string().uuid(),
    tenantId: z.string().uuid(),
    jurisdiction: z.string(),
    clauseType: z.string(),
    topK: z.number().default(RETRIEVAL_TOP_K),
    minScore: z.number().default(RETRIEVAL_MIN_SCORE),
    requireOrgScope: z.boolean().default(false),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        id: z.union([z.string(), z.number()]),
        score: z.number(),
        payload: z.record(z.unknown()),
      })
    ),
    hitCount: z.number(),
    collection: z.string(),
    latencyMs: z.number(),
  }),
  execute: async (input, context) => {
    const {
      collection,
      clauseText,
      orgId,
      jurisdiction,
      clauseType,
      topK,
      minScore,
      requireOrgScope,
    } = input;

    const qdrant = getQdrantClient();

    // Check circuit breaker
    if (qdrant.isCircuitOpen()) {
      console.warn(`[RetrievalAgent] Qdrant circuit open — returning empty results for ${collection}`);
      return { results: [], hitCount: 0, collection, latencyMs: 0 };
    }

    const start = Date.now();

    // Generate dense embedding for the query
    const denseVector = await embedText(clauseText);
    const sparseVector = approximateSparseVector(clauseText);

    // Build filter
    const mustFilters: any[] = [];

    if (requireOrgScope) {
      mustFilters.push({ key: "org_id", match: { value: orgId } });
    }
    if (jurisdiction !== "Unknown") {
      mustFilters.push({ key: "jurisdiction", match: { value: jurisdiction } });
    }
    if (clauseType) {
      mustFilters.push({ key: "clause_type", match: { value: clauseType } });
    }

    const filter = mustFilters.length > 0
      ? { must: mustFilters }
      : {};

    const results = await qdrant.hybridSearch(
      collection,
      denseVector,
      sparseVector,
      filter,
      topK,
      minScore
    );

    const latencyMs = Date.now() - start;
    const missed = results.length === 0;
    recordQdrantQuery(missed);

    return {
      results,
      hitCount: results.length,
      collection,
      latencyMs,
    };
  },
});

// ─── Agent Definition ─────────────────────────────────────────────────────────

export const retrievalAgent: Agent = new Agent({
  id: "retrieval-agent",
  name: "retrieval-agent",
  instructions: `You are the Retrieval Agent in the LexGuard AI legal intelligence platform.

For each clause, you assemble the richest possible context from Qdrant semantic memory:

COLLECTION SEARCH ORDER (priority):
1. org_preferences — tenant-specific negotiation stances (ALWAYS search this first)
2. risk_patterns — learned "toxic" clause patterns from HITL corrections
3. legal_precedents — verified LexisNexis citations
4. legal_templates — global industry-standard templates for benchmarking

RULES:
- Always apply org_id filter to org_preferences and risk_patterns
- Apply jurisdiction filter where available  
- Minimum similarity threshold: ${RETRIEVAL_MIN_SCORE}
- Return maximum ${RETRIEVAL_TOP_K} results per collection
- Flag cold_start = true if org_preferences returns 0 results
- Assemble results in priority order for the context window

Use the search_qdrant_collection tool for each relevant collection.`,

  model: gpt4oMini,

  tools: {
    search_qdrant_collection: searchQdrantTool,
  },
});

// ─── Agent Executor ───────────────────────────────────────────────────────────

export async function executeRetrievalAgent(
  input: RetrievalAgentInput
): Promise<RetrievalAgentOutput> {
  return withSpan(
    OTEL_SPAN_NAMES.QDRANT_HYBRID_SEARCH,
    {
      "lexguard.org_id": input.orgId,
      "lexguard.contract_id": input.contractId,
      "lexguard.agent_id": "retrieval-agent",
      "qdrant.clause_type": input.clause.clauseType ?? "unknown",
      "qdrant.jurisdiction": input.jurisdiction,
    },
    async (span) => {
      const start = Date.now();
      const allResults: RetrievedItem[] = [];
      let totalContextTokens = 0;
      let coldStart = false;

      // ── 1. org_preferences (highest priority, org-scoped) ───────────────────
      const prefResult = (await searchQdrantTool.execute?.({ collection: QDRANT_COLLECTIONS.ORG_PREFERENCES, clauseText: input.clause.clauseText, orgId: input.orgId, tenantId: input.tenantId, jurisdiction: input.jurisdiction, clauseType: input.clause.clauseType ?? "", topK: RETRIEVAL_TOP_K, minScore: RETRIEVAL_MIN_SCORE, requireOrgScope: true }, {} as any)) as any || { results: [], hitCount: 0 };

      if (prefResult.hitCount === 0) coldStart = true;

      prefResult.results.forEach((r: any) => {
        allResults.push({
          collection: QDRANT_COLLECTIONS.ORG_PREFERENCES,
          id: String(r.id),
          score: r.score,
          payload: r.payload,
          priority: CONTEXT_PRIORITY.ORG_PREFERENCES,
        });
        totalContextTokens += estimateTokens(JSON.stringify(r.payload));
      });

      // ── 2. risk_patterns (org-scoped) ──────────────────────────────────────
      if (totalContextTokens < MAX_CONTEXT_TOKENS) {
        const riskResult = (await searchQdrantTool.execute?.({ collection: QDRANT_COLLECTIONS.RISK_PATTERNS, clauseText: input.clause.clauseText, orgId: input.orgId, tenantId: input.tenantId, jurisdiction: input.jurisdiction, clauseType: input.clause.clauseType ?? "", topK: RETRIEVAL_TOP_K, minScore: RETRIEVAL_MIN_SCORE, requireOrgScope: true }, {} as any)) as any || { results: [] };

        riskResult.results.forEach((r: any) => {
          allResults.push({
            collection: QDRANT_COLLECTIONS.RISK_PATTERNS,
            id: String(r.id),
            score: r.score,
            payload: r.payload,
            priority: CONTEXT_PRIORITY.RISK_PATTERNS,
          });
          totalContextTokens += estimateTokens(JSON.stringify(r.payload));
        });
      }

      // ── 3. legal_precedents ────────────────────────────────────────────────
      if (totalContextTokens < MAX_CONTEXT_TOKENS) {
        const precedentResult = (await searchQdrantTool.execute?.({ collection: QDRANT_COLLECTIONS.LEGAL_PRECEDENTS, clauseText: input.clause.clauseText, orgId: input.orgId, tenantId: input.tenantId, jurisdiction: input.jurisdiction, clauseType: "", topK: RETRIEVAL_TOP_K, minScore: RETRIEVAL_MIN_SCORE, requireOrgScope: false }, {} as any)) as any || { results: [] };

        precedentResult.results.forEach((r: any) => {
          allResults.push({
            collection: QDRANT_COLLECTIONS.LEGAL_PRECEDENTS,
            id: String(r.id),
            score: r.score,
            payload: r.payload,
            priority: CONTEXT_PRIORITY.LEGAL_PRECEDENTS,
          });
          totalContextTokens += estimateTokens(JSON.stringify(r.payload));
        });
      }

      // ── 4. legal_templates (global benchmark) ─────────────────────────────
      if (totalContextTokens < MAX_CONTEXT_TOKENS) {
        const templateResult = (await searchQdrantTool.execute?.({ collection: QDRANT_COLLECTIONS.LEGAL_TEMPLATES, clauseText: input.clause.clauseText, orgId: input.orgId, tenantId: input.tenantId, jurisdiction: input.jurisdiction, clauseType: input.clause.clauseType ?? "", topK: RETRIEVAL_TOP_K, minScore: RETRIEVAL_MIN_SCORE, requireOrgScope: false }, {} as any)) as any || { results: [] };

        templateResult.results.forEach((r: any) => {
          allResults.push({
            collection: QDRANT_COLLECTIONS.LEGAL_TEMPLATES,
            id: String(r.id),
            score: r.score,
            payload: r.payload,
            priority: CONTEXT_PRIORITY.LEGAL_TEMPLATES,
          });
          totalContextTokens += estimateTokens(JSON.stringify(r.payload));
        });
      }

      const latencyMs = Date.now() - start;
      const totalHits = allResults.length;

      // Determine retrieval confidence
      const avgScore = totalHits > 0
        ? allResults.reduce((s, r) => s + r.score, 0) / totalHits
        : 0;

      const retrievalConfidence: "High" | "Medium" | "Low" =
        avgScore >= RETRIEVAL_HIGH_CONFIDENCE_SCORE
          ? "High"
          : avgScore >= RETRIEVAL_MIN_SCORE
          ? "Medium"
          : "Low";

      // OTel span attributes per PRD Appendix C
      span.setAttribute("qdrant.hit_count", totalHits);
      span.setAttribute("qdrant.top_k", RETRIEVAL_TOP_K);
      span.setAttribute("qdrant.min_score", RETRIEVAL_MIN_SCORE);
      span.setAttribute("qdrant.latency_ms", latencyMs);
      span.setAttribute("retrieval.cold_start", coldStart);
      span.setAttribute("retrieval.confidence", retrievalConfidence);
      span.setAttribute("retrieval.context_tokens", totalContextTokens);

      // Alert: zero results
      if (totalHits === 0) {
        console.warn(
          `[RetrievalAgent] Zero results for clause ${input.clause.clauseIndex} (${input.clause.clauseType}) in contract ${input.contractId}`
        );
      }

      return {
        clauseIndex: input.clause.clauseIndex,
        retrievedItems: allResults.sort((a, b) => a.priority - b.priority),
        contextTokenCount: totalContextTokens,
        retrievalConfidence,
        cacheHit: false,
        retrievalLatencyMs: latencyMs,
        coldStart,
      };
    }
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4); // rough approximation: ~4 chars/token
}
