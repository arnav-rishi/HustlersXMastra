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
import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { gpt4o } from "./models";
import {
  type ParsingAgentInput,
  type ParsingAgentOutput,
  type ExtractedClause,
  ExtractedClauseSchema,
} from "@lexguard/shared/schemas";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import { OCR_MIN_CONFIDENCE, CLAUSE_TYPES } from "@lexguard/shared/constants";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Splits raw extracted contract text into clause-level chunks.
 * Real contracts are almost always numbered ("1. Indemnification", "Section 3:"),
 * so we primarily split on numbered/lettered section headers at the start of a
 * line. If no such headers are found (e.g. an unstructured document), we fall
 * back to blank-line paragraph breaks, and finally to fixed-size chunking so we
 * never return the whole document as a single unusable "clause".
 */
function splitIntoClauses(rawText: string): string[] {
  const lines = rawText.split(/\r?\n/);
  const headerRe =
    /^\s*(?:\d{1,2}(?:\.\d+)?[.)]\s+[A-Z][A-Za-z0-9 ,/&'()-]{2,80}|SECTION\s+\d+\b.*|ARTICLE\s+[IVXLC0-9]+\b.*)\s*$/;

  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (headerRe.test(line) && current.length > 0) {
      sections.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current);

  let clauses = sections
    .map((s) => s.join("\n").trim())
    .filter((c) => c.length > 40);

  if (clauses.length < 2) {
    clauses = rawText
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 40);
  }

  if (clauses.length < 2 && rawText.trim().length > 0) {
    const chunkSize = 800;
    clauses = [];
    for (let i = 0; i < rawText.length; i += chunkSize) {
      const chunk = rawText.slice(i, i + chunkSize).trim();
      if (chunk.length > 0) clauses.push(chunk);
    }
  }

  return clauses.slice(0, 40); // sane cap per contract
}

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
  execute: async (input, context) => {
    const { s3Key } = input;

    // In production, this would call Unstructured.io:
    //   const client = new UnstructuredClient({ serverURL: process.env.UNSTRUCTURED_URL });
    //   const elements = await client.general.partition({ files: ... });
    //
    // Locally, s3Key is a real filesystem path (see document-agent.ts / the
    // upload route's LOCAL_UPLOAD_DIR shim), so we read and parse the actual
    // uploaded file here — PDF via pdf-parse, DOCX via mammoth — and split it
    // into clause-level chunks. clauseType is left null; the Classification
    // Agent (#4) is responsible for assigning real clause types downstream.
    try {
      const buffer = fs.readFileSync(s3Key);
      const ext = path.extname(s3Key).toLowerCase();

      let rawText: string;
      let pageCount: number;

      if (ext === ".docx" || ext === ".doc") {
        const result = await mammoth.extractRawText({ buffer });
        rawText = result.value;
        pageCount = Math.max(1, Math.ceil(rawText.split(/\s+/).length / 500));
      } else {
        const parsed = await pdfParse(buffer);
        rawText = parsed.text;
        pageCount = Math.max(1, parsed.numpages || 1);
      }

      const chunks = splitIntoClauses(rawText);

      const clauses: ExtractedClause[] = chunks.map((text, i) => ({
        clauseIndex: i,
        clauseType: null,
        clauseText: text,
        pageNumber: Math.min(pageCount, Math.floor(i / 4) + 1),
        ocrConfidence: 1.0,
        characterCount: text.length,
      }));

      return {
        clauses,
        pageCount,
        ocrConfidence: 1.0,
        engine: "unstructured" as const,
      };
    } catch (err) {
      console.error(
        `[LexGuard][ParsingAgent] Failed to read/extract file at "${s3Key}":`,
        err
      );
      // Fail safe rather than crashing the workflow. ocrConfidence: 0 causes
      // flaggedForHitl to be set downstream so a human reviews the failure.
      return {
        clauses: [],
        pageCount: 1,
        ocrConfidence: 0,
        engine: "unstructured" as const,
      };
    }
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
  execute: async (input, context) => {
    const { s3Key } = input;

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
  execute: async (input, context) => {
    const { rawText } = input;

    // In production: use a combination of:
    // 1. Regex patterns for numbered sections (e.g., "5. INDEMNIFICATION")
    // 2. Semantic boundary detection via lightweight classifier
    // 3. Layout parser for visual boundary cues

    // Junk lines commonly introduced by PDF/print text extraction (page
    // footers, timestamps, file paths) rather than real clause content.
    const isJunkLine = (line: string): boolean =>
      /^\s*(\d{1,2}\/\d{1,2}\/\d{2,4}[,]?\s*\d{1,2}:\d{2}|file:\/\/|https?:\/\/|page \d+|\d+\s*\/\s*\d+)\s*$/i.test(
        line.trim()
      );

    // Try paragraph-level splitting first (blank-line-separated text, e.g.
    // plain-text uploads or well-formatted extractions).
    let segments = rawText
      .split(/\n\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 50 && !isJunkLine(p));

    // Real-world PDF text extraction frequently collapses paragraph breaks to
    // single newlines with no blank line between them. If double-newline
    // splitting produced too few segments to be meaningful, fall back to
    // single-newline splitting instead.
    if (segments.length < 2) {
      segments = rawText
        .split(/\n+/)
        .map((p) => p.trim())
        .filter((p) => p.length > 50 && !isJunkLine(p));
    }

    const clauses: ExtractedClause[] = segments
      .slice(0, 20) // Cap at 20 clauses
      .map((text, i) => ({
        clauseIndex: i,
        clauseType: null,
        clauseText: text,
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

export const parsingAgent: Agent = new Agent({
  id: "parsing-agent",
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

  model: gpt4o,

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
      const hasRealText = Boolean(input.rawText && input.rawText.trim().length > 0);

      let clauses: ExtractedClause[];
      let overallOcrConfidence: number;
      let engine: string;
      let pageCount: number;

      // Drive the agent for real via generateLegacy() rather than calling the
      // tools directly — this is what produces genuine Mastra AGENT_RUN/
      // TOOL_CALL spans. Which tool to call is already deterministic (which
      // extraction path applies isn't something to leave to model judgment),
      // so toolChoice targets the exact tool by name — same reliable pattern
      // used in memory-agent.ts, avoiding the non-determinism risk seen with
      // generic "required" tool choice on multi-tool agents.
      if (hasRealText) {
        // Real path: segment the actual contract text into clauses. No OCR was
        // involved (text was provided directly), so confidence is 1.0.
        const rawText = input.rawText as string;
        pageCount = Math.max(1, Math.ceil(rawText.length / 3000));
        const result = await parsingAgent.generateLegacy(
          `Identify clause boundaries in this extracted contract text (page count: ${pageCount}). Call identify_clause_boundaries with the full raw text.\n\nRAW TEXT:\n${rawText}`,
          {
            toolChoice: { type: "tool", toolName: "identify_clause_boundaries" },
            maxSteps: 1,
          }
        );
        const boundaries = (result.steps?.[0]?.toolResults ?? result.toolResults ?? [])
          .find((t: any) => t.toolName === "identify_clause_boundaries")?.result as
          | { clauses: ExtractedClause[]; totalClauses: number }
          | undefined;
        clauses = boundaries?.clauses ?? [];
        overallOcrConfidence = 1.0;
        engine = "text";
      } else {
        // Fallback: no text was provided (e.g. real S3/OCR pipeline not wired
        // up for this upload path). Use the mock extractor so the pipeline
        // still completes, but flag it clearly rather than pretending it's real.
        const isScanned = input.documentType === "scanned_pdf";
        const toolName = isScanned ? "extract_scanned_pdf" : "extract_digital_pdf";
        const result = await parsingAgent.generateLegacy(
          `Extract clauses from this ${isScanned ? "scanned" : "digital"} PDF. Call ${toolName} with s3Key "${input.s3Key}" and contractId "${input.contractId}".`,
          {
            toolChoice: { type: "tool", toolName },
            maxSteps: 1,
          }
        );
        const extractResult = (result.steps?.[0]?.toolResults ?? result.toolResults ?? [])
          .find((t: any) => t.toolName === toolName)?.result as
          | { clauses: ExtractedClause[]; pageCount: number; ocrConfidence: number; engine: string }
          | undefined;
        clauses = extractResult?.clauses ?? [];
        overallOcrConfidence = extractResult?.ocrConfidence ?? 0;
        engine = extractResult?.engine ?? "mock";
        pageCount = extractResult?.pageCount ?? 1;
        console.warn(
          `[LexGuard][ParsingAgent] No rawText provided for contract ${input.contractId} — falling back to mock clause extractor.`
        );
      }

      const output: ParsingAgentOutput = {
        contractId: input.contractId,
        clauses,
        totalClauses: clauses.length,
        overallOcrConfidence,
        parseLatencyMs: Date.now() - startTime,
        flaggedForHitl: overallOcrConfidence < OCR_MIN_CONFIDENCE,
        rawTextFallback: !hasRealText,
      };

      // OTel attributes per PRD Appendix C
      span.setAttribute("ocr_engine", engine);
      span.setAttribute("ocr_confidence", output.overallOcrConfidence);
      span.setAttribute("page_count", pageCount);
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
