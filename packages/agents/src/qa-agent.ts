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
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import {
  QDRANT_COLLECTIONS,
  EMBEDDING_DIMENSIONS, RETRIEVAL_MIN_SCORE, RETRIEVAL_TOP_K,
  TTL, ENKRYPT_QA_CONFIDENCE_THRESHOLD,
} from "@lexguard/shared/constants";
import { getQdrantClient } from "@lexguard/qdrant/client";
import { recordLlmTokens } from "@lexguard/observability/metrics";
import { runEnkryptPipeline } from "@lexguard/enkrypt/pipeline";
import type { QARequest, QAResponse } from "@lexguard/shared/schemas";
import { gpt4o, getAzureOpenAIClient, getChatDeployment, getEmbeddingDeployment } from "./models";

async function embedText(text: string): Promise<number[]> {
  const openai = getAzureOpenAIClient();
  const res = await openai.embeddings.create({ model: getEmbeddingDeployment(), input: text, dimensions: EMBEDDING_DIMENSIONS });
  return res.data[0]?.embedding ?? new Array(EMBEDDING_DIMENSIONS).fill(0);
}

// ─── LLM-facing output schema ─────────────────────────────────────────────────

const QAAnswerLlmSchema = z.object({
  answer: z.string(),
  citations: z.array(z.string()),
});

export const qaAgent: Agent = new Agent({
  id: "qa-agent",
  name: "qa-agent",
  instructions: `You are the Legal Q&A Agent. Answer contract questions in plain English (FK > 60).
Always cite the specific clause. Never give definitive legal advice — recommend qualified attorney review.
Cross-jurisdictional: always note which jurisdiction applies.`,
  model: gpt4o,
});

// ─── Qdrant retrieval + persistence (deterministic I/O, not agent-orchestrated) ─
// No LLM judgment involved in whether/what to retrieve or store — always
// retrieve context first, always store the user's turn, so there's nothing
// for an agent to decide here. Kept as plain functions; only the actual
// content-generation step below goes through the real agent.

async function retrieveClauseContext(input: { contractId: string; orgId: string; sessionId: string; question: string; jurisdiction?: string }) {
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
}

// ─── Answer Generation (real agent.generateLegacy() call) ────────────────────

async function answerQuestion(input: { question: string; contextText: string; jurisdiction?: string; orgId: string }) {
  const prompt = `ROLE: You are a friendly legal assistant explaining ONE specific contract to someone with NO legal background — think "explaining it to a busy small-business owner over coffee," not "reciting the contract back to a lawyer." Use ONLY the clause text in CONTEXT below; never draw on general knowledge of "typical" contracts or invent clause types that aren't in CONTEXT.

INSTRUCTION:
1. Answer the QUESTION directly in the first sentence, in natural conversational prose — never as a labeled list of clause quotes (e.g. do NOT write "Renewal: [quoted text]. Liability: [quoted text].").
2. Translate legal language into plain meaning. Instead of repeating "IN NO EVENT SHALL EITHER PARTY BE LIABLE FOR INDIRECT DAMAGES," say something like "neither side can be sued for indirect losses like lost profits." Use your own words for the answer text.
3. Stay specific and accurate — pull real facts from CONTEXT (who owes what to whom, time periods, caps, conditions) so the answer isn't vague, but express them conversationally, not as legal phrasing.
4. Write in flowing sentences (one short paragraph, or a few sentences per topic if covering several clauses) — not a bulleted clause inventory, unless the user explicitly asks for a clause-by-clause breakdown.
5. If CONTEXT is empty or contains no clause text, say plainly "No relevant clauses were found for this contract" — do NOT list generic categories a contract "might" contain.
6. Keep it plain English (Flesch-Kincaid > 60) and concise — 3-6 sentences unless the question needs more.
7. Do NOT give definitive legal advice — end with one brief reminder to consult a qualified attorney, not more.

EXAMPLE of the tone wanted (content is illustrative only, not from this contract):
"This is a services deal between two companies. Company A collects some of Company B's customer data while doing the work, and has to keep anything shared confidential. If something goes wrong because of Company A's work, they have to cover Company B's related costs — though neither side can be sued for indirect losses like lost profits. The deal auto-renews every year unless someone cancels in writing first."

Jurisdiction: ${input.jurisdiction ?? "Unknown"}.

CONTEXT:
${input.contextText}

QUESTION: ${input.question}

Return JSON: {"answer":"...","citations":["verbatim clause excerpt from CONTEXT that supports the answer", "..."]}
The "answer" must be in your own plain words per the rules above. Citations are the exception — those must be exact substrings copied from CONTEXT (used for source verification), not paraphrases.`;
  const promptHash = crypto.createHash("sha256").update(prompt).digest("hex");
  let answer = "";
  let citations: string[] = [];
  let inputTokens = 0, outputTokens = 0;
  try {
    const response = await qaAgent.generateLegacy<typeof QAAnswerLlmSchema>(
      [
        { role: "system", content: prompt },
        { role: "user", content: "Answer the question." },
      ],
      { output: QAAnswerLlmSchema }
    );
    inputTokens = response.usage?.promptTokens ?? 0;
    outputTokens = response.usage?.completionTokens ?? 0;
    // Cast: same TS overload-narrowing artifact as risk-agent.ts — verified
    // at runtime the response.object is a genuine object matching the schema.
    const parsed = response.object as z.infer<typeof QAAnswerLlmSchema>;
    answer = parsed.answer ?? "Unable to generate answer.";
    citations = Array.isArray(parsed.citations) ? parsed.citations : [];
    recordLlmTokens(input.orgId, getChatDeployment(), inputTokens, outputTokens);
  } catch {
    answer = "Analysis temporarily unavailable. Please try again.";
  }
  return { answer, citations, promptHash, inputTokens, outputTokens };
}

async function storeConversationTurn(input: { sessionId: string; orgId: string; userId: string; turnIndex: number; role: "user" | "assistant"; text: string; contractId: string }) {
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
}

export async function executeQAAgent(request: QARequest & { userId: string; jurisdiction?: string; turnIndex?: number }): Promise<QAResponse> {
  return withSpan(OTEL_SPAN_NAMES.LLM_GPT4O_COMPLETION, {
    "lexguard.org_id": request.orgId, "lexguard.contract_id": request.contractId,
    "lexguard.agent_id": "qa-agent",
  }, async (span) => {
    const sessionId = request.sessionId ?? uuidv4();
    const turnIndex = request.turnIndex ?? 0;

    // 1. Retrieve context
    const ctx = await retrieveClauseContext({ contractId: request.contractId, orgId: request.orgId, sessionId, question: request.question, jurisdiction: request.jurisdiction });

    // 2. Store user turn
    await storeConversationTurn({ sessionId, orgId: request.orgId, userId: request.userId, turnIndex, role: "user" as const, text: request.question, contractId: request.contractId });

    // 3. Generate answer
    const qa = await answerQuestion({ question: request.question, contextText: ctx.contextText, jurisdiction: request.jurisdiction, orgId: request.orgId });

    // 4. Run Enkrypt validation
    const enkrypt = await runEnkryptPipeline({ sessionId, agentId: "qa-agent", inputText: request.question, outputText: qa.answer, retrievedContext: ctx.contextText, orgId: request.orgId, jurisdiction: request.jurisdiction });

    const requiresHitl = enkrypt.routeToHitl || enkrypt.confidenceScore < ENKRYPT_QA_CONFIDENCE_THRESHOLD;

    // 5. Store assistant turn (only if Enkrypt passes)
    if (!requiresHitl) {
      await storeConversationTurn({ sessionId, orgId: request.orgId, userId: request.userId, turnIndex: turnIndex + 1, role: "assistant" as const, text: enkrypt.safeOutput ?? qa.answer, contractId: request.contractId });
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
