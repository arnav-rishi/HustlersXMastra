/**
 * LexGuard AI — Risk Analysis Agent
 *
 * Agent #6 in the 13-agent swarm. The core intelligence engine.
 *
 * Responsibilities:
 * - Identify legal and financial risks in each classified clause
 * - Assign severity: Critical / Moderate / Low
 * - Produce evidence citations from retrieved context
 * - Use CRISPE-structured system prompt (per PRD Appendix A.1)
 * - Chain-of-thought reasoning (4 mandatory steps before output)
 * - Output valid RiskReport JSON
 *
 * Failure behavior (per PRD):
 * - Return partial results with hasUncertainty = true on LLM failure
 * - Never fabricate citations — use "Unverified" if uncertain
 *
 * OTel Span: llm.gpt4o.completion
 * Attributes: model_version, prompt_hash_sha256, input_tokens, output_tokens, latency_ms
 * Alert: latency_ms > 10000
 */

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import crypto from "crypto";
import OpenAI from "openai";
import {
  type RiskAgentInput,
  type RiskAgentOutput,
  type RiskReport,
  RiskReportSchema,
} from "@lexguard/shared/schemas";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import {
  LLM_MODELS,
  RISK_SEVERITY,
} from "@lexguard/shared/constants";
import { recordLlmTokens } from "@lexguard/observability/metrics";
import { getEnv } from "@lexguard/shared/env";

// ─── CRISPE Prompt Builder ────────────────────────────────────────────────────
// Per PRD Appendix A.1 — Risk Analysis Agent system prompt

function buildRiskAnalysisPrompt(params: {
  clauseType: string;
  jurisdiction: string;
  orgName: string;
  retrievedRisks: string;
  benchmarkSummary: string;
  industrySector: string;
  clauseText: string;
}): string {
  return `CONTEXT:
You are analyzing a ${params.clauseType} clause from a commercial contract.
The contract is governed by ${params.jurisdiction} law and was uploaded by ${params.orgName}.
Retrieved risk patterns from this organization's legal history:
${params.retrievedRisks}

Industry benchmark for this clause type:
${params.benchmarkSummary}

ROLE:
You are a Senior Commercial Counsel with 15 years of experience in contract risk mitigation,
specializing in ${params.industrySector} sector agreements.

INSTRUCTION:
1. Identify all legal and financial risks in the clause below.
2. Compare each risk against the retrieved risk patterns and benchmark.
3. Assign a severity level: Critical, Moderate, or Low.
4. For each risk, cite the specific clause language that creates it.
5. Explain the potential financial or legal consequence in plain terms.

SPECIFICS:
- Flag any liability cap exceeding 1x contract value as Critical.
- Flag any unilateral termination right without notice as Critical.
- Flag auto-renewal clauses without 30-day opt-out notice as Moderate.
- Only cite risks that can be grounded in the retrieved context.
- Do not fabricate legal citations. If uncertain, state "Unverified."
- Output must be valid JSON matching the RiskReport schema exactly.

PERSONALITY:
Precise, non-alarmist, citation-grounded. Do not catastrophize.
Present facts clearly. Use active voice.

EXPERIMENT:
Before outputting the final risk assessment, reason step-by-step:
Step 1: What is the legal purpose of this clause?
Step 2: What could go wrong for our client under this clause?
Step 3: How does this compare to the retrieved precedents?
Step 4: What is the worst-case financial exposure?
Then produce the structured output.

CLAUSE TO ANALYZE:
${params.clauseText}

OUTPUT FORMAT (strict JSON):
{
  "clauseType": "${params.clauseType}",
  "clauseIndex": <number>,
  "risks": [
    {
      "severity": "Critical|Moderate|Low",
      "description": "...",
      "triggeringLanguage": "exact quoted text from clause",
      "financialExposure": "...",
      "benchmarkDeviation": "...",
      "orgPreferenceConflict": "...",
      "citation": "source: collection_name, score: 0.XX"
    }
  ],
  "overallRisk": "Critical|Moderate|Low",
  "chainOfThought": "Step 1: ... Step 2: ... Step 3: ... Step 4: ..."
}`;
}

// ─── Tool: analyze_clause_risk ────────────────────────────────────────────────

const analyzeClauseRiskTool = createTool({
  id: "analyze_clause_risk",
  description:
    "Analyzes a classified legal clause for legal and financial risks using GPT-4o with CRISPE prompting.",
  inputSchema: z.object({
    clauseType: z.string(),
    clauseIndex: z.number(),
    clauseText: z.string(),
    jurisdiction: z.string(),
    orgId: z.string(),
    retrievedContext: z.string(),
    benchmarkContext: z.string(),
  }),
  outputSchema: z.object({
    riskReport: z.any(),
    promptHash: z.string(),
    modelVersion: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    latencyMs: z.number(),
    hasUncertainty: z.boolean(),
  }),
  execute: async ({ context }) => {
    const env = getEnv();
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

    const systemPrompt = buildRiskAnalysisPrompt({
      clauseType: context.clauseType,
      jurisdiction: context.jurisdiction,
      orgName: `Org-${context.orgId.slice(0, 8)}`,
      retrievedRisks: context.retrievedContext,
      benchmarkSummary: context.benchmarkContext || "No benchmark data available",
      industrySector: "Commercial",
      clauseText: context.clauseText,
    });

    // SHA-256 hash of prompt for audit log (per PRD LG-COMP-002)
    const promptHash = crypto
      .createHash("sha256")
      .update(systemPrompt)
      .digest("hex");

    const start = Date.now();

    let hasUncertainty = false;
    let riskReport: any = null;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const response = await openai.chat.completions.create({
        model: LLM_MODELS.GPT4O,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Analyze the clause above (clauseIndex: ${context.clauseIndex}) and return the risk report JSON.`,
          },
        ],
      });

      inputTokens = response.usage?.prompt_tokens ?? 0;
      outputTokens = response.usage?.completion_tokens ?? 0;

      const content = response.choices[0]?.message?.content ?? "{}";
      riskReport = JSON.parse(content);
      riskReport.clauseIndex = context.clauseIndex;
      riskReport.promptHash = promptHash;
      riskReport.modelVersion = LLM_MODELS.GPT4O;

    } catch (err) {
      hasUncertainty = true;
      // Return safe partial result on failure (per PRD failure behavior)
      riskReport = {
        clauseType: context.clauseType,
        clauseIndex: context.clauseIndex,
        risks: [{
          severity: RISK_SEVERITY.MODERATE,
          description: "Risk analysis incomplete — LLM service error",
          triggeringLanguage: context.clauseText.slice(0, 100),
          financialExposure: "Unknown — manual review required",
          citation: "Unverified",
        }],
        overallRisk: RISK_SEVERITY.MODERATE,
        chainOfThought: "Analysis incomplete due to service error.",
        promptHash,
        modelVersion: LLM_MODELS.GPT4O,
      };
    }

    const latencyMs = Date.now() - start;

    // Record LLM token usage for cost tracking
    recordLlmTokens(context.orgId, LLM_MODELS.GPT4O, inputTokens, outputTokens);

    return {
      riskReport,
      promptHash,
      modelVersion: LLM_MODELS.GPT4O,
      inputTokens,
      outputTokens,
      latencyMs,
      hasUncertainty,
    };
  },
});

// ─── Agent Definition ─────────────────────────────────────────────────────────

export const riskAgent = new Agent({
  name: "risk-analysis-agent",
  instructions: `You are the Risk Analysis Agent in the LexGuard AI legal intelligence platform.

Your role is to act as a Senior Commercial Counsel analyzing legal clauses for risk.

For each clause:
1. Use analyze_clause_risk to get a structured risk assessment
2. Ensure the output contains: severity, triggering language, financial exposure, citation
3. Never invent citations — use "Unverified" if unsupported by retrieved context
4. CRITICAL clauses must have explicit financial exposure estimates
5. Return the complete RiskReport JSON

The 4-step chain-of-thought reasoning is MANDATORY before producing output.`,

  model: {
    provider: "OPEN_AI",
    name: "gpt-4o",
    toolChoice: "required",
  },

  tools: {
    analyze_clause_risk: analyzeClauseRiskTool,
  },
});

// ─── Agent Executor ───────────────────────────────────────────────────────────

export async function executeRiskAgent(
  input: RiskAgentInput
): Promise<RiskAgentOutput> {
  return withSpan(
    OTEL_SPAN_NAMES.LLM_GPT4O_COMPLETION,
    {
      "lexguard.org_id": input.orgId,
      "lexguard.contract_id": input.contractId,
      "lexguard.agent_id": "risk-analysis-agent",
      "llm.model": LLM_MODELS.GPT4O,
      "clause.type": input.clause.clauseType ?? "unknown",
      "clause.index": input.clause.clauseIndex,
    },
    async (span) => {
      const start = Date.now();

      // Build context strings from retrieved items
      const retrievedContext = input.retrievedContext.retrievedItems
        .map((item) => `[${item.collection}] score:${item.score.toFixed(2)} — ${JSON.stringify(item.payload).slice(0, 300)}`)
        .join("\n");

      const result = await analyzeClauseRiskTool.execute({
        context: {
          clauseType: input.clause.clauseType ?? "unknown",
          clauseIndex: input.clause.clauseIndex,
          clauseText: input.clause.clauseText,
          jurisdiction: input.jurisdiction,
          orgId: input.orgId,
          retrievedContext,
          benchmarkContext: "",
        },
      } as any);

      const riskReport: RiskReport = {
        ...result.riskReport,
        latencyMs: result.latencyMs,
      };

      // Tally severities
      const criticalCount = riskReport.risks?.filter((r: any) => r.severity === RISK_SEVERITY.CRITICAL).length ?? 0;
      const moderateCount = riskReport.risks?.filter((r: any) => r.severity === RISK_SEVERITY.MODERATE).length ?? 0;
      const lowCount = riskReport.risks?.filter((r: any) => r.severity === RISK_SEVERITY.LOW).length ?? 0;

      // OTel attributes per PRD Appendix C
      span.setAttribute("llm.model_version", result.modelVersion);
      span.setAttribute("llm.prompt_hash_sha256", result.promptHash);
      span.setAttribute("llm.input_tokens", result.inputTokens);
      span.setAttribute("llm.output_tokens", result.outputTokens);
      span.setAttribute("llm.latency_ms", result.latencyMs);
      span.setAttribute("risk.critical_count", criticalCount);
      span.setAttribute("risk.has_uncertainty", result.hasUncertainty);

      if (result.latencyMs > 10_000) {
        console.warn(`[RiskAgent] GPT-4o latency ${result.latencyMs}ms exceeds 10s alert threshold`);
      }

      return {
        contractId: input.contractId,
        riskReports: [riskReport],
        criticalCount,
        moderateCount,
        lowCount,
        analysisLatencyMs: Date.now() - start,
        hasUncertainty: result.hasUncertainty,
      };
    }
  );
}
