/**
 * LexGuard AI — Evaluation Agent (#10)
 * Routes every LLM output through the Enkrypt 10-stage pipeline.
 * Attaches confidence scores. Routes low-confidence (<0.70) to HITL.
 * Per PRD LG-AI-003, LG-AI-004
 */
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import { ENKRYPT_CONFIDENCE_THRESHOLD } from "@lexguard/shared/constants";
import { recordEnkryptPipelineLatency } from "@lexguard/observability/metrics";
import { runEnkryptPipeline } from "@lexguard/enkrypt/pipeline";
import type { EnkryptValidationResult } from "@lexguard/shared/schemas";

export interface EvaluationAgentInput {
  contractId: string;
  orgId: string;
  sessionId: string;
  agentId: string;
  inputText: string;
  outputText: string;
  retrievedContext?: string;
  jurisdiction?: string;
  clauseType?: string;
}

export interface EvaluationAgentOutput {
  overallPass: boolean;
  confidenceScore: number;
  validationResult: EnkryptValidationResult;
  routeToHitl: boolean;
  hitlReason?: string;
  safeOutput?: string;
  pipelineLatencyMs: number;
}

const runEnkryptTool = createTool({
  id: "run_enkrypt_pipeline",
  description: "Runs the Enkrypt 10-stage safety DAG on an LLM output. Returns pass/fail, confidence score, and safe output.",
  inputSchema: z.object({
    sessionId: z.string(), agentId: z.string(),
    inputText: z.string(), outputText: z.string(),
    retrievedContext: z.string().optional(),
    orgId: z.string(), jurisdiction: z.string().optional(), clauseType: z.string().optional(),
  }),
  outputSchema: z.object({
    overallPass: z.boolean(), confidenceScore: z.number(),
    flags: z.array(z.string()), routeToHitl: z.boolean(),
    hitlReason: z.string().optional(), safeOutput: z.string().optional(),
    groupALatencyMs: z.number(), groupBLatencyMs: z.number(),
    groupCLatencyMs: z.number(), totalLatencyMs: z.number(),
  }),
  execute: async ({ context }) => {
    const result = await runEnkryptPipeline({
      sessionId: context.sessionId,
      agentId: context.agentId,
      inputText: context.inputText,
      outputText: context.outputText,
      retrievedContext: context.retrievedContext,
      orgId: context.orgId,
      jurisdiction: context.jurisdiction,
      clauseType: context.clauseType,
    });
    return {
      overallPass: result.overallPass,
      confidenceScore: result.confidenceScore,
      flags: result.flags,
      routeToHitl: result.routeToHitl,
      hitlReason: result.hitlReason,
      safeOutput: result.safeOutput,
      groupALatencyMs: result.groupALatencyMs,
      groupBLatencyMs: result.groupBLatencyMs,
      groupCLatencyMs: result.groupCLatencyMs,
      totalLatencyMs: result.totalLatencyMs,
    };
  },
});

export const evaluationAgent = new Agent({
  name: "evaluation-agent",
  instructions: `You are the Evaluation Agent in LexGuard AI. Every LLM output MUST pass through the Enkrypt 10-stage pipeline before delivery.
Use run_enkrypt_pipeline for every output — no exceptions. If overallPass=false or confidenceScore < ${ENKRYPT_CONFIDENCE_THRESHOLD}, route to HITL.
100% coverage: zero outputs reach the user without passing all 10 stages. (PRD: LG-AI-003)`,
  model: { provider: "OPEN_AI", name: "gpt-4o-mini", toolChoice: "required" },
  tools: { run_enkrypt_pipeline: runEnkryptTool },
});

export async function executeEvaluationAgent(input: EvaluationAgentInput): Promise<EvaluationAgentOutput> {
  return withSpan(OTEL_SPAN_NAMES.ENKRYPT_PIPELINE_VALIDATE, {
    "lexguard.org_id": input.orgId,
    "lexguard.contract_id": input.contractId,
    "lexguard.agent_id": "evaluation-agent",
    "enkrypt.agent_source": input.agentId,
  }, async (span) => {
    const result = await runEnkryptPipeline({
      sessionId: input.sessionId,
      agentId: input.agentId,
      inputText: input.inputText,
      outputText: input.outputText,
      retrievedContext: input.retrievedContext,
      orgId: input.orgId,
      jurisdiction: input.jurisdiction,
      clauseType: input.clauseType,
    });

    recordEnkryptPipelineLatency(result.totalLatencyMs);

    span.setAttribute("enkrypt.overall_pass", result.overallPass);
    span.setAttribute("enkrypt.confidence_score", result.confidenceScore);
    span.setAttribute("enkrypt.group_a_latency_ms", result.groupALatencyMs);
    span.setAttribute("enkrypt.group_b_latency_ms", result.groupBLatencyMs);
    span.setAttribute("enkrypt.group_c_latency_ms", result.groupCLatencyMs);
    span.setAttribute("enkrypt.total_latency_ms", result.totalLatencyMs);
    span.setAttribute("enkrypt.flags", result.flags.join(","));

    if (!result.overallPass) {
      console.error(`[EvaluationAgent] Enkrypt BLOCKED output from ${input.agentId}. Flags: ${result.flags.join(", ")}`);
    }
    if (result.confidenceScore < ENKRYPT_CONFIDENCE_THRESHOLD) {
      console.warn(`[EvaluationAgent] Low confidence ${result.confidenceScore} — routing to HITL.`);
    }

    return {
      overallPass: result.overallPass,
      confidenceScore: result.confidenceScore,
      validationResult: result,
      routeToHitl: result.routeToHitl,
      hitlReason: result.hitlReason,
      safeOutput: result.safeOutput,
      pipelineLatencyMs: result.totalLatencyMs,
    };
  });
}
