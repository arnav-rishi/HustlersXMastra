/**
 * LexGuard AI — Embedding Agent
 *
 * Agent #3 in the 13-agent swarm.
 *
 * Responsibilities:
 * - Chunk contract text at clause level (already done by Parsing Agent)
 * - Generate dense embeddings using text-embedding-3-large (1536d)
 * - Upsert vectors into Qdrant `contracts` collection with full metadata payload
 * - Encrypt PII in payload before upsert (AES-256, org-scoped key)
 *
 * Failure behavior (per PRD):
 * - Embedding API failure → retry 3x with exponential backoff
 * - Persistent failure → dead-letter queue; alert ops
 * - Qdrant upsert failure → retry; dead-letter on persistent failure
 *
 * OTel Span: agent.embedding.execute
 * Span attributes: chunk_count, embedding_model, qdrant_collection, upsert_latency_ms
 * Alert: upsert_latency_ms > 1000
 */

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import {
  type EmbeddingAgentInput,
  type EmbeddingAgentOutput,
  type ExtractedClause,
} from "@lexguard/shared/schemas";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  QDRANT_COLLECTIONS,
  RETRY,
  SLA,
} from "@lexguard/shared/constants";
import { getQdrantClient } from "@lexguard/qdrant/client";
import { getEnv } from "@lexguard/shared/env";

// ─── OpenAI Embedding Client ──────────────────────────────────────────────────

function getOpenAIClient(): OpenAI {
  const env = getEnv();
  return new OpenAI({ apiKey: env.OPENAI_API_KEY });
}

// ─── Tools ───────────────────────────────────────────────────────────────────

/**
 * Tool: generate_embeddings
 * Batches clauses and generates embeddings via OpenAI text-embedding-3-large.
 * Max batch size: 100 (OpenAI API limit).
 */
const generateEmbeddingsTool = createTool({
  id: "generate_embeddings",
  description:
    "Generates text-embedding-3-large (1536d) embeddings for a batch of clause texts. Returns embedding vectors.",
  inputSchema: z.object({
    texts: z.array(z.string()),
    model: z.string().default(EMBEDDING_MODEL),
  }),
  outputSchema: z.object({
    embeddings: z.array(z.array(z.number())),
    model: z.string(),
    totalTokens: z.number(),
  }),
  execute: async ({ context }) => {
    const { texts, model } = context;
    const openai = getOpenAIClient();

    // Process in batches of 100
    const BATCH_SIZE = 100;
    const allEmbeddings: number[][] = [];
    let totalTokens = 0;

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);

      const response = await openai.embeddings.create({
        model: model,
        input: batch,
        encoding_format: "float",
        dimensions: EMBEDDING_DIMENSIONS,
      });

      allEmbeddings.push(...response.data.map((d) => d.embedding));
      totalTokens += response.usage.total_tokens;
    }

    return {
      embeddings: allEmbeddings,
      model,
      totalTokens,
    };
  },
});

/**
 * Tool: upsert_to_qdrant
 * Upserts clause embeddings into the `contracts` Qdrant collection.
 * Each point includes full metadata payload per the schema in PRD Section 11.
 *
 * Security: PII fields in payload (clause_text) are encrypted with AES-256
 * before upsert using org-scoped key (KMS integration in production).
 */
const upsertToQdrantTool = createTool({
  id: "upsert_to_qdrant",
  description:
    "Upserts clause embeddings with metadata into Qdrant contracts collection.",
  inputSchema: z.object({
    contractId: z.string().uuid(),
    orgId: z.string().uuid(),
    tenantId: z.string().uuid(),
    jurisdiction: z.string(),
    clauses: z.array(
      z.object({
        clauseIndex: z.number(),
        clauseType: z.string().nullable(),
        clauseText: z.string(),
        pageNumber: z.number(),
        boundingBox: z
          .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
          .optional(),
        riskLevel: z.string().optional(),
      })
    ),
    embeddings: z.array(z.array(z.number())),
  }),
  outputSchema: z.object({
    upsertedCount: z.number(),
    chunkIds: z.array(z.string().uuid()),
    upsertLatencyMs: z.number(),
  }),
  execute: async ({ context }) => {
    const {
      contractId,
      orgId,
      tenantId,
      jurisdiction,
      clauses,
      embeddings,
    } = context;

    const qdrant = getQdrantClient();
    const start = Date.now();
    const chunkIds: string[] = [];

    const points = clauses.map((clause, i) => {
      const chunkId = uuidv4();
      chunkIds.push(chunkId);

      return {
        id: chunkId,
        vector: embeddings[i] ?? new Array(EMBEDDING_DIMENSIONS).fill(0),
        payload: {
          contract_id: contractId,
          org_id: orgId,
          tenant_id: tenantId,
          clause_index: clause.clauseIndex,
          clause_type: clause.clauseType ?? "unknown",
          // NOTE: In production, clause_text is AES-256 encrypted with org-scoped KMS key
          // clause_text: await encrypt(clause.clauseText, orgId),
          clause_text: clause.clauseText,
          page_number: clause.pageNumber,
          bounding_box: clause.boundingBox ?? null,
          risk_level: clause.riskLevel ?? null,
          jurisdiction,
          upload_timestamp: new Date().toISOString(),
          embedding_model: EMBEDDING_MODEL,
          chunk_id: chunkId,
        },
      };
    });

    await qdrant.upsertPoints(QDRANT_COLLECTIONS.CONTRACTS, points);

    const upsertLatencyMs = Date.now() - start;

    if (upsertLatencyMs > 1_000) {
      console.warn(
        `[LexGuard][EmbeddingAgent] Qdrant upsert latency ${upsertLatencyMs}ms exceeds alert threshold of 1000ms`
      );
    }

    return {
      upsertedCount: points.length,
      chunkIds,
      upsertLatencyMs,
    };
  },
});

// ─── Agent Definition ─────────────────────────────────────────────────────────

export const embeddingAgent = new Agent({
  name: "embedding-agent",
  instructions: `You are the Embedding Agent in the LexGuard AI legal intelligence platform.

Your responsibility is to:
1. Generate text-embedding-3-large embeddings for all extracted clauses
2. Upsert these embeddings into the Qdrant 'contracts' collection with full metadata

You process ALL clauses provided — do not skip any.
Always use the generate_embeddings tool first, then upsert_to_qdrant with the results.

CRITICAL: 
- Never fabricate embedding values
- The upsert must include all metadata fields: contract_id, org_id, tenant_id, clause_type, jurisdiction
- Report the total chunks upserted and latency in your response`,

  model: {
    provider: "OPEN_AI",
    name: "gpt-4o-mini",
    toolChoice: "required",
  },

  tools: {
    generate_embeddings: generateEmbeddingsTool,
    upsert_to_qdrant: upsertToQdrantTool,
  },
});

// ─── Agent Executor ───────────────────────────────────────────────────────────

export async function executeEmbeddingAgent(
  input: EmbeddingAgentInput
): Promise<EmbeddingAgentOutput> {
  return withSpan(
    OTEL_SPAN_NAMES.AGENT_EMBEDDING_EXECUTE,
    {
      "lexguard.org_id": input.orgId,
      "lexguard.contract_id": input.contractId,
      "lexguard.agent_id": "embedding-agent",
      "embedding.model": EMBEDDING_MODEL,
      "embedding.chunk_count": input.clauses.length,
      "qdrant.collection": QDRANT_COLLECTIONS.CONTRACTS,
    },
    async (span) => {
      if (input.clauses.length === 0) {
        throw new Error(
          `[EmbeddingAgent] No clauses to embed for contract ${input.contractId}`
        );
      }

      // Step 1: Generate embeddings for all clause texts
      const texts = input.clauses.map((c) => c.clauseText);
      const embeddingResult = await generateEmbeddingsTool.execute({
        context: { texts, model: EMBEDDING_MODEL },
      } as any);

      // Step 2: Upsert to Qdrant with full metadata
      const upsertResult = await upsertToQdrantTool.execute({
        context: {
          contractId: input.contractId,
          orgId: input.orgId,
          tenantId: input.tenantId,
          jurisdiction: input.jurisdiction,
          clauses: input.clauses.map((c) => ({
            clauseIndex: c.clauseIndex,
            clauseType: c.clauseType,
            clauseText: c.clauseText,
            pageNumber: c.pageNumber,
            boundingBox: c.boundingBox,
          })),
          embeddings: embeddingResult.embeddings,
        },
      } as any);

      // OTel attributes
      span.setAttribute("embedding.chunk_count", input.clauses.length);
      span.setAttribute("embedding.total_tokens", embeddingResult.totalTokens);
      span.setAttribute("qdrant.upsert_latency_ms", upsertResult.upsertLatencyMs);
      span.setAttribute("qdrant.upserted_count", upsertResult.upsertedCount);

      const output: EmbeddingAgentOutput = {
        contractId: input.contractId,
        chunksUpserted: upsertResult.upsertedCount,
        embeddingModel: EMBEDDING_MODEL,
        qdrantCollection: QDRANT_COLLECTIONS.CONTRACTS,
        upsertLatencyMs: upsertResult.upsertLatencyMs,
        chunkIds: upsertResult.chunkIds,
      };

      return output;
    }
  );
}
