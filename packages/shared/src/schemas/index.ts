/**
 * LexGuard AI — Shared Zod Schemas
 *
 * Defines all I/O schemas for every agent in the 13-agent swarm.
 * These schemas are the single source of truth for typed message passing
 * between agents via the Mastra workflow DAG.
 *
 * Schema naming: <AgentName>Input / <AgentName>Output
 */

import { z } from "zod";
import { CLAUSE_TYPES, RISK_SEVERITY } from "../constants";

// ─── Common Primitives ────────────────────────────────────────────────────────

export const UUIDSchema = z.string().uuid();

export const OtelContextSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  orgId: UUIDSchema,
  contractId: UUIDSchema,
});

export const RiskSeveritySchema = z.enum([
  RISK_SEVERITY.CRITICAL,
  RISK_SEVERITY.MODERATE,
  RISK_SEVERITY.LOW,
]);

export const ClauseTypeSchema = z.enum(CLAUSE_TYPES);

export const BoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

// ─── Document Agent ───────────────────────────────────────────────────────────

export const DocumentAgentInputSchema = z.object({
  otel: OtelContextSchema,
  rawFileUrl: z.string().url(),       // S3 pre-signed URL
  fileName: z.string(),
  fileSize: z.number().positive(),
  mimeType: z.string(),
  orgId: UUIDSchema,
  tenantId: UUIDSchema,
  uploadedBy: UUIDSchema,
});

export const DocumentAgentOutputSchema = z.object({
  contractId: UUIDSchema,
  documentType: z.enum(["digital_pdf", "scanned_pdf", "docx"]),
  pageCount: z.number().positive(),
  metadata: z.object({
    fileName: z.string(),
    fileSize: z.number(),
    jurisdiction: z.string().optional(),
    partyNames: z.array(z.string()),
    contractDate: z.string().optional(),
    contractTitle: z.string().optional(),
  }),
  s3Key: z.string(),
  isValid: z.boolean(),
  validationErrors: z.array(z.string()).default([]),
});

export type DocumentAgentInput = z.infer<typeof DocumentAgentInputSchema>;
export type DocumentAgentOutput = z.infer<typeof DocumentAgentOutputSchema>;

// ─── Parsing Agent ────────────────────────────────────────────────────────────

export const ExtractedClauseSchema = z.object({
  clauseIndex: z.number(),
  clauseType: ClauseTypeSchema.nullable(),
  clauseText: z.string().min(1),
  pageNumber: z.number(),
  boundingBox: BoundingBoxSchema.optional(),
  ocrConfidence: z.number().min(0).max(1),
  characterCount: z.number(),
});

export const ParsingAgentInputSchema = z.object({
  otel: OtelContextSchema,
  contractId: UUIDSchema,
  orgId: UUIDSchema,
  documentType: z.enum(["digital_pdf", "scanned_pdf", "docx"]),
  s3Key: z.string(),
});

export const ParsingAgentOutputSchema = z.object({
  contractId: UUIDSchema,
  clauses: z.array(ExtractedClauseSchema),
  totalClauses: z.number(),
  overallOcrConfidence: z.number().min(0).max(1),
  parseLatencyMs: z.number(),
  flaggedForHitl: z.boolean(),   // true if ocr_confidence < 0.90
  rawTextFallback: z.boolean(),  // true if OCR failed completely
});

export type ParsingAgentInput = z.infer<typeof ParsingAgentInputSchema>;
export type ParsingAgentOutput = z.infer<typeof ParsingAgentOutputSchema>;

// ─── Embedding Agent ──────────────────────────────────────────────────────────

export const EmbeddingAgentInputSchema = z.object({
  otel: OtelContextSchema,
  contractId: UUIDSchema,
  orgId: UUIDSchema,
  tenantId: UUIDSchema,
  jurisdiction: z.string().default("Unknown"),
  clauses: z.array(ExtractedClauseSchema),
});

export const EmbeddingAgentOutputSchema = z.object({
  contractId: UUIDSchema,
  chunksUpserted: z.number(),
  embeddingModel: z.string(),
  qdrantCollection: z.string(),
  upsertLatencyMs: z.number(),
  chunkIds: z.array(UUIDSchema),
});

export type EmbeddingAgentInput = z.infer<typeof EmbeddingAgentInputSchema>;
export type EmbeddingAgentOutput = z.infer<typeof EmbeddingAgentOutputSchema>;

// ─── Classification Agent ─────────────────────────────────────────────────────

export const ClassifiedClauseSchema = ExtractedClauseSchema.extend({
  clauseType: ClauseTypeSchema,
  classificationConfidence: z.number().min(0).max(1),
  fallbackUsed: z.boolean(),  // true = zero-shot LLM fallback
});

export const ClassificationAgentInputSchema = z.object({
  otel: OtelContextSchema,
  contractId: UUIDSchema,
  orgId: UUIDSchema,
  clauses: z.array(ExtractedClauseSchema),
});

export const ClassificationAgentOutputSchema = z.object({
  contractId: UUIDSchema,
  classifiedClauses: z.array(ClassifiedClauseSchema),
  classificationLatencyMs: z.number(),
  fallbackCount: z.number(),  // how many used LLM zero-shot
  hitlFlagged: z.array(z.number()), // clauseIndex of Unknown types
});

export type ClassificationAgentInput = z.infer<typeof ClassificationAgentInputSchema>;
export type ClassificationAgentOutput = z.infer<typeof ClassificationAgentOutputSchema>;

// ─── Retrieval Agent ──────────────────────────────────────────────────────────

export const RetrievedItemSchema = z.object({
  collection: z.string(),
  id: z.string(),
  score: z.number(),
  payload: z.record(z.unknown()),
  priority: z.number(),  // 1=org_preferences, 2=risk_patterns, etc.
});

export const RetrievalAgentInputSchema = z.object({
  otel: OtelContextSchema,
  contractId: UUIDSchema,
  orgId: UUIDSchema,
  tenantId: UUIDSchema,
  jurisdiction: z.string(),
  clause: ClassifiedClauseSchema,
});

export const RetrievalAgentOutputSchema = z.object({
  clauseIndex: z.number(),
  retrievedItems: z.array(RetrievedItemSchema),
  contextTokenCount: z.number(),
  retrievalConfidence: z.enum(["High", "Medium", "Low"]),
  cacheHit: z.boolean(),
  retrievalLatencyMs: z.number(),
  coldStart: z.boolean(),  // true if org_preferences returned 0 results
});

export type RetrievalAgentInput = z.infer<typeof RetrievalAgentInputSchema>;
export type RetrievalAgentOutput = z.infer<typeof RetrievalAgentOutputSchema>;

// ─── Risk Analysis Agent ──────────────────────────────────────────────────────

export const RiskItemSchema = z.object({
  severity: RiskSeveritySchema,
  description: z.string(),
  triggeringLanguage: z.string(),
  financialExposure: z.string(),
  benchmarkDeviation: z.string().optional(),
  orgPreferenceConflict: z.string().optional(),
  citation: z.string(),
});

export const RiskReportSchema = z.object({
  clauseType: ClauseTypeSchema,
  clauseIndex: z.number(),
  risks: z.array(RiskItemSchema),
  overallRisk: RiskSeveritySchema,
  chainOfThought: z.string(),  // step-by-step reasoning
  modelVersion: z.string(),
  promptHash: z.string(),      // SHA-256 of prompt for audit
  latencyMs: z.number(),
});

export const RiskAgentInputSchema = z.object({
  otel: OtelContextSchema,
  contractId: UUIDSchema,
  orgId: UUIDSchema,
  jurisdiction: z.string(),
  clause: ClassifiedClauseSchema,
  retrievedContext: RetrievalAgentOutputSchema,
});

export const RiskAgentOutputSchema = z.object({
  contractId: UUIDSchema,
  riskReports: z.array(RiskReportSchema),
  criticalCount: z.number(),
  moderateCount: z.number(),
  lowCount: z.number(),
  analysisLatencyMs: z.number(),
  hasUncertainty: z.boolean(),
});

export type RiskAgentInput = z.infer<typeof RiskAgentInputSchema>;
export type RiskAgentOutput = z.infer<typeof RiskAgentOutputSchema>;

// ─── Rewrite Agent ────────────────────────────────────────────────────────────

export const RewriteVersionSchema = z.object({
  version: z.number().int().min(1).max(3),
  strategy: z.string(),
  text: z.string(),
  changes: z.array(
    z.object({
      original: z.string(),
      revised: z.string(),
      reason: z.string(),
    })
  ),
  enkryptValidated: z.boolean().default(false),
});

export const RewriteAgentInputSchema = z.object({
  otel: OtelContextSchema,
  contractId: UUIDSchema,
  orgId: UUIDSchema,
  jurisdiction: z.string(),
  clause: ClassifiedClauseSchema,
  riskReport: RiskReportSchema,
  orgPreferences: z.array(RetrievedItemSchema),
});

export const RewriteAgentOutputSchema = z.object({
  clauseIndex: z.number(),
  rewrites: z.array(RewriteVersionSchema),
  rewriteLatencyMs: z.number(),
  modelVersion: z.string(),
  promptHash: z.string(),
});

export type RewriteAgentInput = z.infer<typeof RewriteAgentInputSchema>;
export type RewriteAgentOutput = z.infer<typeof RewriteAgentOutputSchema>;

// ─── Enkrypt Validation ───────────────────────────────────────────────────────

export const EnkryptStageResultSchema = z.object({
  stage: z.number().int().min(1).max(10),
  group: z.enum(["Gate", "A", "B", "C"]),
  pass: z.boolean(),
  latencyMs: z.number(),
  flags: z.array(z.string()).default([]),
  details: z.record(z.unknown()).optional(),
});

export const EnkryptValidationResultSchema = z.object({
  overallPass: z.boolean(),
  confidenceScore: z.number().min(0).max(1),
  stageResults: z.array(EnkryptStageResultSchema),
  groupALatencyMs: z.number(),
  groupBLatencyMs: z.number(),
  groupCLatencyMs: z.number(),
  totalLatencyMs: z.number(),
  flags: z.array(z.string()),
  routeToHitl: z.boolean(),
  hitlReason: z.string().optional(),
  safeOutput: z.string().optional(),
});

export type EnkryptValidationResult = z.infer<typeof EnkryptValidationResultSchema>;

// ─── HITL ─────────────────────────────────────────────────────────────────────

export const HitlDecisionSchema = z.enum(["approve", "reject", "edit"]);

export const HitlQueueItemSchema = z.object({
  id: UUIDSchema,
  contractId: UUIDSchema,
  orgId: UUIDSchema,
  clauseIndex: z.number(),
  originalClause: z.string(),
  aiSuggestion: z.string(),
  riskReason: z.string(),
  retrievedSources: z.array(RetrievedItemSchema),
  enkryptResult: EnkryptValidationResultSchema,
  createdAt: z.string().datetime(),
  slaDeadline: z.string().datetime(),
  status: z.enum(["pending", "in_review", "decided"]).default("pending"),
});

export const HitlDecisionRequestSchema = z.object({
  itemId: UUIDSchema,
  reviewerId: UUIDSchema,
  decision: HitlDecisionSchema,
  editedText: z.string().optional(),  // required if decision === "edit"
  reviewerNotes: z.string().optional(),
});

export type HitlQueueItem = z.infer<typeof HitlQueueItemSchema>;
export type HitlDecisionRequest = z.infer<typeof HitlDecisionRequestSchema>;

// ─── Full Analysis Report ─────────────────────────────────────────────────────

export const AnalysisReportSchema = z.object({
  reportId: UUIDSchema,
  contractId: UUIDSchema,
  orgId: UUIDSchema,
  generatedAt: z.string().datetime(),
  executiveSummary: z.string(),
  clauseBreakdown: z.array(
    z.object({
      clauseIndex: z.number(),
      clauseType: ClauseTypeSchema,
      clauseText: z.string(),
      overallRisk: RiskSeveritySchema,
      risks: z.array(RiskItemSchema),
      rewrites: z.array(RewriteVersionSchema),
      benchmarkScore: z.number().optional(),
      benchmarkPercentile: z.number().optional(),
      complianceFlags: z.array(z.string()).default([]),
      enkryptConfidence: z.number(),
      hitlStatus: z.enum(["not_required", "pending", "approved", "rejected"]),
    })
  ),
  totalClauses: z.number(),
  criticalCount: z.number(),
  moderateCount: z.number(),
  lowCount: z.number(),
  overallRisk: RiskSeveritySchema,
  jurisdictionFlags: z.array(z.string()),
  exportFormats: z.array(z.enum(["pdf", "json"])),
  traceId: z.string(),
});

export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;

// ─── API Request/Response ─────────────────────────────────────────────────────

export const ContractUploadRequestSchema = z.object({
  orgId: UUIDSchema,
  jurisdiction: z.string().optional(),
  priority: z.enum(["standard", "urgent"]).default("standard"),
});

export const ContractUploadResponseSchema = z.object({
  contractId: UUIDSchema,
  status: z.enum(["queued", "processing"]),
  estimatedCompletionMs: z.number(),
  workflowId: z.string(),
});

export const QARequestSchema = z.object({
  contractId: UUIDSchema,
  orgId: UUIDSchema,
  question: z.string().min(1).max(2000),
  sessionId: UUIDSchema.optional(),
});

export const QAResponseSchema = z.object({
  answer: z.string(),
  citations: z.array(z.string()),
  readabilityScore: z.number(),
  enkryptConfidence: z.number(),
  sessionId: UUIDSchema,
  requiresHitl: z.boolean(),
});

export type ContractUploadRequest = z.infer<typeof ContractUploadRequestSchema>;
export type ContractUploadResponse = z.infer<typeof ContractUploadResponseSchema>;
export type QARequest = z.infer<typeof QARequestSchema>;
export type QAResponse = z.infer<typeof QAResponseSchema>;
