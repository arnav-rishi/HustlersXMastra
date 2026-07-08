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
import { PrismaClient } from "@prisma/client";
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
import { executeClassificationAgent } from "@lexguard/agents/classification-agent";
import { executeRetrievalAgent } from "@lexguard/agents/retrieval-agent";
import { executeRiskAgent } from "@lexguard/agents/risk-agent";
import { executeBenchmarkAgent } from "@lexguard/agents/benchmark-agent";
import { executeRewriteAgent } from "@lexguard/agents/rewrite-agent";
import { executeComplianceAgent } from "@lexguard/agents/compliance-agent";
import { executeEvaluationAgent } from "@lexguard/agents/evaluation-agent";
import { executeReportingAgent } from "@lexguard/agents/reporting-agent";
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
  contractId: z.string().uuid(),
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
    return executeDocumentAgent({
      otel: {
        traceId: inputData.traceId,
        spanId: inputData.spanId,
        orgId: inputData.orgId,
        contractId: inputData.contractId,
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
    clauses: z.array(z.any()),
    retrievals: z.array(z.any()),
    jurisdiction: z.string(),
    orgId: z.string().uuid(),
    tenantId: z.string().uuid(),
  }),
  execute: async ({ inputData, getInitData }) => {
    const initData = getInitData();
    const classified = await executeClassificationAgent({
      otel: {
        traceId: initData.traceId,
        spanId: initData.spanId,
        orgId: initData.orgId,
        contractId: inputData.contractId,
      },
      contractId: inputData.contractId,
      orgId: initData.orgId,
      clauses: inputData.clauses,
    });

    const retrievals = await Promise.all(
      classified.classifiedClauses.map((clause) =>
        executeRetrievalAgent({
          otel: {
            traceId: initData.traceId,
            spanId: initData.spanId,
            orgId: initData.orgId,
            contractId: inputData.contractId,
          },
          contractId: inputData.contractId,
          orgId: initData.orgId,
          tenantId: initData.tenantId,
          jurisdiction: initData.jurisdiction ?? "Unknown",
          clause,
        })
      )
    );

    return {
      contractId: inputData.contractId,
      clauses: classified.classifiedClauses,
      retrievals,
      jurisdiction: initData.jurisdiction ?? "Unknown",
      orgId: initData.orgId,
      tenantId: initData.tenantId,
    };
  },
});

// ─── Step 5: Risk + Benchmark (Parallel) ─────────────────────────────────────

const riskAndBenchmarkStep = createStep({
  id: "risk-and-benchmark",
  description: "[Phase 2] Parallel: Risk Analysis + Clause Benchmarking",
  inputSchema: z.object({
    contractId: z.string().uuid(),
    clauses: z.array(z.any()),
    retrievals: z.array(z.any()),
    jurisdiction: z.string(),
    orgId: z.string().uuid(),
    tenantId: z.string().uuid(),
  }),
  outputSchema: z.object({
    contractId: z.string().uuid(),
    riskResults: z.array(z.any()),
    benchmarkResults: z.array(z.any()),
    clauses: z.array(z.any()),
    retrievals: z.array(z.any()),
    jurisdiction: z.string(),
    orgId: z.string().uuid(),
    tenantId: z.string().uuid(),
  }),
  execute: async ({ inputData }) => {
    const riskResults = await Promise.all(
      inputData.clauses.map((clause: any, index: number) =>
        executeRiskAgent({
          otel: {
            traceId: "workflow",
            spanId: "workflow",
            orgId: inputData.orgId,
            contractId: inputData.contractId,
          },
          contractId: inputData.contractId,
          orgId: inputData.orgId,
          jurisdiction: inputData.jurisdiction,
          clause,
          retrievedContext: inputData.retrievals[index],
        })
      )
    );
    const benchmarkResults = await Promise.all(
      inputData.clauses.map((clause: any, index: number) =>
        executeBenchmarkAgent({
          contractId: inputData.contractId,
          orgId: inputData.orgId,
          jurisdiction: inputData.jurisdiction,
          clauseIndex: clause.clauseIndex,
          clauseType: clause.clauseType ?? "unknown",
          clauseText: clause.clauseText,
          retrievedTemplates: inputData.retrievals[index]?.retrievedItems ?? [],
          retrievedPrecedents: inputData.retrievals[index]?.retrievedItems ?? [],
        })
      )
    );
    return {
      contractId: inputData.contractId,
      riskResults,
      benchmarkResults,
      clauses: inputData.clauses,
      retrievals: inputData.retrievals,
      jurisdiction: inputData.jurisdiction,
      orgId: inputData.orgId,
      tenantId: inputData.tenantId,
    };
  },
});

// ─── Step 6: Rewrite Generation ───────────────────────────────────────────────

const rewriteStep = createStep({
  id: "rewrite",
  description: "[Phase 2] Generate 2-3 safer clause alternatives per flagged risk",
  inputSchema: z.object({
    contractId: z.string().uuid(),
    riskResults: z.array(z.any()),
    benchmarkResults: z.array(z.any()),
    clauses: z.array(z.any()),
    retrievals: z.array(z.any()),
    jurisdiction: z.string(),
    orgId: z.string().uuid(),
    tenantId: z.string().uuid(),
  }),
  outputSchema: z.object({
    contractId: z.string().uuid(),
    rewriteResults: z.array(z.any()),
    riskResults: z.array(z.any()),
    benchmarkResults: z.array(z.any()),
    clauses: z.array(z.any()),
    retrievals: z.array(z.any()),
    jurisdiction: z.string(),
    orgId: z.string().uuid(),
    tenantId: z.string().uuid(),
  }),
  execute: async ({ inputData }) => {
    const rewriteResults = await Promise.all(
      inputData.clauses.map((clause: any, index: number) =>
        executeRewriteAgent({
          otel: {
            traceId: "workflow",
            spanId: "workflow",
            orgId: inputData.orgId,
            contractId: inputData.contractId,
          },
          contractId: inputData.contractId,
          orgId: inputData.orgId,
          jurisdiction: inputData.jurisdiction,
          clause,
          riskReport: inputData.riskResults[index]?.riskReports?.[0],
          orgPreferences:
            inputData.retrievals[index]?.retrievedItems?.filter(
              (item: any) => item.collection === "org_preferences"
            ) ?? [],
        })
      )
    );
    return {
      contractId: inputData.contractId,
      rewriteResults,
      riskResults: inputData.riskResults,
      benchmarkResults: inputData.benchmarkResults,
      clauses: inputData.clauses,
      retrievals: inputData.retrievals,
      jurisdiction: inputData.jurisdiction,
      orgId: inputData.orgId,
      tenantId: inputData.tenantId,
    };
  },
});

// ─── Step 7: Compliance Check ─────────────────────────────────────────────────

const complianceStep = createStep({
  id: "compliance",
  description: "[Phase 2] Check clauses against jurisdiction-specific rules",
  inputSchema: z.object({
    contractId: z.string().uuid(),
    rewriteResults: z.array(z.any()),
    riskResults: z.array(z.any()),
    benchmarkResults: z.array(z.any()),
    clauses: z.array(z.any()),
    retrievals: z.array(z.any()),
    jurisdiction: z.string(),
    orgId: z.string().uuid(),
    tenantId: z.string().uuid(),
  }),
  outputSchema: z.object({
    contractId: z.string().uuid(),
    complianceResults: z.array(z.any()),
    rewriteResults: z.array(z.any()),
    riskResults: z.array(z.any()),
    benchmarkResults: z.array(z.any()),
    clauses: z.array(z.any()),
    retrievals: z.array(z.any()),
    jurisdiction: z.string(),
    orgId: z.string().uuid(),
    tenantId: z.string().uuid(),
  }),
  execute: async ({ inputData }) => {
    const complianceResults = await Promise.all(
      inputData.clauses.map((clause: any, index: number) =>
        executeComplianceAgent({
          contractId: inputData.contractId,
          orgId: inputData.orgId,
          jurisdiction: inputData.jurisdiction,
          clauseIndex: clause.clauseIndex,
          clauseType: clause.clauseType ?? "unknown",
          clauseText: clause.clauseText,
          jurisdictionRules:
            inputData.retrievals[index]?.retrievedItems?.filter(
              (item: any) => item.collection === "jurisdiction_rules"
            ) ?? [],
          regulatoryDocs:
            inputData.retrievals[index]?.retrievedItems?.filter(
              (item: any) => item.collection === "regulatory_documents"
            ) ?? [],
        })
      )
    );
    return {
      contractId: inputData.contractId,
      complianceResults,
      rewriteResults: inputData.rewriteResults,
      riskResults: inputData.riskResults,
      benchmarkResults: inputData.benchmarkResults,
      clauses: inputData.clauses,
      retrievals: inputData.retrievals,
      jurisdiction: inputData.jurisdiction,
      orgId: inputData.orgId,
      tenantId: inputData.tenantId,
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
    complianceResults: z.array(z.any()),
    rewriteResults: z.array(z.any()),
    riskResults: z.array(z.any()),
    benchmarkResults: z.array(z.any()),
    clauses: z.array(z.any()),
    retrievals: z.array(z.any()),
    jurisdiction: z.string(),
    orgId: z.string().uuid(),
    tenantId: z.string().uuid(),
  }),
  outputSchema: z.object({
    contractId: z.string().uuid(),
    enkryptPass: z.boolean(),
    confidenceScore: z.number(),
    hitlRequired: z.boolean(),
    hitlItemIds: z.array(z.string().uuid()),
    riskResults: z.array(z.any()),
    benchmarkResults: z.array(z.any()),
    rewriteResults: z.array(z.any()),
    complianceResults: z.array(z.any()),
    jurisdiction: z.string(),
    orgId: z.string().uuid(),
  }),
  execute: async ({ inputData }) => {
    const serializedOutput = JSON.stringify({
      riskResults: inputData.riskResults,
      benchmarkResults: inputData.benchmarkResults,
      rewriteResults: inputData.rewriteResults,
      complianceResults: inputData.complianceResults,
    });
    const evaluation = await executeEvaluationAgent({
      contractId: inputData.contractId,
      orgId: inputData.orgId,
      sessionId: inputData.contractId,
      agentId: "contract-analysis-workflow",
      inputText: JSON.stringify(inputData.clauses),
      outputText: serializedOutput,
      jurisdiction: inputData.jurisdiction,
    });

    return {
      contractId: inputData.contractId,
      enkryptPass: evaluation.overallPass,
      confidenceScore: evaluation.confidenceScore,
      hitlRequired: evaluation.routeToHitl,
      hitlItemIds: evaluation.routeToHitl ? [uuidv4()] : [],
      riskResults: inputData.riskResults,
      benchmarkResults: inputData.benchmarkResults,
      rewriteResults: inputData.rewriteResults,
      complianceResults: inputData.complianceResults,
      jurisdiction: inputData.jurisdiction,
      orgId: inputData.orgId,
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
    riskResults: z.array(z.any()),
    benchmarkResults: z.array(z.any()),
    rewriteResults: z.array(z.any()),
    complianceResults: z.array(z.any()),
    jurisdiction: z.string(),
    orgId: z.string().uuid(),
  }),
  outputSchema: z.object({
    contractId: z.string().uuid(),
    approvedForReport: z.boolean(),
    hitlItemIds: z.array(z.string().uuid()),
    riskResults: z.array(z.any()),
    benchmarkResults: z.array(z.any()),
    rewriteResults: z.array(z.any()),
    complianceResults: z.array(z.any()),
    jurisdiction: z.string(),
    orgId: z.string().uuid(),
    enkryptConfidenceScores: z.record(z.number()),
    hitlStatus: z.record(z.string()),
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

    const hitlStatus: Record<number, string> = {};
    const enkryptScores: Record<number, number> = {};
    // Simulate clause-level confidence map for reporting:
    inputData.riskResults.forEach((_, i) => {
      hitlStatus[i] = inputData.hitlRequired ? "pending" : "not_required";
      enkryptScores[i] = inputData.confidenceScore;
    });

    return {
      contractId: inputData.contractId,
      approvedForReport: inputData.enkryptPass,
      hitlItemIds: inputData.hitlItemIds,
      riskResults: inputData.riskResults,
      benchmarkResults: inputData.benchmarkResults,
      rewriteResults: inputData.rewriteResults,
      complianceResults: inputData.complianceResults,
      jurisdiction: inputData.jurisdiction,
      orgId: inputData.orgId,
      enkryptConfidenceScores: enkryptScores,
      hitlStatus: hitlStatus,
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
    riskResults: z.array(z.any()),
    benchmarkResults: z.array(z.any()),
    rewriteResults: z.array(z.any()),
    complianceResults: z.array(z.any()),
    jurisdiction: z.string(),
    orgId: z.string().uuid(),
    enkryptConfidenceScores: z.record(z.number()),
    hitlStatus: z.record(z.string()),
  }),
  outputSchema: z.object({
    contractId: z.string().uuid(),
    reportId: z.string().uuid(),
    status: z.literal("completed"),
  }),
  execute: async ({ inputData }) => {
    const report = await executeReportingAgent({
      contractId: inputData.contractId,
      orgId: inputData.orgId,
      jurisdiction: inputData.jurisdiction,
      riskResults: inputData.riskResults,
      benchmarkResults: inputData.benchmarkResults,
      rewriteResults: inputData.rewriteResults,
      complianceResults: inputData.complianceResults,
      enkryptConfidenceScores: inputData.enkryptConfidenceScores,
      hitlStatus: inputData.hitlStatus as any,
    });

    const prisma = new PrismaClient();
    await prisma.contract.update({
      where: { id: inputData.contractId },
      data: {
        analysisJson: report as any,
        reportId: report.reportId,
        status: "COMPLETED",
        workflowStatus: "completed",
        completedAt: new Date(),
        progressPct: 100,
      },
    });

    return {
      contractId: inputData.contractId,
      reportId: report.reportId,
      status: "completed" as const,
    };
  },
});

// ─── Workflow Assembly ────────────────────────────────────────────────────────

export const contractAnalysisWorkflow = createWorkflow({
  id: "contract-analysis",
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
  contractId: string;
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

      void run.start({
        inputData: {
          ...params,
          jurisdiction: params.jurisdiction ?? "Unknown",
          priority: params.priority ?? "standard",
        },
      });

      span.setAttribute("mastra.workflow_id", workflowId);
      return { workflowId, contractId: params.contractId };
    }
  );
}
