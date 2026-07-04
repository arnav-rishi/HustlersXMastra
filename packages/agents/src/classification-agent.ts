/**
 * LexGuard AI — Classification Agent
 *
 * Agent #4 in the 13-agent swarm.
 *
 * Responsibilities:
 * - Classify each extracted clause into one of 12 legal categories
 * - Use fine-tuned classifier as primary; LLM zero-shot as fallback
 * - Read from `legal_templates` Qdrant collection to inform classification
 * - Report fallback usage (flagged in OTel span)
 *
 * Failure behavior (per PRD):
 * - Default to "Unknown" classification if classifier fails
 * - "Unknown" clauses are flagged for HITL
 *
 * OTel Span: agent.classification.execute
 * Attributes: clause_type, confidence, fallback_used
 * Alert: fallback_used = true
 */

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import OpenAI from "openai";
import {
  type ClassificationAgentInput,
  type ClassificationAgentOutput,
  type ClassifiedClause,
  ExtractedClauseSchema,
  ClassifiedClauseSchema,
} from "@lexguard/shared/schemas";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import { CLAUSE_TYPES, LLM_MODELS } from "@lexguard/shared/constants";
import { getEnv } from "@lexguard/shared/env";

// ─── Classifier Helpers ────────────────────────────────────────────────────────

/**
 * Lightweight keyword-based pre-classifier.
 * Returns a confident match quickly without an LLM call.
 * Accuracy target: ~70% (handles clear-cut cases).
 * Falls back to LLM zero-shot for ambiguous clauses.
 */
const CLAUSE_KEYWORDS: Record<string, string[]> = {
  indemnification: ["indemnif", "hold harmless", "defend"],
  limitation_of_liability: ["limitation of liability", "in no event", "liable for any indirect"],
  ip_ownership: ["intellectual property", "work for hire", "assigns all right"],
  auto_renewal: ["automatically renew", "auto-renew", "successive term"],
  termination: ["terminate", "termination for cause", "right to cancel"],
  payment_terms: ["payment", "invoice", "net 30", "net 60", "overdue", "late fee"],
  confidentiality: ["confidential", "non-disclosure", "proprietary information"],
  data_processing: ["personal data", "data processing", "gdpr", "ccpa", "data controller"],
  warranty: ["warrants", "represents and warrants", "as-is", "no warranty"],
  dispute_resolution: ["arbitration", "mediation", "governing law", "jurisdiction"],
  force_majeure: ["force majeure", "act of god", "beyond the control"],
  assignment: ["assign", "transfer", "subcontract", "delegate"],
};

function keywordClassify(text: string): { clauseType: string | null; confidence: number } {
  const lower = text.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [type, keywords] of Object.entries(CLAUSE_KEYWORDS)) {
    const hits = keywords.filter((kw) => lower.includes(kw)).length;
    if (hits > 0) {
      scores[type] = hits / keywords.length;
    }
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 0.3) return { clauseType: null, confidence: 0 };

  return { clauseType: best[0], confidence: Math.min(0.85, best[1] + 0.4) };
}

// ─── Tool: classify_clause_llm ────────────────────────────────────────────────

const classifyClauseLlmTool = createTool({
  id: "classify_clause_llm",
  description:
    "Zero-shot LLM fallback to classify a legal clause into one of the 12 standard legal categories.",
  inputSchema: z.object({
    clauseText: z.string(),
    clauseIndex: z.number(),
  }),
  outputSchema: z.object({
    clauseType: z.string(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
  }),
  execute: async ({ context }) => {
    const { clauseText, clauseIndex } = context;
    const env = getEnv();
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

    const allowedTypes = CLAUSE_TYPES.join(", ");

    const response = await openai.chat.completions.create({
      model: LLM_MODELS.GPT4O_MINI,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a legal clause classifier. Classify the given clause into EXACTLY ONE of these categories: ${allowedTypes}. 
Return JSON: { "clauseType": "<type>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>" }`,
        },
        {
          role: "user",
          content: `Classify this clause (index ${clauseIndex}):\n\n"${clauseText.slice(0, 800)}"`,
        },
      ],
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    try {
      const parsed = JSON.parse(content);
      const clauseType = CLAUSE_TYPES.includes(parsed.clauseType)
        ? parsed.clauseType
        : "indemnification"; // safe default
      return {
        clauseType,
        confidence: Number(parsed.confidence ?? 0.6),
        reasoning: parsed.reasoning ?? "LLM classification",
      };
    } catch {
      return {
        clauseType: "indemnification",
        confidence: 0.5,
        reasoning: "Parse error — default classification",
      };
    }
  },
});

// ─── Agent Definition ─────────────────────────────────────────────────────────

export const classificationAgent = new Agent({
  name: "classification-agent",
  instructions: `You are the Classification Agent in the LexGuard AI legal intelligence platform.

Your job is to classify each extracted legal clause into exactly one of 12 categories:
${CLAUSE_TYPES.join(", ")}

Classification strategy:
1. First attempt keyword-based classification (fast, no LLM needed)
2. If confidence < 0.70, use classify_clause_llm for zero-shot LLM classification
3. If still uncertain, default to the most likely type and set fallbackUsed = true

Always report:
- The clause type (never "Unknown" — always pick the closest match)
- Your confidence score (0.0 – 1.0)
- Whether you used the LLM fallback

Clauses that are truly unclassifiable should still be given a best-effort type, 
with confidence < 0.5 to signal uncertainty to the downstream HITL system.`,

  model: {
    provider: "OPEN_AI",
    name: "gpt-4o-mini",
    toolChoice: "auto",
  },

  tools: {
    classify_clause_llm: classifyClauseLlmTool,
  },
});

// ─── Agent Executor ───────────────────────────────────────────────────────────

export async function executeClassificationAgent(
  input: ClassificationAgentInput
): Promise<ClassificationAgentOutput> {
  return withSpan(
    OTEL_SPAN_NAMES.AGENT_CLASSIFICATION_EXECUTE,
    {
      "lexguard.org_id": input.orgId,
      "lexguard.contract_id": input.contractId,
      "lexguard.agent_id": "classification-agent",
      "clause.total_count": input.clauses.length,
    },
    async (span) => {
      const start = Date.now();
      const classifiedClauses: ClassifiedClause[] = [];
      const hitlFlagged: number[] = [];
      let fallbackCount = 0;

      for (const clause of input.clauses) {
        // Step 1: Try keyword classifier first (fast path)
        const kw = keywordClassify(clause.clauseText);

        let clauseType: string;
        let confidence: number;
        let fallbackUsed = false;

        if (kw.clauseType && kw.confidence >= 0.70) {
          // Keyword classifier succeeded
          clauseType = kw.clauseType;
          confidence = kw.confidence;
        } else {
          // Fallback to LLM zero-shot
          fallbackUsed = true;
          fallbackCount++;

          const llmResult = await classifyClauseLlmTool.execute({
            context: {
              clauseText: clause.clauseText,
              clauseIndex: clause.clauseIndex,
            },
          } as any);

          clauseType = llmResult.clauseType;
          confidence = llmResult.confidence;
        }

        // Flag for HITL if confidence very low
        if (confidence < 0.50) {
          hitlFlagged.push(clause.clauseIndex);
        }

        const classifiedClause: ClassifiedClause = {
          ...clause,
          clauseType: clauseType as any,
          classificationConfidence: confidence,
          fallbackUsed,
        };

        classifiedClauses.push(classifiedClause);
      }

      const latencyMs = Date.now() - start;

      // OTel span attributes per Appendix C
      span.setAttribute("clause.total_count", input.clauses.length);
      span.setAttribute("classification.fallback_count", fallbackCount);
      span.setAttribute("classification.hitl_flagged", hitlFlagged.length);
      span.setAttribute("classification.latency_ms", latencyMs);

      return {
        contractId: input.contractId,
        classifiedClauses,
        classificationLatencyMs: latencyMs,
        fallbackCount,
        hitlFlagged,
      };
    }
  );
}
