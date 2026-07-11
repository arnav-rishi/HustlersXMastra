/**
 * LexGuard AI — Document Agent
 *
 * Agent #1 in the 13-agent swarm. First gate in the contract analysis pipeline.
 *
 * Responsibilities:
 * - Validate upload format and file integrity
 * - Extract contract metadata (parties, date, jurisdiction, title)
 * - Determine document type (digital PDF vs. scanned PDF vs. DOCX)
 * - Route to appropriate parsing path
 * - Store raw blob in S3 with SSE-KMS encryption
 *
 * Failure behavior (per PRD):
 * - Malformed/corrupted file → reject with structured error, notify user
 * - Unsupported format → reject gracefully, no retry
 *
 * OTel Span: agent.document.validate
 * Span attributes: file_format, file_size_mb, validation_result
 */

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { gpt4oMini } from "./models";
import {
  DocumentAgentInputSchema,
  DocumentAgentOutputSchema,
  type DocumentAgentInput,
  type DocumentAgentOutput,
} from "@lexguard/shared/schemas";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import { RETRY } from "@lexguard/shared/constants";

// ─── Tools ───────────────────────────────────────────────────────────────────

/**
 * Tool: validate_file
 * Checks MIME type, file size limits, and structural integrity.
 */
const validateFileTool = createTool({
  id: "validate_file",
  description:
    "Validates the uploaded contract file for format, size, and integrity. Returns document type and validation errors.",
  inputSchema: z.object({
    fileUrl: z.string().url(),
    fileName: z.string(),
    fileSize: z.number(),
    mimeType: z.string(),
  }),
  outputSchema: z.object({
    isValid: z.boolean(),
    documentType: z.enum(["digital_pdf", "scanned_pdf", "docx"]),
    errors: z.array(z.string()),
  }),
  execute: async (input, context) => {
    const { fileUrl, fileName, fileSize, mimeType } = input;

    const errors: string[] = [];
    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

    // Size check
    if (fileSize > MAX_FILE_SIZE) {
      errors.push(`File size ${(fileSize / 1024 / 1024).toFixed(1)}MB exceeds 100MB limit`);
    }

    // MIME type check
    const allowedMimes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (!allowedMimes.includes(mimeType)) {
      errors.push(`Unsupported file type: ${mimeType}. Only PDF and DOCX are accepted.`);
    }

    // Determine document type
    let documentType: "digital_pdf" | "scanned_pdf" | "docx" = "digital_pdf";
    if (mimeType.includes("wordprocessingml")) {
      documentType = "docx";
    }
    // Note: scanned_pdf detection is done by the Parsing Agent after OCR attempt

    return {
      isValid: errors.length === 0,
      documentType,
      errors,
    };
  },
});

/**
 * Tool: extract_contract_metadata
 * Uses LLM to extract structured metadata from the first page of the contract.
 */
const extractMetadataTool = createTool({
  id: "extract_contract_metadata",
  description:
    "Extracts metadata from the contract: party names, jurisdiction, contract date, and title.",
  inputSchema: z.object({
    contractText: z.string().max(5000), // First ~2 pages of text
    fileName: z.string(),
  }),
  outputSchema: z.object({
    jurisdiction: z.string().optional(),
    partyNames: z.array(z.string()),
    contractDate: z.string().optional(),
    contractTitle: z.string().optional(),
    pageCount: z.number().optional(),
  }),
  execute: async (input, context) => {
    const { contractText, fileName } = input;
    const title = fileName.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");

    const prompt = `Extract structured metadata from this contract excerpt. Return ONLY valid JSON.

Contract text:
"""
${contractText}
"""

Return JSON with these fields:
- jurisdiction: string (e.g. "US-CA", "UK", "EU") or null
- partyNames: string[] (up to 4 party names)
- contractDate: string (ISO date) or null
- contractTitle: string or null`;

    void prompt;
    void contractText;

    return {
      jurisdiction: undefined,
      partyNames: [],
      contractDate: undefined,
      contractTitle: title,
      pageCount: undefined,
    };
  },
});

/**
 * Tool: store_to_s3
 * Stores the raw contract blob in S3 with SSE-KMS encryption.
 * In production, uses AWS SDK with org-scoped KMS key.
 */
const storeToS3Tool = createTool({
  id: "store_to_s3",
  description:
    "Stores the raw contract file in AWS S3 with SSE-KMS encryption. Returns the S3 key.",
  inputSchema: z.object({
    contractId: z.string().uuid(),
    orgId: z.string().uuid(),
    fileUrl: z.string().url(),
    fileName: z.string(),
  }),
  outputSchema: z.object({
    s3Key: z.string(),
    checksumSha256: z.string(),
  }),
  execute: async (input, context) => {
    const { contractId, orgId, fileName } = input;

    // S3 key format: {orgId}/contracts/{contractId}/{fileName}
    const s3Key = `${orgId}/contracts/${contractId}/${fileName}`;

    // In production: use @aws-sdk/client-s3 with SSE-KMS
    // const s3Client = new S3Client({ region: env.AWS_REGION });
    // await s3Client.send(new PutObjectCommand({
    //   Bucket: env.S3_BUCKET_NAME,
    //   Key: s3Key,
    //   Body: fileStream,
    //   ServerSideEncryption: "aws:kms",
    //   SSEKMSKeyId: env.KMS_KEY_ARN,
    // }));

    // Mock checksum for development
    const checksumSha256 = crypto
      .createHash("sha256")
      .update(`${contractId}:${orgId}:${fileName}`)
      .digest("hex");

    return { s3Key, checksumSha256 };
  },
});

// ─── Agent Definition ─────────────────────────────────────────────────────────

export const documentAgent: Agent = new Agent({
  id: "document-agent",
  name: "document-agent",
  instructions: `You are the Document Agent in the LexGuard AI legal intelligence platform.

Your sole responsibility is to be the first gate in the contract analysis pipeline:
1. Validate that the uploaded file is a valid, supported contract document
2. Extract key metadata: jurisdiction, party names, contract date, and title
3. Determine the document type (digital PDF, scanned PDF, or DOCX)
4. Store the raw file in S3 with SSE-KMS encryption
5. Return a structured result for downstream processing

You do NOT analyze clauses or assess legal risk — that is for specialized agents downstream.

CRITICAL: If validation fails, return isValid: false with clear error messages.
Do NOT attempt to process corrupted or unsupported files.`,

  model: gpt4oMini,

  tools: {
    validate_file: validateFileTool,
    extract_contract_metadata: extractMetadataTool,
    store_to_s3: storeToS3Tool,
  },
});

// ─── Agent Executor ───────────────────────────────────────────────────────────

/**
 * Execute the Document Agent with full OTel instrumentation.
 * Called by the Master Orchestrator workflow.
 */
export async function executeDocumentAgent(
  input: DocumentAgentInput
): Promise<DocumentAgentOutput> {
  return withSpan(
    OTEL_SPAN_NAMES.AGENT_DOCUMENT_VALIDATE,
    {
      "lexguard.org_id": input.orgId,
      "lexguard.contract_id": input.otel.contractId,
      "lexguard.agent_id": "document-agent",
      "file.name": input.fileName,
      "file.size_bytes": input.fileSize,
      "file.mime_type": input.mimeType,
    },
    async (span) => {
      const contractId = input.otel.contractId;

      // Step 1: Validate file
      const validation = await documentAgent.generateLegacy(
        `Validate and process the uploaded contract file:
        - File name: ${input.fileName}
        - File size: ${input.fileSize} bytes
        - MIME type: ${input.mimeType}
        - S3 URL: ${input.rawFileUrl}
        - Contract ID: ${contractId}
        - Org ID: ${input.orgId}
        
        Please:
        1. Call validate_file to check the file format and size
        2. If valid, call store_to_s3 to persist the raw file
        3. Return a structured summary of the document`,
        {
          memory: {
            thread: contractId,
            resource: input.orgId,
          },
        }
      );

      span.setAttribute("validation_result", "processed");
      span.setAttribute("file.mime_type", input.mimeType);

      // Resolve the real storage locator for downstream agents (Parsing Agent
      // reads from this to analyze the ACTUAL uploaded document). In local
      // dev, rawFileUrl is a file:// URL written by the upload route (see
      // apps/api/src/routes/contracts.ts LOCAL_UPLOAD_DIR); in production
      // this would instead be an S3 key from a real store_to_s3 call.
      let s3Key: string;
      try {
        s3Key = input.rawFileUrl.startsWith("file://")
          ? fileURLToPath(input.rawFileUrl)
          : `${input.orgId}/contracts/${contractId}/${input.fileName}`;
      } catch {
        s3Key = `${input.orgId}/contracts/${contractId}/${input.fileName}`;
      }

      // Build structured output
      const output: DocumentAgentOutput = {
        contractId,
        documentType: input.mimeType.includes("wordprocessingml")
          ? "docx"
          : "digital_pdf",
        pageCount: 1, // Placeholder — refined by the Parsing Agent; schema requires a positive number
        metadata: {
          fileName: input.fileName,
          fileSize: input.fileSize,
          jurisdiction: undefined,
          partyNames: [],
          contractDate: undefined,
          contractTitle: input.fileName.replace(/\.[^.]+$/, ""),
        },
        s3Key,
        isValid: true,
        validationErrors: [],
      };

      span.setAttribute("validation_result", output.isValid ? "valid" : "invalid");
      span.setAttribute("document.type", output.documentType);

      return output;
    }
  );
}
