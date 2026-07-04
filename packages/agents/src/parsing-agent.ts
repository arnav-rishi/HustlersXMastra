/**
 * LexGuard AI — Parsing Agent
 *
 * Agent #2 in the 13-agent swarm.
 *
 * Responsibilities:
 * - OCR extraction for scanned PDFs (Tesseract fallback)
 * - Structural extraction: clause boundaries, headers, definitions
 * - Assigns bounding box coordinates per clause
 * - Flags clauses with OCR confidence < 0.90 for HITL review
 * - Reports per-clause OCR confidence scores
 *
 * Failure behavior (per PRD):
 * - OCR confidence < 0.90 → flag document for HITL queue entry
 * - Complete OCR failure → fallback to raw text extraction; still flags
 *
 * Key tools:
 * - Unstructured.io (digital PDF structured extraction)
 * - Tesseract OCR (scanned PDF fallback)
 * - Layout parser (bounding box extraction)
 *
 * OTel Span: agent.parsing.execute
 * Span attributes: ocr_engine, ocr_confidence, page_count, clause_count
 * Alert: ocr_confidence < 0.90
 */

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  type ParsingAgentInput,
  type ParsingAgentOutput,
  type ExtractedClause,
  ExtractedClauseSchema,
} from "@lexguard/shared/schemas";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import { OCR_MIN_CONFIDENCE, CLAUSE_TYPES } from "@lexguard/shared/constants";

// ─── Tools ───────────────────────────────────────────────────────────────────

/**
 * Tool: extract_digital_pdf
 * Uses Unstructured.io to extract structured elements from digital PDFs.
 * Returns clause-level chunks with metadata.
 */
const extractDigitalPdfTool = createTool({
  id: "extract_digital_pdf",
  description:
    "Extracts structured elements (clauses, headers, definitions) from a digital PDF using Unstructured.io.",
  inputSchema: z.object({
    s3Key: z.string(),
    contractId: z.string().uuid(),
  }),
  outputSchema: z.object({
    clauses: z.array(ExtractedClauseSchema),
    pageCount: z.number(),
    ocrConfidence: z.number().min(0).max(1),
    engine: z.literal("unstructured"),
  }),
  execute: async ({ context }) => {
    const { s3Key, contractId } = context;

    // In production:
    // const client = new UnstructuredClient({ serverURL: process.env.UNSTRUCTURED_URL });
    // const elements = await client.general.partition({ files: ... });
    //
    // For now, return a mock structured response for development scaffolding.
    // The mock simulates a 5-clause contract (indemnification, limitation_of_liability, etc.)

    const mockClauses: ExtractedClause[] = [
      {
        clauseIndex: 0,
        clauseType: "indemnification",
        clauseText:
          "Party A shall indemnify, defend, and hold harmless Party B from and against any and all claims, damages, losses, costs, and expenses (including attorneys' fees) arising out of or relating to Party A's performance under this Agreement, without limitation.",
        pageNumber: 3,
        boundingBox: { x: 72, y: 320, w: 540, h: 90 },
        ocrConfidence: 1.0,
        characterCount: 285,
      },
      {
        clauseIndex: 1,
        clauseType: "limitation_of_liability",
        clauseText:
          "IN NO EVENT SHALL EITHER PARTY BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES, HOWEVER CAUSED.",
        pageNumber: 4,
        boundingBox: { x: 72, y: 140, w: 540, h: 60 },
        ocrConfidence: 1.0,
        characterCount: 163,
      },
      {
        clauseIndex: 2,
        clauseType: "auto_renewal",
        clauseText:
          "This Agreement shall automatically renew for successive one-year terms unless either party provides written notice of non-renewal.",
        pageNumber: 1,
        boundingBox: { x: 72, y: 580, w: 540, h: 50 },
        ocrConfidence: 1.0,
        characterCount: 143,
      },
      {
        clauseIndex: 3,
        clauseType: "confidentiality",
        clauseText:
          "Each party agrees to hold the other party's Confidential Information in strict confidence and to use such Confidential Information only for purposes of this Agreement.",
        pageNumber: 5,
        boundingBox: { x: 72, y: 240, w: 540, h: 70 },
        ocrConfidence: 1.0,
        characterCount: 192,
      },
      {
        clauseIndex: 4,
        clauseType: "data_processing",
        clauseText:
          "Party A may collect, process, and store personal data of Party B's customers as necessary to provide the Services described herein.",
        pageNumber: 6,
        boundingBox: { x: 72, y: 420, w: 540, h: 55 },
        ocrConfidence: 1.0,
        characterCount: 154,
      },
    ];

    return {
      clauses: mockClauses,
      pageCount: 8,
      ocrConfidence: 1.0,
      engine: "unstructured" as const,
    };
  },
});

/**
 * Tool: extract_scanned_pdf
 * Uses Tesseract OCR for scanned PDFs.
 * Reports per-page confidence scores.
 */
const extractScannedPdfTool = createTool({
  id: "extract_scanned_pdf",
  description:
    "Extracts text from a scanned PDF using Tesseract OCR. Returns clauses with per-element confidence scores.",
  inputSchema: z.object({
    s3Key: z.string(),
    contractId: z.string().uuid(),
  }),
  outputSchema: z.object({
    clauses: z.array(ExtractedClauseSchema),
    pageCount: z.number(),
    ocrConfidence: z.number().min(0).max(1),
    engine: z.literal("tesseract"),
    rawTextFallback: z.boolean(),
  }),
  execute: async ({ context }) => {
    const { s3Key } = context;

    // In production:
    // Use node-tesseract-ocr or python-bridge to Tesseract
    // const text = await tesseract.recognize(imageBuffer, "eng", { logger: ... });
    // const confidence = text.data.confidence / 100;

    // Mock: simulate a scanned PDF with slightly lower confidence
    const mockConfidence = 0.87; // Below OCR_MIN_CONFIDENCE threshold
    const rawTextFallback = mockConfidence < 0.50;

    return {
      clauses: [],  // In practice, parsed from OCR output
      pageCount: 6,
      ocrConfidence: mockConfidence,
      engine: "tesseract" as const,
      rawTextFallback,
    };
  },
});

/**
 * Tool: identify_clause_boundaries
 * Post-processes extracted text to identify precise clause boundaries
 * using structural signals (numbered sections, headers, whitespace patterns).
 */
const identifyClauseBoundariesTool = createTool({
  id: "identify_clause_boundaries",
  description:
    "Identifies clause boundaries within extracted text using layout heuristics and section numbering patterns.",
  inputSchema: z.object({
    rawText: z.string(),
    pageCount: z.number(),
  }),
  outputSchema: z.object({
    clauses: z.array(ExtractedClauseSchema),
    totalClauses: z.number(),
  }),
  execute: async ({ context }) => {
    const { rawText } = context;

    // In production: use a combination of:
    // 1. Regex patterns for numbered sections (e.g., "5. INDEMNIFICATION")
    // 2. Semantic boundary detection via lightweight classifier
    // 3. Layout parser for visual boundary cues

    // For now: split by double newlines as a simple heuristic
    const paragraphs = rawText
      .split(/\n\n+/)
      .filter((p) => p.trim().length > 50);

    const clauses: ExtractedClause[] = paragraphs
      .slice(0, 20) // Cap at 20 clauses for mock
      .map((text, i) => ({
        clauseIndex: i,
        clauseType: null,
        clauseText: text.trim(),
        pageNumber: Math.floor(i / 3) + 1,
        ocrConfidence: 0.95,
        characterCount: text.length,
      }));

    return {
      clauses,
      totalClauses: clauses.length,
    };
  },
});

// ─── Agent Definition ─────────────────────────────────────────────────────────

export const parsingAgent = new Agent({
  name: "parsing-agent",
  instructions: `You are the Parsing Agent in the LexGuard AI legal intelligence platform.

Your responsibility is to extract structured clause-level content from uploaded contracts.

You work in two modes:
1. **Digital PDF**: Use extract_digital_pdf for machine-readable PDFs
2. **Scanned PDF**: Use extract_scanned_pdf with Tesseract OCR

IMPORTANT RULES:
- If OCR confidence is below ${OCR_MIN_CONFIDENCE * 100}%, set flaggedForHitl = true in your output
- If OCR fails completely (confidence < 50%), use identify_clause_boundaries on whatever text was extracted
- Always report the exact OCR confidence score — never round up
- Preserve bounding box coordinates for every clause when available
- Return ALL clauses found, even short or unclear ones (let downstream agents assess them)

Do NOT perform legal analysis — only extract and structure the raw text.`,

  model: {
    provider: "OPEN_AI",
    name: "gpt-4o",
    toolChoice: "required",
  },

  tools: {
    extract_digital_pdf: extractDigitalPdfTool,
    extract_scanned_pdf: extractScannedPdfTool,
    identify_clause_boundaries: identifyClauseBoundariesTool,
  },
});

// ─── Agent Executor ───────────────────────────────────────────────────────────

export async function executeParsingAgent(
  input: ParsingAgentInput
): Promise<ParsingAgentOutput> {
  return withSpan(
    OTEL_SPAN_NAMES.AGENT_PARSING_EXECUTE,
    {
      "lexguard.org_id": input.orgId,
      "lexguard.contract_id": input.contractId,
      "lexguard.agent_id": "parsing-agent",
      "document.type": input.documentType,
      "document.s3_key": input.s3Key,
    },
    async (span) => {
      const startTime = Date.now();
      const isScanned = input.documentType === "scanned_pdf";

      const toolChoice = isScanned
        ? `Use extract_scanned_pdf for s3Key: "${input.s3Key}", contractId: "${input.contractId}"`
        : `Use extract_digital_pdf for s3Key: "${input.s3Key}", contractId: "${input.contractId}"`;

      const result = await parsingAgent.generate(
        `Parse the contract document and extract all clause-level content.
         Document type: ${input.documentType}
         S3 Key: ${input.s3Key}
         Contract ID: ${input.contractId}
         ${toolChoice}`,
        {
          threadId: input.contractId,
          resourceId: input.orgId,
        }
      );

      // For now, use the digital PDF tool directly in executor
      const extractResult = await extractDigitalPdfTool.execute({
        context: { s3Key: input.s3Key, contractId: input.contractId },
      } as any);

      const output: ParsingAgentOutput = {
        contractId: input.contractId,
        clauses: extractResult.clauses,
        totalClauses: extractResult.clauses.length,
        overallOcrConfidence: extractResult.ocrConfidence,
        parseLatencyMs: Date.now() - startTime,
        flaggedForHitl: extractResult.ocrConfidence < OCR_MIN_CONFIDENCE,
        rawTextFallback: false,
      };

      // OTel attributes per PRD Appendix C
      span.setAttribute("ocr_engine", extractResult.engine ?? "unstructured");
      span.setAttribute("ocr_confidence", output.overallOcrConfidence);
      span.setAttribute("page_count", extractResult.pageCount);
      span.setAttribute("clause_count", output.totalClauses);
      span.setAttribute("flagged_for_hitl", output.flaggedForHitl);

      if (output.flaggedForHitl) {
        console.warn(
          `[LexGuard][ParsingAgent] OCR confidence ${output.overallOcrConfidence} < threshold ${OCR_MIN_CONFIDENCE} for contract ${input.contractId}. Flagging for HITL.`
        );
      }

      return output;
    }
  );
}
