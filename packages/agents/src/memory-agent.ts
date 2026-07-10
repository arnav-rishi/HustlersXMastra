/**
 * LexGuard AI — Memory Agent
 * Agent #11 — Persists HITL corrections into Qdrant.
 * Updates risk_patterns + org_preferences collections with org_id scoping.
 * Per PRD Section 9.1 and LG-FUNC-011.
 */

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import { QDRANT_COLLECTIONS, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, SLA } from "@lexguard/shared/constants";
import { getQdrantClient } from "@lexguard/qdrant/client";
import { getEnv } from "@lexguard/shared/env";
import { gpt4oMini } from "./models";

async function embedText(text: string): Promise<number[]> {
  const env = getEnv();
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text, dimensions: EMBEDDING_DIMENSIONS });
  return res.data[0]?.embedding ?? new Array(EMBEDDING_DIMENSIONS).fill(0);
}

const persistRiskPatternTool = createTool({
  id: "persist_risk_pattern",
  description: "Upserts a learned risk pattern into Qdrant risk_patterns collection after HITL rejection.",
  inputSchema: z.object({
    orgId: z.string().uuid(),
    clauseType: z.string(),
    clauseText: z.string(),
    patternDescription: z.string(),
    riskLevel: z.string(),
    rejectionReason: z.string(),
  }),
  outputSchema: z.object({ pointId: z.string().uuid(), collection: z.string(), latencyMs: z.number() }),
  execute: async (input, context) => {
    const start = Date.now();
    const qdrant = getQdrantClient();
    const vector = await embedText(input.clauseText);
    const pointId = uuidv4();
    await qdrant.upsertPoints(QDRANT_COLLECTIONS.RISK_PATTERNS, [{
      id: pointId,
      vector,
      payload: {
        pattern_id: pointId,
        org_id: input.orgId,
        clause_type: input.clauseType,
        pattern_description: input.patternDescription,
        risk_level: input.riskLevel,
        learned_from_hitl: true,
        rejection_count: 1,
        last_updated: new Date().toISOString(),
      },
    }]);
    const latencyMs = Date.now() - start;
    if (latencyMs > SLA.QDRANT_WRITE_MAX_MS) {
      console.warn(`[MemoryAgent] Risk pattern write latency ${latencyMs}ms exceeds SLA ${SLA.QDRANT_WRITE_MAX_MS}ms`);
    }
    return { pointId, collection: QDRANT_COLLECTIONS.RISK_PATTERNS, latencyMs };
  },
});

const persistOrgPreferenceTool = createTool({
  id: "persist_org_preference",
  description: "Upserts an org preference into Qdrant org_preferences after HITL approval/edit.",
  inputSchema: z.object({
    orgId: z.string().uuid(),
    preferenceType: z.string(),
    preferredLanguage: z.string(),
    approvedAlternatives: z.array(z.string()),
    createdBy: z.string().uuid(),
  }),
  outputSchema: z.object({ pointId: z.string().uuid(), collection: z.string(), latencyMs: z.number() }),
  execute: async (input, context) => {
    const start = Date.now();
    const qdrant = getQdrantClient();
    const vector = await embedText(input.preferredLanguage);
    const pointId = uuidv4();
    await qdrant.upsertPoints(QDRANT_COLLECTIONS.ORG_PREFERENCES, [{
      id: pointId,
      vector,
      payload: {
        org_id: input.orgId,
        preference_type: input.preferenceType,
        preferred_language: input.preferredLanguage,
        approved_alternatives: input.approvedAlternatives,
        created_by: input.createdBy,
        updated_at: new Date().toISOString(),
      },
    }]);
    return { pointId, collection: QDRANT_COLLECTIONS.ORG_PREFERENCES, latencyMs: Date.now() - start };
  },
});

export const memoryAgent: Agent = new Agent({
  id: "memory-agent",
  name: "memory-agent",
  instructions: `You are the Memory Agent in LexGuard AI. After every HITL decision:
- REJECT → call persist_risk_pattern to learn this clause as a toxic pattern
- APPROVE/EDIT → call persist_org_preference to record the preferred language
Always use org_id for tenant isolation. Write both collections when both are relevant.`,
  model: gpt4oMini,
  tools: { persist_risk_pattern: persistRiskPatternTool, persist_org_preference: persistOrgPreferenceTool },
});

export interface MemoryAgentInput {
  contractId: string;
  orgId: string;
  userId: string;
  decision: "approve" | "reject" | "edit";
  clauseType: string;
  clauseText: string;
  editedText?: string;
  riskLevel: string;
  riskDescription: string;
}

export interface MemoryAgentOutput {
  riskPatternId?: string;
  orgPreferenceId?: string;
  writeLatencyMs: number;
  collectionsUpdated: string[];
}

export async function executeMemoryAgent(input: MemoryAgentInput): Promise<MemoryAgentOutput> {
  return withSpan(OTEL_SPAN_NAMES.MEMORY_QDRANT_WRITE, {
    "lexguard.org_id": input.orgId, "lexguard.contract_id": input.contractId,
    "lexguard.agent_id": "memory-agent", "hitl.decision": input.decision,
  }, async (span) => {
    const start = Date.now();
    const collectionsUpdated: string[] = [];
    let riskPatternId: string | undefined;
    let orgPreferenceId: string | undefined;

    if (input.decision === "reject") {
      const r = (await persistRiskPatternTool.execute?.({ orgId: input.orgId, clauseType: input.clauseType, clauseText: input.clauseText, patternDescription: input.riskDescription, riskLevel: input.riskLevel, rejectionReason: "Human reviewer rejected this clause pattern" }, {} as any)) as any || {};
      riskPatternId = r.pointId;
      collectionsUpdated.push(QDRANT_COLLECTIONS.RISK_PATTERNS);
    }

    if (input.decision === "approve" || input.decision === "edit") {
      const preferredText = input.editedText ?? input.clauseText;
      const r = (await persistOrgPreferenceTool.execute?.({ orgId: input.orgId, preferenceType: input.clauseType, preferredLanguage: preferredText, approvedAlternatives: input.editedText ? [input.editedText] : [], createdBy: input.userId }, {} as any)) as any || {};
      orgPreferenceId = r.pointId;
      collectionsUpdated.push(QDRANT_COLLECTIONS.ORG_PREFERENCES);
    }

    const writeLatencyMs = Date.now() - start;
    span.setAttribute("memory.collections_updated", collectionsUpdated.join(","));
    span.setAttribute("memory.write_latency_ms", writeLatencyMs);

    if (writeLatencyMs > SLA.HITL_MEMORY_WRITE_MS) {
      console.warn(`[MemoryAgent] Write latency ${writeLatencyMs}ms exceeds HITL SLA ${SLA.HITL_MEMORY_WRITE_MS}ms`);
    }

    return { riskPatternId, orgPreferenceId, writeLatencyMs, collectionsUpdated };
  });
}
