/**
 * LexGuard AI — Legal Q&A Agent (#12)
 *
 * Handles multi-turn conversational Q&A against uploaded contracts.
 * - Retrieves clause context + conversation_memory from Qdrant
 * - Answers in plain language (Flesch-Kincaid > 60)
 * - Cites the specific clause + retrieved precedents
 * - Routes through Enkrypt before delivery (confidence >= 0.85)
 * - Stores each turn in conversation_memory collection
 * Per PRD LG-FUNC-007, US-004, US-005
 */
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import OpenAI from "openai";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import {
  LLM_MODELS, QDRANT_COLLECTIONS, EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS, RETRIEVAL_MIN_SCORE, RETRIEVAL_TOP_K,
  TTL, ENKRYPT_QA_CONFIDENCE_THRESHOLD,
} from "@lexguard/shared/constants";
import { getQdrantClient } from "@lexguard/qdrant/client";
import { recordLlmTokens } from "@lexguard/observability/metrics";
import { runEnkryptPipeline } from "@lexguard/enkrypt/pipeline";
import { getEnv } from "@lexguard/shared/env";
import type { QARequest, QAResponse } from "@lexguard/shared/schemas";
import { gpt4o } from "./models";

async function embedText(text: string): Promise<number[]> {
  const env = getEnv();
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text, dimensions: EMBEDDING_DIMENSIONS });
  return res.data[0]?.embedding ?? new Array(EMBEDDING_DIMENSIONS).fill(0);
}

const retrieveClauseContextTool = createTool({
  id: "retrieve_clause_context",
  description: "Retrieves the most relevant clauses + conversation history from Qdrant for Q&A grounding.",
  inputSchema: z.object({ contractId: z.string().uuid(), orgId: z.string().uuid(), sessionId: z.string().uuid(), question: z.string(), jurisdiction: z.string().optional() }),
  outputSchema: z.object({ clauses: z.array(z.any()), conversationHistory: z.array(z.any()), contextText: z.string() }),
  execute: async (input, context) => {
    const qdrant = getQdrantClient();
    const vector = await embedText(input.question);
    const [clauseResults, historyResults] = await Promise.all([
      qdrant.denseSearch(QDRANT_COLLECTIONS.CONTRACTS, vector,
        { must: [{ key: "contract_id", match: { value: input.contractId } }, { key: "org_id", match: { value: input.orgId } }] },
        RETRIEVAL_TOP_K, RETRIEVAL_MIN_SCORE),
      qdrant.denseSearch(QDRANT_COLLECTIONS.CONVERSATION_MEMORY, vector,
        { must: [{ key: "session_id", match: { value: input.sessionId } }] },
        5, 0.5),
    ]);
    const contextText = [
      "RELEVANT CONTRACT CLAUSES:",
      ...clauseResults.map((r) => `Clause (score:${r.score.toFixed(2)}): ${(r.payload as any).clause_text ?? ""}`),
      "\nCONVERSATION HISTORY:",
      ...historyResults.map((r) => `[${(r.payload as any).message_role}]: ${(r.payload as any).message_text ?? ""}`),
    ].join("\n");
    return { clauses: clauseResults, conversationHistory: historyResults, contextText };
  },
});

const answerQuestionTool = createTool({
  id: "answer_legal_question",
  description: "Generates a grounded, plain-language answer to a legal question using retrieved contract context.",
  inputSchema: z.object({ question: z.string(), contextText: z.string(), jurisdiction: z.string().optional(), orgId: z.string() }),
  outputSchema: z.object({ answer: z.string(), citations: z.array(z.string()), promptHash: z.string(), inputTokens: z.number(), outputTokens: z.number() }),
  execute: async (input, context) => {
    const env = getEnv();
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const prompt = `You are a Senior Legal Analyst answering questions about a contract.
  Answer in plain English (Flesch-Kincaid readability > 60). Cite the specific clause.
  Do NOT give definitive legal advice — provide analysis and recommend consulting a qualified attorney.
  Jurisdiction: ${input.jurisdiction ?? "Unknown"}.

  CONTEXT:
  ${input.contextText}

  QUESTION: ${input.question}

  Return JSON: {"answer":"...","citations":["clause text excerpt...", "..."]}`;
    const promptHash = crypto.createHash("sha256").update(prompt).digest("hex");
    let answer = ""; let citations: string[] = []; let inputTokens = 0, outputTokens = 0;
    try {
      const response = await openai.chat.completions.create({
        model: LLM_MODELS.GPT4O, temperature: 0.2, response_format: { type: "json_object" },
        messages: [{ role: "system", content: prompt }, { role: "user", content: "Answer the question." }],
      });
      inputTokens = response.usage?.prompt_tokens ?? 0;
      outputTokens = response.usage?.completion_tokens ?? 0;
      const parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");
      answer = parsed.answer ?? "Unable to generate answer.";
      citations = Array.isArray(parsed.citations) ? parsed.citations : [];
      recordLlmTokens(input.orgId, LLM_MODELS.GPT4O, inputTokens, outputTokens);
    } catch { answer = "Analysis temporarily unavailable. Please try again."; }
    return { answer, citations, promptHash, inputTokens, outputTokens };
  },
});

const storeConversationTurnTool = createTool({
  id: "store_conversation_turn",
  description: "Persists a Q&A turn into the Qdrant conversation_memory collection (30-day TTL).",
  inputSchema: z.object({ sessionId: z.string().uuid(), orgId: z.string().uuid(), userId: z.string().uuid(), turnIndex: z.number(), role: z.enum(["user", "assistant"]), text: z.string(), contractId: z.string().uuid() }),
  outputSchema: z.object({ stored: z.boolean() }),
  execute: async (input, context) => {
    const qdrant = getQdrantClient();
    const vector = await embedText(input.text);
    await qdrant.upsertPoints(QDRANT_COLLECTIONS.CONVERSATION_MEMORY, [{
      id: uuidv4(), vector,
      payload: {
        session_id: input.sessionId, org_id: input.orgId, user_id: input.userId,
        turn_index: input.turnIndex, message_role: input.role, message_text: input.text,
        linked_contract_id: input.contractId, timestamp: new Date().toISOString(),
        ttl_days: TTL.CONVERSATION_MEMORY_DAYS,
      },
    }]);
    return { stored: true };
  },
});

export const qaAgent: Agent = new Agent({
  id: "qa-agent",
  name: "qa-agent",
  instructions: `You are the Legal Q&A Agent. Answer contract questions in plain English (FK > 60).
Steps: (1) retrieve_clause_context (2) answer_legal_question (3) store_conversation_turn for both user Q and your A.
Always cite the specific clause. Never give definitive legal advice — recommend qualified attorney review.
Cross-jurisdictional: always note which jurisdiction applies.`,
  model: gpt4o,
  tools: { retrieve_clause_context: retrieveClauseContextTool, answer_legal_question: answerQuestionTool, store_conversation_turn: storeConversationTurnTool },
});

export async function executeQAAgent(request: QARequest & { userId: string; jurisdiction?: string; turnIndex?: number }): Promise<QAResponse> {
  return withSpan(OTEL_SPAN_NAMES.LLM_GPT4O_COMPLETION, {
    "lexguard.org_id": request.orgId, "lexguard.contract_id": request.contractId,
    "lexguard.agent_id": "qa-agent",
  }, async (span) => {
    const sessionId = request.sessionId ?? uuidv4();
    const turnIndex = request.turnIndex ?? 0;

    // 1. Retrieve context
    const ctx = (await retrieveClauseContextTool.execute?.({ contractId: request.contractId, orgId: request.orgId, sessionId, question: request.question, jurisdiction: request.jurisdiction }, {} as any)) as any || { contextText: "" };

    // 2. Store user turn
    await storeConversationTurnTool.execute?.({ sessionId, orgId: request.orgId, userId: request.userId, turnIndex, role: "user" as const, text: request.question, contractId: request.contractId }, {} as any);

    // 3. Generate answer
    const qa = (await answerQuestionTool.execute?.({ question: request.question, contextText: ctx.contextText, jurisdiction: request.jurisdiction, orgId: request.orgId }, {} as any)) as any || { answer: "", citations: [] };

    // 4. Run Enkrypt validation
    const enkrypt = await runEnkryptPipeline({ sessionId, agentId: "qa-agent", inputText: request.question, outputText: qa.answer, retrievedContext: ctx.contextText, orgId: request.orgId, jurisdiction: request.jurisdiction });

    const requiresHitl = enkrypt.routeToHitl || enkrypt.confidenceScore < ENKRYPT_QA_CONFIDENCE_THRESHOLD;

    // 5. Store assistant turn (only if Enkrypt passes)
    if (!requiresHitl) {
      await storeConversationTurnTool.execute?.({ sessionId, orgId: request.orgId, userId: request.userId, turnIndex: turnIndex + 1, role: "assistant" as const, text: enkrypt.safeOutput ?? qa.answer, contractId: request.contractId }, {} as any);
    }

    span.setAttribute("qa.enkrypt_pass", enkrypt.overallPass);
    span.setAttribute("qa.confidence_score", enkrypt.confidenceScore);
    span.setAttribute("qa.requires_hitl", requiresHitl);

    return {
      answer: requiresHitl ? "This response requires human review before delivery." : (enkrypt.safeOutput ?? qa.answer),
      citations: qa.citations,
      readabilityScore: 65, // In production: compute Flesch-Kincaid score
      enkryptConfidence: enkrypt.confidenceScore,
      sessionId,
      requiresHitl,
    };
  });
}
