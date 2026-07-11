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
import { z } from "zod";
import { gpt4o, getChatDeployment } from "./models";
import crypto from "crypto";
import {
  type RiskAgentInput,
  type RiskAgentOutput,
  type RiskReport,
  RiskReportSchema,
} from "@lexguard/shared/schemas";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import {
  RISK_SEVERITY,
} from "@lexguard/shared/constants";
import { recordLlmTokens } from "@lexguard/observability/metrics";

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

// ─── LLM-facing output schema ─────────────────────────────────────────────────
// RiskReportSchema minus the fields WE compute after the call (promptHash,
// modelVersion, latencyMs) — asking the model to invent those would be both
// wrong and wasteful.
const RiskReportLlmSchema = RiskReportSchema.omit({
  modelVersion: true,
  promptHash: true,
  latencyMs: true,
});

// ─── Agent Definition ─────────────────────────────────────────────────────────

export const riskAgent: Agent = new Agent({
  id: "risk-analysis-agent",
  name: "risk-analysis-agent",
  instructions: `You are the Risk Analysis Agent in the LexGuard AI legal intelligence platform.

Your role is to act as a Senior Commercial Counsel analyzing legal clauses for risk.

For each clause:
1. Identify severity, triggering language, financial exposure, citation for every risk
2. Never invent citations — use "Unverified" if unsupported by retrieved context
3. CRITICAL clauses must have explicit financial exposure estimates
4. Return the complete RiskReport JSON

The 4-step chain-of-thought reasoning is MANDATORY before producing output.`,

  model: gpt4o,
});

// ─── Clause Risk Analysis (real agent.generateLegacy() call) ─────────────────
// Runs the CRISPE prompt through the agent's own structured-output generation
// instead of a raw client call — this is what makes it a genuine Mastra
// AGENT_RUN with a real MODEL_GENERATION child span, not just an Agent object
// that's constructed but never driven.

async function analyzeClauseRisk(input: {
  clauseType: string;
  clauseIndex: number;
  clauseText: string;
  jurisdiction: string;
  orgId: string;
  retrievedContext: string;
  benchmarkContext: string;
}) {
  const systemPrompt = buildRiskAnalysisPrompt({
    clauseType: input.clauseType,
    jurisdiction: input.jurisdiction,
    orgName: `Org-${input.orgId.slice(0, 8)}`,
    retrievedRisks: input.retrievedContext,
    benchmarkSummary: input.benchmarkContext || "No benchmark data available",
    industrySector: "Commercial",
    clauseText: input.clauseText,
  });

  // SHA-256 hash of prompt for audit log (per PRD LG-COMP-002)
  const promptHash = crypto.createHash("sha256").update(systemPrompt).digest("hex");

  const start = Date.now();
  let hasUncertainty = false;
  let riskReport: any = null;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const response = await riskAgent.generateLegacy<typeof RiskReportLlmSchema>(
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Analyze the clause above (clauseIndex: ${input.clauseIndex}) and return the risk report JSON.`,
        },
      ],
      { output: RiskReportLlmSchema }
    );

    inputTokens = response.usage?.promptTokens ?? 0;
    outputTokens = response.usage?.completionTokens ?? 0;

    // Cast: TS's overload resolution for generateLegacy() doesn't reliably
    // narrow `.object` to the inferred Zod type here even with an explicit
    // type argument — a TS-only artifact, not a runtime one (verified: the
    // real response.object is a genuine object matching RiskReportLlmSchema).
    const generated = response.object as z.infer<typeof RiskReportLlmSchema>;
    riskReport = { ...generated };
    riskReport.clauseIndex = input.clauseIndex;
    riskReport.promptHash = promptHash;
    riskReport.modelVersion = getChatDeployment();
  } catch (err) {
    hasUncertainty = true;
    // Return safe partial result on failure (per PRD failure behavior)
    riskReport = {
      clauseType: input.clauseType,
      clauseIndex: input.clauseIndex,
      risks: [{
        severity: RISK_SEVERITY.MODERATE,
        description: "Risk analysis incomplete — LLM service error",
        triggeringLanguage: input.clauseText.slice(0, 100),
        financialExposure: "Unknown — manual review required",
        citation: "Unverified",
      }],
      overallRisk: RISK_SEVERITY.MODERATE,
      chainOfThought: "Analysis incomplete due to service error.",
      promptHash,
      modelVersion: getChatDeployment(),
    };
  }

  const latencyMs = Date.now() - start;

  // Record LLM token usage for cost tracking
  recordLlmTokens(input.orgId, getChatDeployment(), inputTokens, outputTokens);

  return {
    riskReport,
    promptHash,
    modelVersion: getChatDeployment(),
    inputTokens,
    outputTokens,
    latencyMs,
    hasUncertainty,
  };
}

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
      "llm.model": getChatDeployment(),
      "clause.type": input.clause.clauseType ?? "unknown",
      "clause.index": input.clause.clauseIndex,
    },
    async (span) => {
      const start = Date.now();

      // Build context strings from retrieved items
      const retrievedContext = input.retrievedContext.retrievedItems
        .map((item) => `[${item.collection}] score:${item.score.toFixed(2)} — ${JSON.stringify(item.payload).slice(0, 300)}`)
        .join("\n");

      const result = await analyzeClauseRisk({
        clauseType: input.clause.clauseType ?? "unknown",
        clauseIndex: input.clause.clauseIndex,
        clauseText: input.clause.clauseText,
        jurisdiction: input.jurisdiction,
        orgId: input.orgId,
        retrievedContext,
        benchmarkContext: "",
      });

      const riskReport: RiskReport = {
        ...(result.riskReport || {}),
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

      if ((result.latencyMs ?? 0) > 10_000) {
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
