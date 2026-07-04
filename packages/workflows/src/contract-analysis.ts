/**
 * LexGuard AI — Master Contract Analysis Workflow (Mastra)
 *
 * The central Mastra workflow DAG that orchestrates the 13-agent swarm
 * through the full contract analysis pipeline.
 *
 * Pipeline (per PRD v2.0 Section 8.1):
 *
 *   User Upload
 *     ↓
 *   API Gateway (JWT + Rate Limit)
 *     ↓
 *   [STEP 1] Document Agent — validate, metadata, S3 store
 *     ↓
 *   [STEP 2] Parsing Agent — OCR / structural extraction
 *     ↓
 *   [STEP 3] Embedding Agent — generate vectors, upsert to Qdrant contracts
 *     ↓
 *   [STEP 4 PARALLEL] Classification Agent + Retrieval Agent
 *     ↓
 *   [STEP 5 PARALLEL] Risk Agent + Benchmark Agent
 *     ↓
 *   [STEP 6] Rewrite Agent
 *     ↓
 *   [STEP 7] Compliance Agent
 *     ↓
 *   [STEP 8] Evaluation Agent → Enkrypt 10-Stage Pipeline
 *     ↓
 *   [GATE] Pass → Reporting Agent → Dashboard
 *         Fail/Low Confidence → HITL Queue → Lawyer Review
 *                                    ↓
 *                               Memory Agent → Qdrant update
 *     ↓
 *   OTel Span Closed, Audit Log Written
 *
 * Retry policy: 3x exponential backoff (2s, 4s, 8s) per step
 * HITL: Mastra native suspend/resume
 */

import { Mastra } from "@mastra/core";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import {
  DocumentAgentInputSchema,
  DocumentAgentOutputSchema,
  ParsingAgentInputSchema,
  ParsingAgentOutputSchema,
  EmbeddingAgentInputSchema,
  EmbeddingAgentOutputSchema,
  ContractUploadRequestSchema,
  AnalysisReportSchema,
} from "@lexguard/shared/schemas";
import { executeDocumentAgent } from "@lexguard/agents/document-agent";
import { executeParsingAgent } from "@lexguard/agents/parsing-agent";
import { executeEmbeddingAgent } from "@lexguard/agents/embedding-agent";
import {
  withSpan,
  OTEL_SPAN_NAMES,
} from "@lexguard/observability/tracer";
import { RETRY, SLA } from "@lexguard/shared/constants";
import { recordContractAnalysisLatency } from "@lexguard/observability/metrics";
import { v4 as uuidv4 } from "uuid";

// ─── Workflow Input/Output Schemas ────────────────────────────────────────────

const WorkflowInputSchema = z.object({
  // From API Gateway
  orgId: z.string().uuid(),
  tenantId: z.string().uuid(),
  uploadedBy: z.string().uuid(),
  rawFileUrl: z.string().url(),
  fileName: z.string(),
  fileSize: z.number().positive(),
  mimeType: z.string(),
  jurisdiction: z.string().optional().default("Unknown"),
  priority: z.enum(["standard", "urgent"]).default("standard"),
  // OTel context from API Gateway (W3C traceparent propagation)
  traceId: z.string(),
  spanId: z.string(),
});

const WorkflowOutputSchema = z.object({
  contractId: z.string().uuid(),
  workflowId: z.string(),
  status: z.enum(["completed", "hitl_required", "failed"]),
  reportId: z.string().uuid().optional(),
  hitlItemIds: z.array(z.string().uuid()).default([]),
  totalLatencyMs: z.number(),
  traceId: z.string(),
});

// ─── Step 1: Document Validation ─────────────────────────────────────────────

const documentValidationStep = createStep({
  id: "document-validation",
  description: "Validate the uploaded contract file, extract metadata, store to S3",
  inputSchema: WorkflowInputSchema,
  outputSchema: DocumentAgentOutputSchema,
  retryConfig: {
    attempts: RETRY.MAX_ATTEMPTS,
    delay: RETRY.BASE_DELAY_MS,
    backoffMultiplier: 2,
  },
  execute: async ({ inputData }) => {
    const contractId = uuidv4();

    return executeDocumentAgent({
      otel: {
        traceId: inputData.traceId,
        spanId: inputData.spanId,
        orgId: inputData.orgId,
        contractId,
      },
      rawFileUrl: inputData.rawFileUrl,
      fileName: inputData.fileName,
      fileSize: inputData.fileSize,
      mimeType: inputData.mimeType,
      orgId: inputData.orgId,
      tenantId: inputData.tenantId,
      uploadedBy: inputData.uploadedBy,
    });
  },
});

// ─── Step 2: Parsing ──────────────────────────────────────────────────────────

const parsingStep = createStep({
  id: "parsing",
  description: "OCR / structural extraction of clauses from the contract document",
  inputSchema: DocumentAgentOutputSchema,
  outputSchema: ParsingAgentOutputSchema,
  retryConfig: {
    attempts: RETRY.MAX_ATTEMPTS,
    delay: RETRY.BASE_DELAY_MS,
    backoffMultiplier: 2,
  },
  execute: async ({ inputData }) => {
    return executeParsingAgent({
      otel: {
        traceId: "",
        spanId: "",
        orgId: "",
        contractId: inputData.contractId,
      },
      contractId: inputData.contractId,
      orgId: "",  // Will be threaded through context in production
      documentType: inputData.documentType,
      s3Key: inputData.s3Key,
    });
  },
});

// ─── Step 3: Embedding ────────────────────────────────────────────────────────

const embeddingStep = createStep({
  id: "embedding",
  description: "Generate text-embedding-3-large vectors and upsert to Qdrant contracts",
  inputSchema: ParsingAgentOutputSchema,
  outputSchema: EmbeddingAgentOutputSchema,
  retryConfig: {
    attempts: RETRY.MAX_ATTEMPTS,
    delay: RETRY.BASE_DELAY_MS,
    backoffMultiplier: 2,
  },
  execute: async ({ inputData }) => {
    return executeEmbeddingAgent({
      otel: {
        traceId: "",
        spanId: "",
        orgId: "",
        contractId: inputData.contractId,
      },
      contractId: inputData.contractId,
      orgId: "",
      tenantId: "",
      jurisdiction: "Unknown",
      clauses: inputData.clauses,
    });
  },
});

// ─── Step 4: Classification + Retrieval (Parallel) ───────────────────────────
// NOTE: Full Classification, Retrieval, Risk, Benchmark, Rewrite,
// Compliance, Evaluation, Memory, and Reporting agents are implemented
// in Phase 2 and Phase 3. Their stubs are registered here.

const classificationAndRetrievalStep = createStep({
  id: "classification-and-retrieval",
  description:
    "[Phase 2] Parallel: Classify clauses into legal categories + retrieve relevant Qdrant context",
  inputSchema: EmbeddingAgentOutputSchema,
  outputSchema: z.object({
    contractId: z.string().uuid(),
    status: z.literal("classification-retrieval-complete"),
  }),
  execute: async ({ inputData }) => {
    // Phase 2: Will run Classification Agent + Retrieval Agent in parallel
    // const [classified, retrieved] = await Promise.all([
    //   executeClassificationAgent({ clauses }),
    //   executeRetrievalAgent({ clauses, orgId, tenantId, jurisdiction }),
    // ]);
    console.log(
      `[Workflow] Step 4 stub: Classification + Retrieval for ${inputData.contractId}`
    );
    return {
      contractId: inputData.contractId,
      status: "classification-retrieval-complete" as const,
    };
  },
});

// ─── Step 5: Risk + Benchmark (Parallel) ─────────────────────────────────────

const riskAndBenchmarkStep = createStep({
  id: "risk-and-benchmark",
  description: "[Phase 2] Parallel: Risk Analysis + Clause Benchmarking",
  inputSchema: z.object({
    contractId: z.string().uuid(),
    status: z.literal("classification-retrieval-complete"),
  }),
  outputSchema: z.object({
    contractId: z.string().uuid(),
    status: z.literal("risk-benchmark-complete"),
  }),
  execute: async ({ inputData }) => {
    console.log(
      `[Workflow] Step 5 stub: Risk + Benchmark for ${inputData.contractId}`
    );
    return {
      contractId: inputData.contractId,
      status: "risk-benchmark-complete" as const,
    };
  },
});

// ─── Step 6: Rewrite Generation ───────────────────────────────────────────────

const rewriteStep = createStep({
  id: "rewrite",
  description: "[Phase 2] Generate 2-3 safer clause alternatives per flagged risk",
  inputSchema: z.object({
    contractId: z.string().uuid(),
    status: z.literal("risk-benchmark-complete"),
  }),
  outputSchema: z.object({
    contractId: z.string().uuid(),
    status: z.literal("rewrite-complete"),
  }),
  execute: async ({ inputData }) => {
    console.log(`[Workflow] Step 6 stub: Rewrite for ${inputData.contractId}`);
    return {
      contractId: inputData.contractId,
      status: "rewrite-complete" as const,
    };
  },
});

// ─── Step 7: Compliance Check ─────────────────────────────────────────────────

const complianceStep = createStep({
  id: "compliance",
  description: "[Phase 2] Check clauses against jurisdiction-specific rules",
  inputSchema: z.object({
    contractId: z.string().uuid(),
    status: z.literal("rewrite-complete"),
  }),
  outputSchema: z.object({
    contractId: z.string().uuid(),
    status: z.literal("compliance-complete"),
  }),
  execute: async ({ inputData }) => {
    console.log(
      `[Workflow] Step 7 stub: Compliance for ${inputData.contractId}`
    );
    return {
      contractId: inputData.contractId,
      status: "compliance-complete" as const,
    };
  },
});

// ─── Step 8: Evaluation (Enkrypt 10-Stage DAG) ────────────────────────────────

const evaluationStep = createStep({
  id: "evaluation",
  description:
    "[Phase 3] Route every LLM output through Enkrypt 10-stage parallelized safety pipeline",
  inputSchema: z.object({
    contractId: z.string().uuid(),
    status: z.literal("compliance-complete"),
  }),
  outputSchema: z.object({
    contractId: z.string().uuid(),
    enkryptPass: z.boolean(),
    confidenceScore: z.number(),
    hitlRequired: z.boolean(),
    hitlItemIds: z.array(z.string().uuid()),
  }),
  execute: async ({ inputData }) => {
    console.log(
      `[Workflow] Step 8 stub: Evaluation/Enkrypt for ${inputData.contractId}`
    );
    // Phase 3: Will run full Enkrypt 10-stage DAG
    return {
      contractId: inputData.contractId,
      enkryptPass: true,
      confidenceScore: 0.95,
      hitlRequired: false,
      hitlItemIds: [],
    };
  },
});

// ─── Step 9: HITL Gate ────────────────────────────────────────────────────────

const hitlGateStep = createStep({
  id: "hitl-gate",
  description:
    "HITL suspend/resume gate: pause workflow for human review when Enkrypt confidence < 0.70",
  inputSchema: z.object({
    contractId: z.string().uuid(),
    enkryptPass: z.boolean(),
    confidenceScore: z.number(),
    hitlRequired: z.boolean(),
    hitlItemIds: z.array(z.string().uuid()),
  }),
  outputSchema: z.object({
    contractId: z.string().uuid(),
    approvedForReport: z.boolean(),
    hitlItemIds: z.array(z.string().uuid()),
  }),
  // Mastra native suspend support
  execute: async ({ inputData, suspend }) => {
    if (inputData.hitlRequired) {
      // Suspend the workflow — Mastra will persist state
      // The HITL portal calls POST /api/v1/hitl/{id}/decision to resume
      console.log(
        `[Workflow] HITL suspend for contract ${inputData.contractId}. Items: ${inputData.hitlItemIds.join(", ")}`
      );
      await suspend({
        reason: "enkrypt_confidence_below_threshold",
        hitlItemIds: inputData.hitlItemIds,
        contractId: inputData.contractId,
      });
    }

    return {
      contractId: inputData.contractId,
      approvedForReport: inputData.enkryptPass,
      hitlItemIds: inputData.hitlItemIds,
    };
  },
});

// ─── Step 10: Report Generation ───────────────────────────────────────────────

const reportingStep = createStep({
  id: "reporting",
  description: "[Phase 4] Generate structured PDF + JSON analysis report",
  inputSchema: z.object({
    contractId: z.string().uuid(),
    approvedForReport: z.boolean(),
    hitlItemIds: z.array(z.string().uuid()),
  }),
  outputSchema: z.object({
    contractId: z.string().uuid(),
    reportId: z.string().uuid(),
    status: z.literal("completed"),
  }),
  execute: async ({ inputData }) => {
    const reportId = uuidv4();
    console.log(
      `[Workflow] Step 10 stub: Report generation for ${inputData.contractId} → reportId: ${reportId}`
    );
    return {
      contractId: inputData.contractId,
      reportId,
      status: "completed" as const,
    };
  },
});

// ─── Workflow Assembly ────────────────────────────────────────────────────────

export const contractAnalysisWorkflow = createWorkflow({
  id: "contract-analysis",
  name: "LexGuard Contract Analysis",
  description:
    "End-to-end contract analysis pipeline: validation → parsing → embedding → classification → risk → rewrite → compliance → Enkrypt → HITL gate → report",
  inputSchema: WorkflowInputSchema,
  outputSchema: WorkflowOutputSchema,
})
  .step(documentValidationStep)
  .then(parsingStep)
  .then(embeddingStep)
  .then(classificationAndRetrievalStep)
  .then(riskAndBenchmarkStep)
  .then(rewriteStep)
  .then(complianceStep)
  .then(evaluationStep)
  .then(hitlGateStep)
  .then(reportingStep)
  .commit();

// ─── Mastra Instance ──────────────────────────────────────────────────────────

export const mastra = new Mastra({
  workflows: {
    "contract-analysis": contractAnalysisWorkflow,
  },
});

// ─── Workflow Trigger ─────────────────────────────────────────────────────────

export interface TriggerContractAnalysisParams {
  orgId: string;
  tenantId: string;
  uploadedBy: string;
  rawFileUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  jurisdiction?: string;
  priority?: "standard" | "urgent";
  traceId: string;
  spanId: string;
}

/**
 * Trigger the contract analysis workflow from the API Gateway.
 * Returns immediately with workflowId for status polling.
 */
export async function triggerContractAnalysis(
  params: TriggerContractAnalysisParams
): Promise<{ workflowId: string; contractId: string }> {
  const workflowId = uuidv4();
  const startTime = Date.now();

  return withSpan(
    OTEL_SPAN_NAMES.MASTRA_WORKFLOW_START,
    {
      "mastra.workflow_id": workflowId,
      "lexguard.org_id": params.orgId,
    },
    async (span) => {
      const run = await mastra
        .getWorkflow("contract-analysis")
        .createRun({ runId: workflowId });

      await run.start({
        inputData: {
          ...params,
          jurisdiction: params.jurisdiction ?? "Unknown",
          priority: params.priority ?? "standard",
        },
      });

      const totalLatency = Date.now() - startTime;
      recordContractAnalysisLatency(totalLatency);
      span.setAttribute("mastra.workflow_id", workflowId);
      span.setAttribute("total_latency_ms", totalLatency);

      return { workflowId, contractId: workflowId }; // contractId threaded from Step 1
    }
  );
}
