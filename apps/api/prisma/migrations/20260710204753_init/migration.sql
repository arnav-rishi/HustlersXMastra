-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('STARTER', 'PROFESSIONAL', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('GENERAL_COUNSEL', 'LEGAL_OPERATIONS', 'LEGAL_ANALYST', 'COMPLIANCE_OFFICER', 'PROCUREMENT', 'SALES', 'ADMIN');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('DIGITAL_PDF', 'SCANNED_PDF', 'DOCX');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('QUEUED', 'PROCESSING', 'HITL_REQUIRED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('CRITICAL', 'MODERATE', 'LOW');

-- CreateEnum
CREATE TYPE "HitlReason" AS ENUM ('ENKRYPT_CONFIDENCE_LOW', 'OCR_CONFIDENCE_LOW', 'HALLUCINATED_CITATION', 'TOXICITY_DETECTED', 'PROMPT_INJECTION', 'CONFLICTING_CLAUSES', 'JURISDICTION_UNVERIFIED');

-- CreateEnum
CREATE TYPE "HitlStatus" AS ENUM ('PENDING', 'IN_REVIEW', 'DECIDED');

-- CreateEnum
CREATE TYPE "HitlDecision" AS ENUM ('APPROVE', 'REJECT', 'EDIT');

-- CreateEnum
CREATE TYPE "DeletionStatus" AS ENUM ('INITIATED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'PARTIAL');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'STARTER',
    "aws_region" TEXT NOT NULL DEFAULT 'us-east-1',
    "citation_limit" INTEGER NOT NULL DEFAULT 1000,
    "rate_limit_rpm" INTEGER NOT NULL DEFAULT 100,
    "consent_timestamp" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "display_name" VARCHAR(255) NOT NULL,
    "roles" "UserRole"[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "file_name" VARCHAR(500) NOT NULL,
    "file_size" BIGINT NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "document_type" "DocumentType" NOT NULL,
    "s3_key" VARCHAR(1000) NOT NULL,
    "jurisdiction" VARCHAR(50),
    "status" "ContractStatus" NOT NULL DEFAULT 'QUEUED',
    "workflow_id" UUID,
    "workflow_status" VARCHAR(50) NOT NULL DEFAULT 'queued',
    "workflow_step" VARCHAR(100),
    "progress_pct" INTEGER NOT NULL DEFAULT 0,
    "page_count" INTEGER,
    "party_names" TEXT[],
    "contract_date" TIMESTAMP(3),
    "contract_title" VARCHAR(500),
    "overall_risk" "RiskLevel",
    "report_id" UUID,
    "analysis_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clauses" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "clause_index" INTEGER NOT NULL,
    "clause_type" VARCHAR(100),
    "clause_text" TEXT NOT NULL,
    "risk_level" "RiskLevel",
    "risk_score" INTEGER,
    "rewrite_option_a" TEXT,
    "rewrite_option_b" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clauses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "trace_id" VARCHAR(64) NOT NULL,
    "span_id" VARCHAR(32) NOT NULL,
    "org_id" UUID NOT NULL,
    "contract_id" UUID,
    "agent_id" VARCHAR(100) NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "prompt_hash" VARCHAR(64),
    "model_version" VARCHAR(50),
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "latency_ms" INTEGER,
    "enkrypt_pass" BOOLEAN,
    "confidence_score" DOUBLE PRECISION,
    "hitl_triggered" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hitl_queue" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "clause_index" INTEGER NOT NULL,
    "reason" "HitlReason" NOT NULL,
    "original_clause" TEXT NOT NULL,
    "ai_suggestion" TEXT,
    "risk_reason" TEXT,
    "enkrypt_flags" TEXT[],
    "confidence_score" DOUBLE PRECISION,
    "status" "HitlStatus" NOT NULL DEFAULT 'PENDING',
    "reviewer_id" UUID,
    "decision" "HitlDecision",
    "edited_text" TEXT,
    "reviewer_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sla_deadline" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "hitl_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_requests" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "status" "DeletionStatus" NOT NULL DEFAULT 'INITIATED',
    "s3_objects_deleted" INTEGER NOT NULL DEFAULT 0,
    "pg_rows_deleted" INTEGER NOT NULL DEFAULT 0,
    "qdrant_points_deleted" INTEGER NOT NULL DEFAULT 0,
    "initiated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "error_message" TEXT,

    CONSTRAINT "deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_stage_metrics" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "workflow_id" VARCHAR(64) NOT NULL,
    "stage_name" VARCHAR(100) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "duration_ms" INTEGER,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_stage_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_email_key" ON "organizations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_org_id_idx" ON "users"("org_id");

-- CreateIndex
CREATE INDEX "contracts_org_id_idx" ON "contracts"("org_id");

-- CreateIndex
CREATE INDEX "contracts_status_idx" ON "contracts"("status");

-- CreateIndex
CREATE INDEX "contracts_created_at_idx" ON "contracts"("created_at");

-- CreateIndex
CREATE INDEX "clauses_contract_id_idx" ON "clauses"("contract_id");

-- CreateIndex
CREATE INDEX "clauses_clause_index_idx" ON "clauses"("clause_index");

-- CreateIndex
CREATE INDEX "audit_logs_org_id_idx" ON "audit_logs"("org_id");

-- CreateIndex
CREATE INDEX "audit_logs_trace_id_idx" ON "audit_logs"("trace_id");

-- CreateIndex
CREATE INDEX "audit_logs_contract_id_idx" ON "audit_logs"("contract_id");

-- CreateIndex
CREATE INDEX "audit_logs_timestamp_idx" ON "audit_logs"("timestamp");

-- CreateIndex
CREATE INDEX "hitl_queue_org_id_idx" ON "hitl_queue"("org_id");

-- CreateIndex
CREATE INDEX "hitl_queue_status_idx" ON "hitl_queue"("status");

-- CreateIndex
CREATE INDEX "hitl_queue_contract_id_idx" ON "hitl_queue"("contract_id");

-- CreateIndex
CREATE INDEX "deletion_requests_org_id_idx" ON "deletion_requests"("org_id");

-- CreateIndex
CREATE INDEX "deletion_requests_status_idx" ON "deletion_requests"("status");

-- CreateIndex
CREATE INDEX "workflow_stage_metrics_contract_id_idx" ON "workflow_stage_metrics"("contract_id");

-- CreateIndex
CREATE INDEX "workflow_stage_metrics_workflow_id_idx" ON "workflow_stage_metrics"("workflow_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clauses" ADD CONSTRAINT "clauses_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hitl_queue" ADD CONSTRAINT "hitl_queue_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hitl_queue" ADD CONSTRAINT "hitl_queue_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hitl_queue" ADD CONSTRAINT "hitl_queue_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_stage_metrics" ADD CONSTRAINT "workflow_stage_metrics_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
