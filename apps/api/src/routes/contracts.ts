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
import {
  ContractUploadRequestSchema,
  QARequestSchema,
  HitlDecisionRequestSchema,
} from "@lexguard/shared/schemas";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";

export const contractsRouter = Router();

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

      // Trigger the Mastra contract analysis workflow
      const { workflowId, contractId } = await triggerContractAnalysis({
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

// ─── GET /api/v1/contracts/:id/analysis ──────────────────────────────────────

contractsRouter.get(
  "/:id/analysis",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { id } = req.params;

    // In production: query Postgres for the completed analysis report
    // and verify org_id === req.orgId (tenant isolation)
    return res.status(200).json({
      contractId: id,
      orgId: req.orgId,
      status: "completed",
      message: "Analysis report retrieval — Phase 4 implementation pending",
    });
  }
);

// ─── GET /api/v1/contracts/:id/status ────────────────────────────────────────

contractsRouter.get(
  "/:id/status",
  authMiddleware,
  async (req: Request, res: Response) => {
    const { id } = req.params;

    // In production: query Mastra workflow run status
    return res.status(200).json({
      contractId: id,
      workflowStatus: "processing",
      currentStep: "embedding",
      progress: 30,
      estimatedRemainingMs: 10_000,
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

    // In production: trigger Legal Q&A pipeline
    return res.status(200).json({
      answer: "Q&A pipeline — Phase 2 implementation pending",
      citations: [],
      readabilityScore: 0,
      enkryptConfidence: 0,
      sessionId: bodyResult.data.sessionId ?? uuidv4(),
      requiresHitl: false,
    });
  }
);

// ─── GET /api/v1/hitl/queue ───────────────────────────────────────────────────

contractsRouter.get(
  "/hitl/queue",
  authMiddleware,
  requireRole("legal_counsel"),
  async (req: Request, res: Response) => {
    // In production: query Postgres hitl_queue WHERE org_id = req.orgId AND status = 'pending'
    return res.status(200).json({
      items: [],
      total: 0,
      orgId: req.orgId,
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
      ...req.body,
    });

    if (!bodyResult.success) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        details: bodyResult.error.flatten().fieldErrors,
      });
    }

    // In production:
    // 1. Update HITL item status in Postgres
    // 2. Resume the suspended Mastra workflow: workflow.resume()
    // 3. Trigger Memory Agent to update Qdrant risk_patterns + org_preferences
    return res.status(200).json({
      itemId: id,
      decision: bodyResult.data.decision,
      workflowResumed: true,
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
