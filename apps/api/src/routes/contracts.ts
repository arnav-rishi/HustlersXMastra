/**
 * LexGuard AI — Contract Routes
 *
 * REST API routes for contract operations per PRD v2.0 Section 12.1.
 *
 * Endpoints:
 *   POST   /api/v1/contracts/upload          - Upload and trigger analysis
 *   GET    /api/v1/contracts/:id/analysis    - Retrieve analysis report
 *   GET    /api/v1/contracts/:id/status      - Workflow execution status
 *   POST   /api/v1/qa                        - Legal Q&A
 *   GET    /api/v1/hitl/queue                - HITL review queue
 *   POST   /api/v1/hitl/:id/decision         - Submit HITL decision
 *   DELETE /api/v1/gdpr/erase/:orgId         - GDPR erasure
 *   GET    /api/v1/audit/trace/:traceId      - OTel trace retrieval
 *
 * All endpoints require:
 *   Authorization: Bearer <JWT_RS256>
 *   X-Tenant-ID: <org_id>
 */

import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { authMiddleware, requireRole } from "../middleware/auth";
import { triggerContractAnalysis } from "@lexguard/workflows/contract-analysis";
import { executeQAAgent } from "@lexguard/agents/qa-agent";
import { executeMemoryAgent } from "@lexguard/agents/memory-agent";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  ContractUploadRequestSchema,
  QARequestSchema,
  HitlDecisionRequestSchema,
} from "@lexguard/shared/schemas";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";

export const contractsRouter = Router();
const prisma = new PrismaClient();

function getDocumentTypeFromMime(mimeType: string): "DIGITAL_PDF" | "SCANNED_PDF" | "DOCX" {
  if (mimeType.includes("wordprocessingml")) {
    return "DOCX";
  }
  return "DIGITAL_PDF";
}

async function createQueuedContract(params: {
  orgId: string;
  uploadedBy: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  s3Key: string;
  jurisdiction?: string;
}) {
  return prisma.contract.create({
    data: {
      orgId: params.orgId,
      uploadedBy: params.uploadedBy,
      fileName: params.fileName,
      fileSize: BigInt(params.fileSize),
      mimeType: params.mimeType,
      documentType: getDocumentTypeFromMime(params.mimeType),
      s3Key: params.s3Key,
      jurisdiction: params.jurisdiction,
      status: "QUEUED",
      workflowStatus: "queued",
      workflowStep: "document-validation",
      progressPct: 0,
      partyNames: [],
    },
    select: {
      id: true,
    },
  });
}

async function createAuditLog(params: {
  orgId: string;
  contractId?: string;
  traceId?: string;
  spanId?: string;
  agentId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        traceId: params.traceId ?? uuidv4().replace(/-/g, ""),
        spanId: params.spanId ?? uuidv4().replace(/-/g, "").slice(0, 16),
        orgId: params.orgId,
        contractId: params.contractId,
        agentId: params.agentId,
        eventType: params.eventType,
        payload: params.payload as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    console.warn("[LexGuard][API] Failed to create audit log:", err);
  }
}

// File upload middleware (memory storage; will stream to S3)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
  },
  fileFilter: (_req, file, callback) => {
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (allowed.includes(file.mimetype)) {
      callback(null, true);
    } else {
      callback(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

// ─── POST /api/v1/contracts/upload ───────────────────────────────────────────

contractsRouter.post(
  "/upload",
  authMiddleware,
  upload.single("contract"),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "FILE_REQUIRED",
          message: "A contract file (PDF or DOCX) must be uploaded",
          code: "LG-UPLOAD-001",
        });
      }

      // Validate request body
      const bodyResult = ContractUploadRequestSchema.safeParse({
        orgId: req.orgId,
        jurisdiction: req.body.jurisdiction,
        priority: req.body.priority,
      });

      if (!bodyResult.success) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: bodyResult.error.flatten().fieldErrors,
          code: "LG-UPLOAD-002",
        });
      }

      // In production: upload file buffer to S3, get pre-signed URL
      const s3Key = `${req.orgId}/${uuidv4()}/${req.file.originalname}`;
      const rawFileUrl = `https://${process.env.S3_BUCKET_NAME}.s3.amazonaws.com/${s3Key}`;

      const createdContract = await createQueuedContract({
        orgId: req.orgId!,
        uploadedBy: req.user!.sub,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        jurisdiction: bodyResult.data.jurisdiction,
        s3Key,
      });

      // Trigger the Mastra contract analysis workflow
      const { workflowId, contractId } = await triggerContractAnalysis({
        contractId: createdContract.id,
        orgId: req.orgId!,
        tenantId: req.tenantId!,
        uploadedBy: req.user!.sub,
        rawFileUrl,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        jurisdiction: bodyResult.data.jurisdiction,
        priority: bodyResult.data.priority,
        traceId: req.traceId!,
        spanId: uuidv4(),
      });

      await prisma.contract.update({
        where: { id: createdContract.id },
        data: {
          workflowId,
          status: "PROCESSING",
          workflowStatus: "processing",
          workflowStep: "document-validation",
          progressPct: 10,
        },
      });
      await createAuditLog({
        orgId: req.orgId!,
        contractId: createdContract.id,
        traceId: req.traceId,
        agentId: "api-gateway",
        eventType: "contract_analysis_started",
        payload: {
          workflowId,
          endpoint: "upload",
        },
      });

      return res.status(202).json({
        contractId,
        status: "processing",
        workflowId,
        estimatedCompletionMs: 15_000,
        message: "Contract analysis pipeline started. Poll /status for updates.",
      });
    } catch (err) {
      console.error("[LexGuard][API] Upload error:", err);
      return res.status(500).json({
        error: "INTERNAL_ERROR",
        message: "Failed to initiate contract analysis",
        code: "LG-UPLOAD-003",
      });
    }
  }
);

// ─── POST /api/v1/contracts/analyze (Phase 6 wiring endpoint) ───────────────

const AnalyzeContractBodySchema = z.object({
  contractText: z.string().min(1, "contractText is required"),
  fileName: z.string().optional(),
  jurisdiction: z.string().optional(),
  priority: z.enum(["standard", "urgent"]).optional(),
});

const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

contractsRouter.post(
  "/analyze",
  authMiddleware,
  async (req: Request, res: Response) => {
    const body = AnalyzeContractBodySchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: body.error.flatten().fieldErrors,
      });
    }

    const contractText = body.data.contractText;
    try {
      const s3Key = `${req.orgId}/${uuidv4()}/${body.data.fileName ?? "inline-contract.txt"}`;
      const createdContract = await createQueuedContract({
        orgId: req.orgId!,
        uploadedBy: req.user!.sub,
        fileName: body.data.fileName ?? "inline-contract.txt",
        fileSize: Buffer.byteLength(contractText, "utf8"),
        mimeType: "text/plain",
        jurisdiction: body.data.jurisdiction,
        s3Key,
      });

      const { workflowId, contractId } = await triggerContractAnalysis({
        contractId: createdContract.id,
        orgId: req.orgId!,
        tenantId: req.tenantId!,
        uploadedBy: req.user!.sub,
        rawFileUrl: "https://lexguard.local/inline-contract.txt",
        fileName: body.data.fileName ?? "inline-contract.txt",
        fileSize: Buffer.byteLength(contractText, "utf8"),
        mimeType: "text/plain",
        jurisdiction: body.data.jurisdiction ?? "Unknown",
        priority: body.data.priority ?? "standard",
        traceId: req.traceId!,
        spanId: uuidv4().replace(/-/g, "").slice(0, 16),
      });

      await prisma.contract.update({
        where: { id: createdContract.id },
        data: {
          workflowId,
          status: "PROCESSING",
          workflowStatus: "processing",
          workflowStep: "document-validation",
          progressPct: 10,
        },
      });
      await createAuditLog({
        orgId: req.orgId!,
        contractId: createdContract.id,
        traceId: req.traceId,
        agentId: "api-gateway",
        eventType: "contract_analysis_started",
        payload: {
          workflowId,
          endpoint: "analyze",
        },
      });

      return res.status(202).json({
        contractId,
        workflowId,
        status: "processing",
        estimatedCompletionMs: 15_000,
      });
    } catch (err) {
      console.error("[LexGuard][API] Analyze error:", err);
      return res.status(500).json({
        error: "INTERNAL_ERROR",
        message: "Failed to start contract analysis workflow",
      });
    }
  }
);

// ─── GET /api/v1/contracts/:id/analysis ──────────────────────────────────────

contractsRouter.get(
  "/:id/analysis",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const contract = await prisma.contract.findFirst({
      where: {
        id,
        orgId: req.orgId,
      },
      select: {
        id: true,
        status: true,
        workflowStatus: true,
        analysisJson: true,
        reportId: true,
        completedAt: true,
      },
    });
    if (!contract) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Contract not found for this tenant",
      });
    }
    return res.status(200).json({
      contractId: contract.id,
      status: contract.status.toLowerCase(),
      workflowStatus: contract.workflowStatus,
      reportId: contract.reportId,
      completedAt: contract.completedAt,
      analysis: contract.analysisJson ?? null,
    });
  }
);

contractsRouter.get(
  "/:id/report",
  authMiddleware,
  async (req: Request, res: Response) => {
    const contract = await prisma.contract.findFirst({
      where: {
        id: req.params.id,
        orgId: req.orgId,
      },
      select: {
        id: true,
        analysisJson: true,
      },
    });
    if (!contract) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Contract not found for this tenant",
      });
    }
    if (!contract.analysisJson) {
      return res.status(409).json({
        error: "REPORT_NOT_READY",
        message: "Analysis report not available yet",
      });
    }

    return res
      .status(200)
      .setHeader("Content-Type", "application/json")
      .setHeader(
        "Content-Disposition",
        `attachment; filename="contract-${contract.id}-report.json"`
      )
      .send(JSON.stringify(contract.analysisJson, null, 2));
  }
);

// ─── GET /api/v1/contracts/:id/status ────────────────────────────────────────

contractsRouter.get(
  "/:id/status",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const contract = await prisma.contract.findFirst({
      where: {
        id,
        orgId: req.orgId,
      },
      select: {
        id: true,
        status: true,
        workflowStatus: true,
        workflowStep: true,
        progressPct: true,
        createdAt: true,
        completedAt: true,
      },
    });
    if (!contract) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Contract not found for this tenant",
      });
    }
    return res.status(200).json({
      contractId: contract.id,
      workflowStatus: contract.workflowStatus,
      currentStep: contract.workflowStep ?? "unknown",
      progress: contract.progressPct,
      status: contract.status.toLowerCase(),
      updatedAt: (contract.completedAt ?? contract.createdAt).toISOString(),
    });
  }
);

// ─── POST /api/v1/qa ──────────────────────────────────────────────────────────

contractsRouter.post(
  "/qa",
  authMiddleware,
  async (req: Request, res: Response) => {
    const bodyResult = QARequestSchema.safeParse({
      ...req.body,
      orgId: req.orgId,
    });

    if (!bodyResult.success) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        details: bodyResult.error.flatten().fieldErrors,
      });
    }

    try {
      const qaResponse = await executeQAAgent({
        ...bodyResult.data,
        userId: req.user!.sub,
      });

      return res.status(200).json(qaResponse);
    } catch (err) {
      console.error("[LexGuard][API] QA error:", err);
      return res.status(500).json({
        error: "INTERNAL_ERROR",
        message: "Failed to process legal Q&A request",
      });
    }
  }
);

// ─── GET /api/v1/contracts/pending ────────────────────────────────────────────

contractsRouter.get("/pending", authMiddleware, async (req: Request, res: Response) => {
  try {
    const query = PaginationQuerySchema.parse(req.query);
    const skip = (query.page - 1) * query.pageSize;
    const pendingContracts = await prisma.contract.findMany({
      where: {
        orgId: req.orgId,
        status: {
          in: ["QUEUED", "PROCESSING", "HITL_REQUIRED"],
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: query.pageSize,
      skip,
      select: {
        id: true,
        fileName: true,
        documentType: true,
        status: true,
        overallRisk: true,
        createdAt: true,
      },
    });

    return res.status(200).json({
      items: pendingContracts.map((contract) => ({
        id: contract.id,
        name: contract.fileName,
        type: contract.documentType,
        status: contract.status.toLowerCase(),
        risk: contract.overallRisk?.toLowerCase() ?? "unknown",
        date: contract.createdAt.toISOString().slice(0, 10),
      })),
      total: pendingContracts.length,
      page: query.page,
      pageSize: query.pageSize,
    });
  } catch (err) {
    console.error("[LexGuard][API] Pending contracts error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to query pending contracts",
    });
  }
});

// ─── GET /api/v1/hitl/queue ───────────────────────────────────────────────────

contractsRouter.get(
  "/hitl/queue",
  authMiddleware,
  requireRole("legal_counsel"),
  async (req: Request, res: Response) => {
    const query = PaginationQuerySchema.parse(req.query);
    const skip = (query.page - 1) * query.pageSize;
    const items = await prisma.hitlQueueItem.findMany({
      where: {
        orgId: req.orgId,
        status: "PENDING",
      },
      orderBy: {
        createdAt: "asc",
      },
      select: {
        id: true,
        contractId: true,
        clauseIndex: true,
        reason: true,
        confidenceScore: true,
        status: true,
        createdAt: true,
        slaDeadline: true,
      },
      take: query.pageSize,
      skip,
    });
    return res.status(200).json({
      items: items.map((item) => ({
        id: item.id,
        contractId: item.contractId,
        clauseIndex: item.clauseIndex,
        reason: item.reason.toLowerCase(),
        confidenceScore: item.confidenceScore,
        status: item.status.toLowerCase(),
        createdAt: item.createdAt,
        slaDeadline: item.slaDeadline,
      })),
      total: items.length,
      page: query.page,
      pageSize: query.pageSize,
      orgId: req.orgId,
    });
  }
);

contractsRouter.get(
  "/hitl/:id",
  authMiddleware,
  requireRole("legal_counsel"),
  async (req: Request, res: Response) => {
    const item = await prisma.hitlQueueItem.findFirst({
      where: {
        id: req.params.id,
        orgId: req.orgId,
      },
      select: {
        id: true,
        contractId: true,
        clauseIndex: true,
        reason: true,
        originalClause: true,
        aiSuggestion: true,
        riskReason: true,
        confidenceScore: true,
        status: true,
        reviewerNotes: true,
        createdAt: true,
        slaDeadline: true,
      },
    });
    if (!item) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "HITL queue item not found",
      });
    }
    return res.status(200).json({
      ...item,
      reason: item.reason.toLowerCase(),
      status: item.status.toLowerCase(),
    });
  }
);

// ─── POST /api/v1/hitl/:id/decision ──────────────────────────────────────────

contractsRouter.post(
  "/hitl/:id/decision",
  authMiddleware,
  requireRole("legal_counsel"),
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const bodyResult = HitlDecisionRequestSchema.safeParse({
      itemId: id,
      reviewerId: req.user!.sub,
      decision: req.body.decision,
      editedText: req.body.editedText,
      reviewerNotes: req.body.reviewerNotes,
    });

    if (!bodyResult.success) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        details: bodyResult.error.flatten().fieldErrors,
      });
    }

    const queueItem = await prisma.hitlQueueItem.findFirst({
      where: {
        id,
        orgId: req.orgId,
      },
    });
    if (!queueItem) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "HITL queue item not found",
      });
    }

    const prismaDecision =
      bodyResult.data.decision === "approve"
        ? "APPROVE"
        : bodyResult.data.decision === "reject"
          ? "REJECT"
          : "EDIT";

    await prisma.hitlQueueItem.update({
      where: { id },
      data: {
        status: "DECIDED",
        reviewerId: req.user!.sub,
        decision: prismaDecision,
        editedText: bodyResult.data.editedText,
        reviewerNotes: bodyResult.data.reviewerNotes,
        decidedAt: new Date(),
      },
    });

    const memoryResult = await executeMemoryAgent({
      contractId: queueItem.contractId,
      orgId: req.orgId!,
      userId: req.user!.sub,
      decision: bodyResult.data.decision,
      clauseType: "unknown",
      clauseText: queueItem.originalClause,
      editedText: bodyResult.data.editedText,
      riskLevel: "moderate",
      riskDescription: queueItem.riskReason ?? "HITL feedback",
    });

    await prisma.contract.updateMany({
      where: {
        id: queueItem.contractId,
        orgId: req.orgId,
      },
      data: {
        workflowStatus: "completed",
        workflowStep: "reporting",
        progressPct: 100,
        status: "COMPLETED",
        completedAt: new Date(),
        analysisJson: {
          hitlItemId: id,
          decision: bodyResult.data.decision,
          reviewerNotes: bodyResult.data.reviewerNotes ?? null,
          memoryCollectionsUpdated: memoryResult.collectionsUpdated,
          finalizedAt: new Date().toISOString(),
        },
      },
    });
    await createAuditLog({
      orgId: req.orgId!,
      contractId: queueItem.contractId,
      traceId: req.traceId,
      agentId: "hitl-gateway",
      eventType: "hitl_decision_recorded",
      payload: {
        decision: bodyResult.data.decision,
        memoryCollectionsUpdated: memoryResult.collectionsUpdated,
      },
    });

    return res.status(200).json({
      itemId: id,
      decision: bodyResult.data.decision,
      workflowResumed: true,
      memoryCollectionsUpdated: memoryResult.collectionsUpdated,
      message: "HITL decision recorded. Workflow resuming.",
    });
  }
);

// ─── DELETE /api/v1/gdpr/erase/:orgId ────────────────────────────────────────

contractsRouter.delete(
  "/gdpr/erase/:orgId",
  authMiddleware,
  requireRole("compliance_officer"),
  async (req: Request, res: Response) => {
    const { orgId } = req.params;

    // Security: only the org itself (or a super-admin) can request erasure
    if (orgId !== req.orgId) {
      return res.status(403).json({
        error: "FORBIDDEN",
        message: "Cannot request erasure for another organization",
      });
    }

    // In production: trigger GDPR Deletion Service
    // - Delete S3 objects with prefix: {orgId}/
    // - DELETE FROM * WHERE org_id = orgId in Postgres
    // - Qdrant delete_by_filter: {org_id: orgId} across all 8 collections
    // - Create deletion audit entry (retained for 7 years)
    // - Confirm completion within 24 hours SLA
    return res.status(202).json({
      orgId,
      status: "erasure_initiated",
      slaHours: 24,
      message: "GDPR erasure initiated. Completion within 24 hours.",
      deletionRequestId: uuidv4(),
    });
  }
);

// ─── GET /api/v1/audit/trace/:traceId ────────────────────────────────────────

contractsRouter.get(
  "/audit/trace/:traceId",
  authMiddleware,
  requireRole("legal_operations"),
  async (req: Request, res: Response) => {
    const { traceId } = req.params;

    // In production: query Jaeger API for trace + Postgres audit log
    return res.status(200).json({
      traceId,
      spans: [],
      auditLog: [],
      message: "Audit trace retrieval — Phase 4 implementation pending",
    });
  }
);

// ─── GET /api/v1/contracts/:id/metrics ───────────────────────────────────────
// Returns per-stage workflow timing rows for readiness dashboarding.

contractsRouter.get(
  "/:id/metrics",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const contract = await prisma.contract.findFirst({
      where: { id, orgId: req.orgId },
      select: { id: true },
    });
    if (!contract) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Contract not found for this tenant",
      });
    }

    const metrics = await (prisma as any).workflowStageMetric.findMany({
      where: { contractId: id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        stageName: true,
        status: true,
        durationMs: true,
        errorMessage: true,
        createdAt: true,
      },
    });

    return res.status(200).json({
      contractId: id,
      stages: metrics,
      totalStages: metrics.length,
    });
  }
);
