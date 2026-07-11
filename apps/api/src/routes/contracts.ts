/**
 * LexGuard AI — Contract Routes
 *
 * REST API routes for contract operations per PRD v2.0 Section 12.1.
 *
 * Endpoints:
 *   POST   /api/v1/contracts/upload          - Upload and trigger analysis
 *   GET    /api/v1/contracts/:id/analysis    - Retrieve analysis report
 *   GET    /api/v1/contracts/:id/status      - Workflow execution status
 *   POST   /api/v1/contracts/qa              - Legal Q&A
 *   GET    /api/v1/contracts/hitl/queue      - HITL review queue
 *   GET    /api/v1/contracts/hitl/:id        - HITL review item detail
 *   POST   /api/v1/contracts/hitl/:id/decision - Submit HITL decision
 *   DELETE /api/v1/gdpr/erase/:orgId         - GDPR erasure
 *   GET    /api/v1/audit/trace/:traceId      - OTel trace retrieval
 *
 * All endpoints require:
 *   Authorization: Bearer <JWT_RS256>
 *   X-Tenant-ID: <org_id>
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import type { Router as ExpressRouter } from "express";
import multer from "multer";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import os from "os";
import { pathToFileURL } from "url";
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
import { getEnv } from "@lexguard/shared/env";

export const contractsRouter: ExpressRouter = Router();
const prisma = new PrismaClient();

// Local dev storage shim: in production, contract files upload to S3 with
// SSE-KMS (see store_to_s3 in document-agent.ts). Locally, there's no S3, so
// we persist the real uploaded bytes to a temp directory and pass a file://
// URL through the pipeline — this is what lets the Parsing Agent read and
// analyze the ACTUAL uploaded document instead of mock data.
const LOCAL_UPLOAD_DIR = path.join(os.tmpdir(), "lexguard-uploads");

// Wraps an async route handler so a rejected promise (e.g. a Prisma error from
// a malformed :id) is forwarded to Express's error middleware instead of
// crashing the process as an unhandled rejection.
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

function getDocumentTypeFromMime(mimeType: string): "DIGITAL_PDF" | "SCANNED_PDF" | "DOCX" {
  if (mimeType.includes("wordprocessingml")) {
    return "DOCX";
  }
  return "DIGITAL_PDF";
}

async function createQueuedContract(params: {
  id: string;
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
      id: params.id,
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
        payload: params.payload as any,
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
  "/contracts/upload",
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

      // In production: upload file buffer to S3, get pre-signed URL.
      // Locally: persist the real bytes to disk so downstream agents can
      // actually read and analyze the uploaded document (see LOCAL_UPLOAD_DIR
      // comment above) instead of operating on hardcoded mock content.
      const contractId = uuidv4();
      const localDir = path.join(LOCAL_UPLOAD_DIR, req.orgId!, contractId);
      fs.mkdirSync(localDir, { recursive: true });
      const localFilePath = path.join(localDir, req.file.originalname);
      fs.writeFileSync(localFilePath, req.file.buffer);

      const s3Key = localFilePath;
      const rawFileUrl = pathToFileURL(localFilePath).href;

      const createdContract = await createQueuedContract({
        id: contractId,
        orgId: req.orgId!,
        uploadedBy: req.user!.sub,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        jurisdiction: bodyResult.data.jurisdiction,
        s3Key,
      });

      // Trigger the Mastra contract analysis workflow
      const { workflowId } = await triggerContractAnalysis({
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
  "/contracts/analyze",
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
  "/contracts/:id/analysis",
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
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
  })
);

contractsRouter.get(
  "/contracts/:id/report",
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
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
  })
);

// ─── GET /api/v1/contracts/:id/status ────────────────────────────────────────

contractsRouter.get(
  "/contracts/:id/status",
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
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
      updatedAt: ((contract.completedAt ?? contract.createdAt) ?? new Date()).toISOString(),
    });
  })
);

// ─── POST /api/v1/contracts/qa ────────────────────────────────────────────────

contractsRouter.post(
  "/contracts/qa",
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

contractsRouter.get("/contracts/pending", authMiddleware, async (req: Request, res: Response) => {
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
      items: pendingContracts.map((contract: any) => ({
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

// ─── GET /api/v1/contracts (repository — all statuses, searchable) ───────────

const ContractsListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
  status: z.string().optional(),
  search: z.string().optional(),
});

contractsRouter.get(
  "/contracts",
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const query = ContractsListQuerySchema.parse(req.query);
    const skip = (query.page - 1) * query.pageSize;

    const where: Prisma.ContractWhereInput = { orgId: req.orgId };
    if (query.status) {
      where.status = query.status.toUpperCase() as any;
    }
    if (query.search) {
      where.fileName = { contains: query.search, mode: "insensitive" };
    }

    const [items, total] = await Promise.all([
      prisma.contract.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: query.pageSize,
        skip,
        select: {
          id: true,
          fileName: true,
          documentType: true,
          status: true,
          overallRisk: true,
          jurisdiction: true,
          createdAt: true,
          completedAt: true,
        },
      }),
      prisma.contract.count({ where }),
    ]);

    return res.status(200).json({
      items: items.map((contract) => ({
        id: contract.id,
        name: contract.fileName,
        type: contract.documentType,
        status: contract.status.toLowerCase(),
        risk: contract.overallRisk?.toLowerCase() ?? "unknown",
        jurisdiction: contract.jurisdiction ?? "Unknown",
        date: contract.createdAt.toISOString().slice(0, 10),
        completedAt: contract.completedAt,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  })
);

// ─── GET /api/v1/analytics/summary ────────────────────────────────────────────

contractsRouter.get(
  "/analytics/summary",
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = req.orgId;

    const [totalContracts, statusGroups, riskGroups, hitlPending, hitlDecided, completedContracts] =
      await Promise.all([
        prisma.contract.count({ where: { orgId } }),
        prisma.contract.groupBy({ by: ["status"], where: { orgId }, _count: true }),
        prisma.contract.groupBy({
          by: ["overallRisk"],
          where: { orgId, overallRisk: { not: null } },
          _count: true,
        }),
        prisma.hitlQueueItem.count({ where: { orgId, status: "PENDING" } }),
        prisma.hitlQueueItem.count({ where: { orgId, status: "DECIDED" } }),
        prisma.contract.findMany({
          where: { orgId, status: "COMPLETED" },
          select: { analysisJson: true, createdAt: true, completedAt: true },
        }),
      ]);

    const statusCounts: Record<string, number> = {};
    for (const g of statusGroups) statusCounts[g.status.toLowerCase()] = g._count;

    const riskCounts: Record<string, number> = { critical: 0, moderate: 0, low: 0 };
    for (const g of riskGroups) {
      if (g.overallRisk) riskCounts[g.overallRisk.toLowerCase()] = g._count;
    }

    let compliantCount = 0;
    let totalLatencyMs = 0;
    let latencySamples = 0;
    for (const c of completedContracts) {
      const analysis = c.analysisJson as any;
      const flags = Array.isArray(analysis?.jurisdictionFlags) ? analysis.jurisdictionFlags : [];
      if (flags.length === 0) compliantCount++;
      if (c.completedAt && c.createdAt) {
        totalLatencyMs += c.completedAt.getTime() - c.createdAt.getTime();
        latencySamples++;
      }
    }
    const complianceRate =
      completedContracts.length > 0 ? (compliantCount / completedContracts.length) * 100 : null;
    const avgProcessingMs = latencySamples > 0 ? Math.round(totalLatencyMs / latencySamples) : null;

    return res.status(200).json({
      totalContracts,
      statusCounts,
      riskCounts,
      hitl: { pending: hitlPending, decided: hitlDecided },
      complianceRatePct: complianceRate === null ? null : Math.round(complianceRate * 10) / 10,
      avgProcessingMs,
      completedCount: completedContracts.length,
    });
  })
);

// ─── GET /api/v1/contracts/hitl/queue ─────────────────────────────────────────

contractsRouter.get(
  "/contracts/hitl/queue",
  authMiddleware,
  requireRole("legal_counsel"),
  asyncHandler(async (req: Request, res: Response) => {
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
      items: items.map((item: any) => ({
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
  })
);

contractsRouter.get(
  "/contracts/hitl/:id",
  authMiddleware,
  requireRole("legal_counsel"),
  asyncHandler(async (req: Request, res: Response) => {
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
  })
);

// ─── POST /api/v1/contracts/hitl/:id/decision ─────────────────────────────────

contractsRouter.post(
  "/contracts/hitl/:id/decision",
  authMiddleware,
  requireRole("legal_counsel"),
  asyncHandler(async (req: Request, res: Response) => {
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
  })
);

// ─── DELETE /api/v1/gdpr/erase/:orgId ────────────────────────────────────────

contractsRouter.delete(
  "/gdpr/erase/:orgId",
  authMiddleware,
  requireRole("compliance_officer"),
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId } = req.params;

    // Security: only the org itself (or a super-admin) can request erasure
    if (orgId !== req.orgId) {
      return res.status(403).json({
        error: "FORBIDDEN",
        message: "Cannot request erasure for another organization",
      });
    }

    // Not implemented in local dev (no S3 / Qdrant Cloud credentials scoped
    // for destructive ops here): S3 object deletion and Qdrant delete_by_filter
    // across the 8 collections. Postgres erasure below IS real.
    const deletionRequest = await prisma.deletionRequest.create({
      data: {
        orgId,
        requestedBy: req.user!.sub,
        status: "IN_PROGRESS",
      },
    });

    try {
      // hitl_queue.contract_id is ON DELETE RESTRICT, so those rows must be
      // cleared before contracts can be deleted. audit_logs.contract_id is
      // ON DELETE SET NULL, so audit history is retained (7-year compliance
      // retention) even after the contract itself is erased.
      const hitlDeleted = await prisma.hitlQueueItem.deleteMany({ where: { orgId } });
      const contractsDeleted = await prisma.contract.deleteMany({ where: { orgId } });
      const pgRowsDeleted = hitlDeleted.count + contractsDeleted.count;

      await prisma.deletionRequest.update({
        where: { id: deletionRequest.id },
        data: { status: "PARTIAL", pgRowsDeleted, completedAt: new Date() },
      });

      await createAuditLog({
        orgId,
        traceId: req.traceId,
        agentId: "gdpr-service",
        eventType: "gdpr_erasure_completed",
        payload: { deletionRequestId: deletionRequest.id, pgRowsDeleted },
      });

      return res.status(202).json({
        orgId,
        status: "erasure_initiated",
        slaHours: 24,
        message:
          "GDPR erasure: Postgres contract/HITL data erased immediately. " +
          "S3 object deletion and Qdrant delete_by_filter are not implemented in local dev.",
        deletionRequestId: deletionRequest.id,
        pgRowsDeleted,
      });
    } catch (err) {
      await prisma.deletionRequest.update({
        where: { id: deletionRequest.id },
        data: { status: "FAILED", errorMessage: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  })
);

// ─── GET /api/v1/audit/trace/:traceId ────────────────────────────────────────

contractsRouter.get(
  "/audit/trace/:traceId",
  authMiddleware,
  requireRole("legal_operations"),
  asyncHandler(async (req: Request, res: Response) => {
    const { traceId } = req.params;

    // Postgres audit log lookup is real. Jaeger span retrieval (the
    // OTel/distributed-tracing half of this endpoint) is not implemented —
    // would require an HTTP call to the Jaeger Query API for this traceId.
    const auditLog = await prisma.auditLog.findMany({
      where: { traceId, orgId: req.orgId },
      orderBy: { timestamp: "asc" },
    });

    return res.status(200).json({
      traceId,
      spans: [],
      spansNote: "Jaeger span retrieval not implemented in local dev — see http://localhost:16686 to inspect this trace directly.",
      auditLog,
    });
  })
);

// ─── GET /api/v1/contracts/:id/metrics ───────────────────────────────────────
// Returns per-stage workflow timing rows for readiness dashboarding.

contractsRouter.get(
  "/contracts/:id/metrics",
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
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
  })
);

// ─── GET /api/v1/settings ─────────────────────────────────────────────────────

contractsRouter.get(
  "/settings",
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const env = getEnv();

    const organization = await prisma.organization.findUnique({
      where: { id: req.orgId },
      select: {
        id: true,
        name: true,
        email: true,
        plan: true,
        awsRegion: true,
        citationLimit: true,
        rateLimitRpm: true,
        createdAt: true,
      },
    });

    if (!organization) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Organization not found",
      });
    }

    return res.status(200).json({
      organization,
      user: {
        id: req.user?.sub,
        email: req.user?.email,
        roles: req.user?.roles ?? [],
      },
      featureFlags: {
        enkryptEnabled: env.ENKRYPT_ENABLED,
        lexisNexisEnabled: env.LEXISNEXIS_ENABLED,
        hitlEnabled: env.HITL_ENABLED,
      },
      azure: {
        chatDeployment: env.AZURE_OPENAI_DEPLOYMENT,
        chatDeploymentMini: env.AZURE_OPENAI_DEPLOYMENT_MINI || env.AZURE_OPENAI_DEPLOYMENT,
        embeddingDeploymentConfigured: Boolean(env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT),
      },
    });
  })
);
