/**
 * LexGuard AI — Benchmark Agent
 *
 * Agent #8 in the 13-agent swarm.
 *
 * Responsibilities:
 * - Compare each classified clause against industry-standard templates
 * - Calculate percentile rank vs. retrieved legal_templates + legal_precedents
 * - Classify clause as: Above Market / Market Standard / Below Market
 * - Produce a delta summary of specific deviations from the norm
 * - Cite the template source for every comparison
 *
 * Per PRD CRISPE Appendix A.3
 * Failure: degrade to global average if tenant data sparse
 *
 * OTel: llm.gpt4o.completion (benchmark)
 * SLA: < 2s per clause (LG-FUNC-005)
 */

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import crypto from "crypto";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import { gpt4o, getAzureOpenAIClient, getChatDeployment } from "./models";
import { recordLlmTokens } from "@lexguard/observability/metrics";
import type { RetrievedItem } from "@lexguard/shared/schemas";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BenchmarkAgentInput {
  contractId: string;
  orgId: string;
  jurisdiction: string;
  clauseIndex: number;
  clauseType: string;
  clauseText: string;
  retrievedTemplates: RetrievedItem[];   // from legal_templates collection
  retrievedPrecedents: RetrievedItem[];  // from legal_precedents collection
}

export interface BenchmarkResult {
  clauseIndex: number;
  clauseType: string;
  percentileRank: number;                      // 0–100
  marketPosition: "Above Market" | "Market Standard" | "Below Market";
  topComparables: Array<{
    source: string;
    similarityScore: number;
    keyDifferences: string;
  }>;
  deltasSummary: string;
  benchmarkLatencyMs: number;
  modelVersion: string;
  promptHash: string;
}

// ─── CRISPE Prompt ────────────────────────────────────────────────────────────

function buildBenchmarkPrompt(params: {
  clauseType: string;
  orgName: string;
  retrievedTemplates: string;
  industrySector: string;
  jurisdiction: string;
  clauseText: string;
}): string {
  return `CONTEXT:
You are benchmarking a ${params.clauseType} clause from ${params.orgName}'s contract
against industry standards. Retrieved comparable clauses:
${params.retrievedTemplates}
Sector: ${params.industrySector}. Jurisdiction: ${params.jurisdiction}.

ROLE:
You are a Legal Market Intelligence Analyst specializing in contract benchmarking for ${params.industrySector} agreements.

INSTRUCTION:
1. Calculate a percentile rank (0-100) for the clause relative to retrieved comparable templates.
2. Identify the 3 most similar templates and explain the key differences.
3. Classify the clause as: Above Market / Market Standard / Below Market.
4. Produce a delta summary: what specific terms deviate from the norm.

SPECIFICS:
- Base percentile on: liability scope, notice periods, duration, mutuality.
- Above Market if percentile > 75 (clause is more favourable to the counterparty).
- Below Market if percentile < 25 (clause is more favourable to our client).
- Cite the template source for every comparison.
- If no comparable templates found, state "Insufficient benchmark data" and use percentile 50.

PERSONALITY:
Analytical, data-driven, objective. Present comparisons as facts, not opinions.

EXPERIMENT:
Step 1: Score each retrieved template on the same risk dimensions as the input clause.
Step 2: Rank the input clause against the distribution.
Step 3: Identify the closest comparable template.
Step 4: Generate the delta summary.

CLAUSE TO BENCHMARK:
${params.clauseText}

Return JSON:
{
  "percentileRank": <0-100>,
  "marketPosition": "Above Market|Market Standard|Below Market",
  "topComparables": [
    {"source": "...", "similarityScore": 0.XX, "keyDifferences": "..."},
    {"source": "...", "similarityScore": 0.XX, "keyDifferences": "..."},
    {"source": "...", "similarityScore": 0.XX, "keyDifferences": "..."}
  ],
  "deltasSummary": "..."
}`;
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

const benchmarkClauseTool = createTool({
  id: "benchmark_clause",
  description: "Benchmarks a clause against industry templates using GPT-4o with CRISPE prompting.",
  inputSchema: z.object({
    clauseType: z.string(),
    clauseIndex: z.number(),
    clauseText: z.string(),
    jurisdiction: z.string(),
    orgId: z.string(),
    retrievedTemplatesContext: z.string(),
    industrySector: z.string().default("Commercial"),
  }),
  outputSchema: z.object({
    percentileRank: z.number(),
    marketPosition: z.enum(["Above Market", "Market Standard", "Below Market"]),
    topComparables: z.array(z.object({
      source: z.string(),
      similarityScore: z.number(),
      keyDifferences: z.string(),
    })),
    deltasSummary: z.string(),
    promptHash: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    latencyMs: z.number(),
  }),
  execute: async (input, context) => {
    const openai = getAzureOpenAIClient();

    const systemPrompt = buildBenchmarkPrompt({
      clauseType: input.clauseType,
      orgName: `Org-${input.orgId.slice(0, 8)}`,
      retrievedTemplates: input.retrievedTemplatesContext || "No comparable templates retrieved.",
      industrySector: input.industrySector,
      jurisdiction: input.jurisdiction,
      clauseText: input.clauseText,
    });

    const promptHash = crypto.createHash("sha256").update(systemPrompt).digest("hex");
    const start = Date.now();
    let result: any = null;
    let inputTokens = 0, outputTokens = 0;

    try {
      const response = await openai.chat.completions.create({
        model: getChatDeployment(),
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Benchmark clause index ${input.clauseIndex}.` },
          ],
        });
        inputTokens = response.usage?.prompt_tokens ?? 0;
        outputTokens = response.usage?.completion_tokens ?? 0;
        result = JSON.parse(response.choices[0]?.message?.content ?? "{}");
        recordLlmTokens(input.orgId, getChatDeployment(), inputTokens, outputTokens);
    } catch {
      // Graceful degradation: return global average
      result = {
        percentileRank: 50,
        marketPosition: "Market Standard",
        topComparables: [],
        deltasSummary: "Benchmark analysis unavailable — insufficient template data or service error.",
      };
    }

    const topComparables = Array.isArray(result.topComparables)
      ? result.topComparables.map((item: any) => ({
          source: item.source ?? "Unknown",
          similarityScore: item.similarityScore ?? 0,
          keyDifferences: item.keyDifferences ?? "",
        }))
      : [];

    return {
      percentileRank: result.percentileRank ?? 50,
      marketPosition: result.marketPosition ?? "Market Standard",
      topComparables,
      deltasSummary: result.deltasSummary ?? "",
      promptHash,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - start,
    };
  },
});

// ─── Agent ────────────────────────────────────────────────────────────────────

export const benchmarkAgent: Agent = new Agent({
  id: "benchmark-agent",
  name: "benchmark-agent",
  instructions: `You are the Benchmark Agent in LexGuard AI. Compare legal clauses against industry templates.
Use benchmark_clause to produce: percentile rank, market position (Above/Standard/Below Market), top 3 comparable templates, delta summary.
If no templates retrieved, return percentile 50 / Market Standard. Always cite template sources.`,
  model: gpt4o,
  tools: { benchmark_clause: benchmarkClauseTool },
});

// ─── Executor ─────────────────────────────────────────────────────────────────

export async function executeBenchmarkAgent(input: BenchmarkAgentInput): Promise<BenchmarkResult> {
  return withSpan(OTEL_SPAN_NAMES.LLM_GPT4O_COMPLETION, {
    "lexguard.org_id": input.orgId,
    "lexguard.contract_id": input.contractId,
    "lexguard.agent_id": "benchmark-agent",
    "clause.type": input.clauseType,
    "clause.index": input.clauseIndex,
  }, async (span) => {
    const templateContext = [
      ...input.retrievedTemplates.map((t) =>
        `[legal_templates | score:${t.score.toFixed(2)}] ${JSON.stringify(t.payload).slice(0, 250)}`
      ),
      ...input.retrievedPrecedents.map((p) =>
        `[legal_precedents | score:${p.score.toFixed(2)}] ${JSON.stringify(p.payload).slice(0, 250)}`
      ),
    ].join("\n");

const r = (await benchmarkClauseTool.execute?.({
      clauseType: input.clauseType,
      clauseIndex: input.clauseIndex,
      clauseText: input.clauseText,
      jurisdiction: input.jurisdiction,
      orgId: input.orgId,
      retrievedTemplatesContext: templateContext,
      industrySector: "Commercial",
    }, {} as any)) as any || {};

    span.setAttribute("benchmark.percentile", r.percentileRank);
    span.setAttribute("benchmark.market_position", r.marketPosition);
    span.setAttribute("llm.prompt_hash_sha256", r.promptHash);
    span.setAttribute("llm.latency_ms", r.latencyMs);

    const safeTopComparables = Array.isArray(r.topComparables)
      ? r.topComparables.map((item: any) => ({
          source: item?.source ?? "Unknown",
          similarityScore: item?.similarityScore ?? 0,
          keyDifferences: item?.keyDifferences ?? "",
        }))
      : [];

    return {
      clauseIndex: input.clauseIndex,
      clauseType: input.clauseType,
      percentileRank: r.percentileRank ?? 50,
      marketPosition: r.marketPosition ?? "Market Standard",
      topComparables: safeTopComparables,
      deltasSummary: r.deltasSummary ?? "",
      benchmarkLatencyMs: r.latencyMs ?? 0,
      modelVersion: getChatDeployment(),
      promptHash: r.promptHash,
    };
  });
}
