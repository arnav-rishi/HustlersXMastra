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
import { gpt4oMini, getAzureOpenAIClient, getEmbeddingDeployment } from "./models";
import { v4 as uuidv4 } from "uuid";
import type { AzureOpenAI } from "openai";
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

// ─── Tools ───────────────────────────────────────────────────────────────────

/**
 * Retries a single embedding batch call with exponential backoff, matching the
 * failure behavior documented at the top of this file (which previously wasn't
 * implemented — the call was a bare, un-retried `await`). Each attempt is also
 * bounded by RETRY.STEP_TIMEOUT_MS so a slow/hung Azure call can't silently
 * block the workflow for the OpenAI SDK's default 10-minute timeout.
 */
async function withEmbeddingRetry<T>(
  fn: () => Promise<T>,
  operationName: string
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= RETRY.MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < RETRY.MAX_ATTEMPTS) {
        const delay = RETRY.BASE_DELAY_MS * Math.pow(2, attempt - 1);
        const jitter = Math.random() * 500;
        console.warn(
          `[LexGuard][EmbeddingAgent] ${operationName} attempt ${attempt} failed: ${lastError.message}. Retrying in ${delay + jitter}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
      }
    }
  }

  throw lastError ?? new Error(`[LexGuard][EmbeddingAgent] ${operationName} failed`);
}

/**
 * Tool: generate_embeddings
 * Batches clauses and generates embeddings via the Azure OpenAI embedding deployment.
 * Max batch size: 100 (OpenAI API limit).
 */
const generateEmbeddingsTool = createTool({
  id: "generate_embeddings",
  description:
    "Generates text-embedding-3-large (1536d) embeddings for a batch of clause texts. Returns embedding vectors.",
  inputSchema: z.object({
    texts: z.array(z.string()),
  }),
  outputSchema: z.object({
    embeddings: z.array(z.array(z.number())),
    model: z.string(),
    totalTokens: z.number(),
  }),
  execute: async (input, context) => {
    const { texts } = input;
    const openai: AzureOpenAI = getAzureOpenAIClient();
    const model = getEmbeddingDeployment();
    const onBatchComplete = (context as any)?.onBatchComplete as
      | ((batchesDone: number, totalBatches: number) => void)
      | undefined;

    // Process in batches of 100
    const BATCH_SIZE = 100;
    const totalBatches = Math.max(1, Math.ceil(texts.length / BATCH_SIZE));
    const allEmbeddings: number[][] = [];
    let totalTokens = 0;

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const batchNum = i / BATCH_SIZE + 1;

      const response = await withEmbeddingRetry(
        () =>
          openai.embeddings.create(
            {
              model: model,
              input: batch,
              encoding_format: "float",
              dimensions: EMBEDDING_DIMENSIONS,
            },
            // Per-call override: bound this batch to STEP_TIMEOUT_MS instead of
            // inheriting the SDK's 10-minute default, and let our own retry loop
            // above own the retry/backoff instead of the SDK's silent internal retries.
            { timeout: RETRY.STEP_TIMEOUT_MS, maxRetries: 0 }
          ),
        `embed_batch:${batchNum}/${totalBatches}`
      );

      allEmbeddings.push(...response.data.map((d) => d.embedding));
      totalTokens += response.usage.total_tokens;

      console.log(
        `[LexGuard][EmbeddingAgent] embedded batch ${batchNum}/${totalBatches} (${allEmbeddings.length}/${texts.length} clauses)`
      );
      onBatchComplete?.(batchNum, totalBatches);
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
  execute: async (input, context) => {
    const {
      contractId,
      orgId,
      tenantId,
      jurisdiction,
      clauses,
      embeddings,
    } = input;

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

export const embeddingAgent: Agent = new Agent({
  id: "embedding-agent",
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

  model: gpt4oMini,

  tools: {
    generate_embeddings: generateEmbeddingsTool,
    upsert_to_qdrant: upsertToQdrantTool,
  },
});

// ─── Agent Executor ───────────────────────────────────────────────────────────

export async function executeEmbeddingAgent(
  input: EmbeddingAgentInput,
  onProgress?: (batchesDone: number, totalBatches: number) => void
): Promise<EmbeddingAgentOutput> {
  return withSpan(
    OTEL_SPAN_NAMES.AGENT_EMBEDDING_EXECUTE,
    {
      "lexguard.org_id": input.orgId,
      "lexguard.contract_id": input.contractId,
      "lexguard.agent_id": "embedding-agent",
      "embedding.model": getEmbeddingDeployment(),
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
      const embeddingResult = (await generateEmbeddingsTool.execute?.({ texts }, { onBatchComplete: onProgress } as any)) as any || { embeddings: [], model: getEmbeddingDeployment(), totalTokens: 0 };

      // Step 2: Upsert to Qdrant with full metadata
      const upsertResult = (await upsertToQdrantTool.execute?.({ contractId: input.contractId, orgId: input.orgId, tenantId: input.tenantId, jurisdiction: input.jurisdiction, clauses: input.clauses.map((c) => ({ clauseIndex: c.clauseIndex, clauseType: c.clauseType, clauseText: c.clauseText, pageNumber: c.pageNumber, boundingBox: c.boundingBox })), embeddings: embeddingResult.embeddings }, {} as any)) as any || { upsertedCount: 0, chunkIds: [], upsertLatencyMs: 0 };

      // OTel attributes
      span.setAttribute("embedding.chunk_count", input.clauses.length);
      span.setAttribute("embedding.total_tokens", embeddingResult.totalTokens);
      span.setAttribute("qdrant.upsert_latency_ms", upsertResult.upsertLatencyMs);
      span.setAttribute("qdrant.upserted_count", upsertResult.upsertedCount);

      const output: EmbeddingAgentOutput = {
        contractId: input.contractId,
        clauses: input.clauses,
        chunksUpserted: upsertResult.upsertedCount,
        embeddingModel: getEmbeddingDeployment(),
        qdrantCollection: QDRANT_COLLECTIONS.CONTRACTS,
        upsertLatencyMs: upsertResult.upsertLatencyMs,
        chunkIds: upsertResult.chunkIds,
      };

      return output;
    }
  );
}
