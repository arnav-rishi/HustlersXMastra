/**
 * LexGuard AI — Rewrite Agent
 * Agent #7 — Generates 3 safer clause alternatives using GPT-4o-mini + CRISPE
 * Per PRD Appendix A.2
 */

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import crypto from "crypto";
import OpenAI from "openai";
import type { RewriteAgentInput, RewriteAgentOutput, RewriteVersion } from "@lexguard/shared/schemas";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import { LLM_MODELS } from "@lexguard/shared/constants";
import { recordLlmTokens } from "@lexguard/observability/metrics";
import { getEnv } from "@lexguard/shared/env";
import { gpt4oMini } from "./models";

const generateRewritesTool = createTool({
  id: "generate_clause_rewrites",
  description: "Generates 3 safer clause rewrites using GPT-4o-mini with CRISPE + chain-of-thought.",
  inputSchema: z.object({
    clauseType: z.string(),
    clauseIndex: z.number(),
    clauseText: z.string(),
    riskLevel: z.string(),
    riskSummary: z.string(),
    jurisdiction: z.string(),
    orgId: z.string(),
    orgPreferences: z.string(),
  }),
  outputSchema: z.object({
    rewrites: z.array(z.any()),
    promptHash: z.string(),
    modelVersion: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    latencyMs: z.number(),
    fallbackMode: z.boolean(),
  }),
  execute: async (input, context) => {
    const env = getEnv();
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

    const systemPrompt = `ROLE: Expert Legal Draftsman.
  Generate exactly 3 clause rewrites for a ${input.clauseType} flagged as ${input.riskLevel} risk.
  Jurisdiction: ${input.jurisdiction}. Org Preferences: ${input.orgPreferences || "Standard terms"}.
  Risk: ${input.riskSummary}

  RULES: Prefer mutual indemnification. Cap liability at 2x ACV. Add notice periods.
  Chain-of-Thought per rewrite: (1) identify risk language (2) pick strategy (3) draft (4) verify intent (5) confirm org alignment.

  CLAUSE: ${input.clauseText}

  Return JSON: {"rewrites":[{"version":1,"strategy":"...","text":"...","changes":[{"original":"...","revised":"...","reason":"..."}]},{"version":2,...},{"version":3,...}]}`;

    const promptHash = crypto.createHash("sha256").update(systemPrompt).digest("hex");
    const start = Date.now();
    let fallbackMode = false;
    let rewrites: any[] = [];
    let inputTokens = 0, outputTokens = 0;

    try {
      const response = await openai.chat.completions.create({
        model: LLM_MODELS.GPT4O_MINI,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Generate rewrites for clause index ${input.clauseIndex}.` },
          ],
      });
      inputTokens = response.usage?.prompt_tokens ?? 0;
      outputTokens = response.usage?.completion_tokens ?? 0;
      const parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");
      rewrites = Array.isArray(parsed.rewrites) ? parsed.rewrites : [];
      if (rewrites.length < 3) fallbackMode = true;
    } catch {
      fallbackMode = true;
      rewrites = [{
        version: 1, strategy: "Conservative Cap",
        text: `${input.clauseText.slice(0, 200)} [LIABILITY CAPPED AT 2x ACV — manual review required]`,
        changes: [{ original: "original", revised: "capped version", reason: "Risk mitigation — fallback" }],
      }];
    }

    const latencyMs = Date.now() - start;
    recordLlmTokens(input.orgId, LLM_MODELS.GPT4O_MINI, inputTokens, outputTokens);
    return { rewrites: rewrites.map((r: any, i: number) => ({ ...r, version: r.version ?? i + 1, enkryptValidated: false })), promptHash, modelVersion: LLM_MODELS.GPT4O_MINI, inputTokens, outputTokens, latencyMs, fallbackMode };
  },
});

export const rewriteAgent: Agent = new Agent({
  id: "rewrite-agent",
  name: "rewrite-agent",
  instructions: "Generate exactly 3 legally-sound clause rewrites using generate_clause_rewrites. Prefer mutual indemnification. Cap liability at 2x ACV. Add notice periods. Chain-of-thought per rewrite is mandatory.",
  model: gpt4oMini,
  tools: { generate_clause_rewrites: generateRewritesTool },
});

export async function executeRewriteAgent(input: RewriteAgentInput): Promise<RewriteAgentOutput> {
  return withSpan(OTEL_SPAN_NAMES.LLM_GPT4O_MINI_COMPLETION, {
    "lexguard.org_id": input.orgId, "lexguard.contract_id": input.contractId,
    "lexguard.agent_id": "rewrite-agent", "llm.model": LLM_MODELS.GPT4O_MINI,
  }, async (span) => {
    const orgPreferences = input.orgPreferences.map((p) => JSON.stringify(p.payload).slice(0, 150)).join("\n");
    const riskSummary = input.riskReport.risks.map((r: any) => `${r.severity}: ${r.description}`).join("; ");

    const result = (await generateRewritesTool.execute?.({
      clauseType: input.clause.clauseType ?? "unknown",
      clauseIndex: input.clause.clauseIndex,
      clauseText: input.clause.clauseText,
      riskLevel: input.riskReport.overallRisk,
      riskSummary,
      jurisdiction: input.jurisdiction,
      orgId: input.orgId,
      orgPreferences,
    }, {} as any)) as any || {};

    span.setAttribute("llm.prompt_hash_sha256", result.promptHash);
    span.setAttribute("llm.input_tokens", result.inputTokens);
    span.setAttribute("llm.output_tokens", result.outputTokens);
    span.setAttribute("llm.latency_ms", result.latencyMs);
    span.setAttribute("rewrite.fallback_mode", result.fallbackMode);

    return { clauseIndex: input.clause.clauseIndex, rewrites: result.rewrites as RewriteVersion[] ?? [], rewriteLatencyMs: result.latencyMs ?? 0, modelVersion: result.modelVersion, promptHash: result.promptHash };
  });
}
