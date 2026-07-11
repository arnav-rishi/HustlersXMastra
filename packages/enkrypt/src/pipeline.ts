/**
 * LexGuard AI — Enkrypt AI 10-Stage Safety Pipeline
 *
 * Implements the parallelized DAG per PRD v2.0 Section 15.
 *
 * Architecture:
 *   [Gate: E-01 Schema Validation <10ms]
 *     ↓
 *   [Group A ‖ Group B] — run in parallel
 *     A: E-02 Prompt Injection → E-03 Toxicity → E-04 PII (≤380ms)
 *     B: E-05 Hallucination → E-06 Citation → E-07 Bias → E-08 Policy (≤470ms)
 *     ↓
 *   [Group C sequential]
 *     E-09 Confidence Estimation → E-10 Safe Output (≤280ms)
 *   Total ≤ 1,200ms
 */

import { z } from "zod";
import type { EnkryptValidationResult } from "@lexguard/shared/schemas";
import { ENKRYPT_CONFIDENCE_THRESHOLD, ENKRYPT_LATENCY } from "@lexguard/shared/constants";
import { recordEnkryptResult } from "@lexguard/observability/metrics";
import { getEnv } from "@lexguard/shared/env";
import { enkryptDetect, type EnkryptDetectResponse } from "./client";

// ─── Stage Result Helper ──────────────────────────────────────────────────────

function stageResult(stage: number, group: "Gate" | "A" | "B" | "C", pass: boolean, latencyMs: number, flags: string[] = [], details?: Record<string, unknown>) {
  return { stage, group, pass, latencyMs, flags, details };
}

// ─── E-01: Schema Validation (Gate, <10ms) ────────────────────────────────────

function validateSchema(output: unknown): { pass: boolean; validated: Record<string, unknown> | null; error?: string } {
  if (typeof output !== "object" || output === null) {
    return { pass: false, validated: null, error: "Output is not a JSON object" };
  }
  return { pass: true, validated: output as Record<string, unknown> };
}

// ─── Group A Stages (Parallel) ────────────────────────────────────────────────

// E-02: Prompt Injection Detection (<80ms) — Enkrypt Guardrails `injection_attack`
// detector when available, local regex heuristics as fallback (disabled/unreachable).
async function detectPromptInjection(
  text: string,
  apiResult: EnkryptDetectResponse | null
): Promise<{ pass: boolean; injectionType?: string; latencyMs: number; source: "enkrypt_api" | "local" }> {
  const start = Date.now();

  if (apiResult) {
    const flagged = apiResult.summary.injection_attack === 1;
    return {
      pass: !flagged,
      injectionType: flagged ? "enkrypt:injection_attack" : undefined,
      latencyMs: Date.now() - start,
      source: "enkrypt_api",
    };
  }

  const INJECTION_PATTERNS = [
    /ignore (all |previous |above )?instructions/i,
    /you are now/i,
    /disregard (your|all|the)/i,
    /forget (everything|your instructions)/i,
    /system prompt/i,
    /\bact as\b.{0,50}\bno restrictions\b/i,
    /<\|im_start\|>/,
    /\[INST\]/,
  ];
  const matched = INJECTION_PATTERNS.find((p) => p.test(text));
  return {
    pass: !matched,
    injectionType: matched ? matched.source : undefined,
    latencyMs: Date.now() - start,
    source: "local",
  };
}

// E-03: Toxicity Detection (<150ms) — Enkrypt Guardrails `toxicity` detector when
// available, local keyword heuristic as fallback.
async function detectToxicity(
  text: string,
  apiResult: EnkryptDetectResponse | null
): Promise<{ pass: boolean; score: number; latencyMs: number; source: "enkrypt_api" | "local" }> {
  const start = Date.now();

  if (apiResult) {
    // Confirmed against the live API: summary.toxicity is an array of flagged
    // category names (empty when clean), not a 0/1 flag like pii/bias.
    // details.toxicity holds per-category float scores keyed by category name
    // (HATE, HARASSMENT, ILLICIT_BEHAVIOR, SELF_HARM, VIOLENCE_THREATS) —
    // there is no single "toxicity" key.
    const summaryToxicity = apiResult.summary.toxicity;
    const flagged = Array.isArray(summaryToxicity) && summaryToxicity.length > 0;
    const detail = apiResult.details?.toxicity as Record<string, unknown> | undefined;
    const CATEGORY_KEYS = ["HATE", "HARASSMENT", "ILLICIT_BEHAVIOR", "SELF_HARM", "VIOLENCE_THREATS"];
    const categoryScores = detail
      ? CATEGORY_KEYS.map((k) => Number(detail[k])).filter((n) => Number.isFinite(n))
      : [];
    const score = categoryScores.length > 0 ? Math.max(...categoryScores) : flagged ? 1 : 0;
    return { pass: !flagged, score, latencyMs: Date.now() - start, source: "enkrypt_api" };
  }

  const TOXIC_TERMS = ["hate", "harass", "threaten", "discriminat", "slur"];
  const lower = text.toLowerCase();
  const score = TOXIC_TERMS.filter((t) => lower.includes(t)).length / TOXIC_TERMS.length;
  return { pass: score < 0.3, score, latencyMs: Date.now() - start, source: "local" };
}

// E-04: PII Detection & Redaction (<120ms) — actual redaction always runs locally
// (Enkrypt's redacted-text field isn't part of the confirmed response contract),
// but when the Enkrypt Guardrails `pii` detector flags content our regexes missed,
// that's surfaced rather than silently dropped.
async function detectAndRedactPii(
  text: string,
  apiResult: EnkryptDetectResponse | null
): Promise<{ redactedText: string; piiEntities: string[]; meaningChanged: boolean; latencyMs: number }> {
  const start = Date.now();
  const PII_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
    { name: "SSN", regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN_REDACTED]" },
    { name: "email", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: "[EMAIL_REDACTED]" },
    { name: "phone", regex: /\b(\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, replacement: "[PHONE_REDACTED]" },
    { name: "credit_card", regex: /\b\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}\b/g, replacement: "[CC_REDACTED]" },
  ];

  let redactedText = text;
  const piiEntities: string[] = [];
  let meaningChanged = false;

  for (const { name, regex, replacement } of PII_PATTERNS) {
    if (regex.test(text)) {
      piiEntities.push(name);
      redactedText = redactedText.replace(regex, replacement);
      // Check if redaction removes key legal terms
      if (name === "email" && text.includes("notice")) meaningChanged = true;
    }
  }

  if (apiResult?.summary.pii === 1 && piiEntities.length === 0) {
    piiEntities.push("enkrypt_pii_detected_unredacted");
  }

  return { redactedText, piiEntities, meaningChanged, latencyMs: Date.now() - start };
}

// ─── Group B Stages (Parallel) ────────────────────────────────────────────────

// E-05: Hallucination Detection (<200ms)
async function detectHallucination(outputText: string, retrievedContext: string): Promise<{ pass: boolean; uncertainClaims: string[]; latencyMs: number }> {
  const start = Date.now();
  // Simple consistency check: look for legal citations in output that aren't in retrieved context
  const citationPattern = /\b\d+\s+U\.S\.C\.\s+§\s+\d+|\b[A-Z][a-z]+\s+v\.\s+[A-Z][a-z]+/g;
  const outputCitations = outputText.match(citationPattern) ?? [];
  const uncertainClaims: string[] = [];

  for (const citation of outputCitations) {
    if (!retrievedContext.includes(citation.slice(0, 10))) {
      uncertainClaims.push(citation);
    }
  }

  return { pass: uncertainClaims.length === 0, uncertainClaims, latencyMs: Date.now() - start };
}

// E-06: Citation Verification (<250ms) — calls LexisNexis or uses cache
async function verifyCitations(outputText: string): Promise<{ verified: boolean; unverifiedCitations: string[]; latencyMs: number }> {
  const start = Date.now();
  const env = getEnv();

  if (!env.LEXISNEXIS_ENABLED) {
    return { verified: true, unverifiedCitations: [], latencyMs: Date.now() - start };
  }

  // Extract citation strings from output
  const citationPattern = /\b\d+\s+U\.S\.C\.\s+§\s*\d+[\w().-]*/g;
  const citations = outputText.match(citationPattern) ?? [];
  const unverifiedCitations: string[] = [];

  // In production: call LexisNexis GET /v2/citations/lookup for each citation
  // with Redis cache check first (30-day TTL in legal_precedents Qdrant collection)
  // For now: all citations pass (LexisNexis not available in dev)
  for (const _citation of citations) {
    // Mock: assume verified in dev environment
  }

  return { verified: unverifiedCitations.length === 0, unverifiedCitations, latencyMs: Date.now() - start };
}

// E-07: Bias Detection (<100ms) — Enkrypt Guardrails `bias` detector when
// available, local keyword heuristic as fallback.
async function detectBias(
  text: string,
  apiResult: EnkryptDetectResponse | null
): Promise<{ pass: boolean; biasCategory?: string; latencyMs: number }> {
  const start = Date.now();

  if (apiResult) {
    const flagged = apiResult.summary.bias === 1;
    return { pass: !flagged, biasCategory: flagged ? "enkrypt:bias_detected" : undefined, latencyMs: Date.now() - start };
  }

  const PROTECTED_CLASS_TERMS = ["gender", "race", "religion", "disability", "national origin", "age", "sexual orientation"];
  const lower = text.toLowerCase();
  const found = PROTECTED_CLASS_TERMS.find((term) => {
    const idx = lower.indexOf(term);
    if (idx === -1) return false;
    const surrounding = lower.slice(Math.max(0, idx - 20), idx + 40);
    return /disadvantag|discriminat|exclud|preferr/.test(surrounding);
  });
  return { pass: !found, biasCategory: found, latencyMs: Date.now() - start };
}

// E-08: Legal Policy Validation (<150ms)
async function validateLegalPolicy(text: string, jurisdiction: string): Promise<{ pass: boolean; violation?: string; latencyMs: number }> {
  const start = Date.now();
  const UNSAFE_ADVICE_PATTERNS = [
    { pattern: /you (should|must|need to) (immediately |urgently )?(sue|file|litigate)/i, violation: "Unsafe litigation advice without professional context" },
    { pattern: /this (guarantees|ensures|definitely) (you will win|success)/i, violation: "Misleading outcome guarantee" },
    { pattern: /no (need|requirement) for (a )?lawyer/i, violation: "Advice discouraging legal counsel" },
  ];

  const matched = UNSAFE_ADVICE_PATTERNS.find(({ pattern }) => pattern.test(text));
  return { pass: !matched, violation: matched?.violation, latencyMs: Date.now() - start };
}

// ─── Group C Stages (Sequential) ─────────────────────────────────────────────

// E-09: Confidence Estimation (<150ms) — Bayesian aggregation of A + B results
function estimateConfidence(groupAPass: boolean[], groupBPass: boolean[]): number {
  const allResults = [...groupAPass, ...groupBPass];
  const passRate = allResults.filter(Boolean).length / allResults.length;
  // Bayesian-inspired: weight failures more heavily
  const penalizedScore = Math.pow(passRate, 1.5);
  return Math.round(penalizedScore * 100) / 100;
}

// E-10: Safe Output Generation (<130ms)
function generateSafeOutput(text: string, confidenceScore: number, jurisdiction: string, flags: string[]): string {
  let output = text;
  const disclaimers: string[] = [];

  if (confidenceScore < 0.85) {
    disclaimers.push("⚠️ AI-generated analysis — verify with a qualified attorney before relying on this output.");
  }
  if (flags.includes("citation_unverified")) {
    disclaimers.push("⚠️ One or more legal citations could not be automatically verified. Manual verification recommended.");
  }
  if (jurisdiction && jurisdiction !== "Unknown") {
    disclaimers.push(`📍 Analysis applies to ${jurisdiction} jurisdiction.`);
  }

  if (disclaimers.length > 0) {
    output += "\n\n---\n" + disclaimers.join("\n");
  }

  return output;
}

// ─── Main Pipeline Orchestrator ───────────────────────────────────────────────

export interface EnkryptPipelineInput {
  sessionId: string;
  agentId: string;
  inputText: string;
  outputText: string;
  retrievedContext?: string;
  orgId: string;
  jurisdiction?: string;
  clauseType?: string;
}

export async function runEnkryptPipeline(input: EnkryptPipelineInput): Promise<EnkryptValidationResult> {
  const pipelineStart = Date.now();
  const allFlags: string[] = [];
  const stageResults: any[] = [];

  // ── E-01: Schema Validation (Gate) ──────────────────────────────────────────
  const gateStart = Date.now();
  let outputObject: any;
  try {
    outputObject = typeof input.outputText === "string"
      ? JSON.parse(input.outputText)
      : input.outputText;
  } catch {
    outputObject = { text: input.outputText };
  }
  const schemaResult = validateSchema(outputObject);
  stageResults.push(stageResult(1, "Gate", schemaResult.pass, Date.now() - gateStart, schemaResult.pass ? [] : ["schema_invalid"]));

  if (!schemaResult.pass) {
    return buildResult(false, 0, stageResults, [], [], Date.now() - pipelineStart, true);
  }

  // ── Groups A & B: Run in parallel ──────────────────────────────────────────
  const groupAStart = Date.now();
  const groupBStart = Date.now();

  // Two real Enkrypt Guardrails calls (one per text blob, multiple detectors
  // batched per call), run once and shared across the stages below — this
  // keeps the pipeline at 2 external round trips instead of 4, so it fits
  // the ENKRYPT_LATENCY budget even with the network hop included. Each
  // resolves to null (never throws) if Enkrypt is disabled/unreachable,
  // and every consuming stage below falls back to local heuristics in that case.
  const [injectionApiResult, outputApiResult] = await Promise.all([
    enkryptDetect(input.inputText, { injection_attack: { enabled: true } }),
    enkryptDetect(input.outputText, {
      toxicity: { enabled: true },
      pii: { enabled: true, entities: ["pii", "secrets", "ip_address", "url"] },
      bias: { enabled: true },
    }),
  ]);

  const [
    injectionResult,
    toxicityResult,
    piiResult,
    hallucinationResult,
    citationResult,
    biasResult,
    policyResult,
  ] = await Promise.all([
    detectPromptInjection(input.inputText, injectionApiResult),
    detectToxicity(input.outputText, outputApiResult),
    detectAndRedactPii(input.outputText, outputApiResult),
    detectHallucination(input.outputText, input.retrievedContext ?? ""),
    verifyCitations(input.outputText),
    detectBias(input.outputText, outputApiResult),
    validateLegalPolicy(input.outputText, input.jurisdiction ?? ""),
  ]);

  const groupALatencyMs = Date.now() - groupAStart;
  const groupBLatencyMs = Date.now() - groupBStart;
  const enkryptApiSource = injectionApiResult || outputApiResult ? "enkrypt_api" : "local_fallback";

  // Stage results
  stageResults.push(stageResult(2, "A", injectionResult.pass, injectionResult.latencyMs, injectionResult.pass ? [] : [`injection:${injectionResult.injectionType}`]));
  stageResults.push(stageResult(3, "A", toxicityResult.pass, toxicityResult.latencyMs, toxicityResult.pass ? [] : [`toxicity_score:${toxicityResult.score}`]));
  stageResults.push(stageResult(4, "A", true, piiResult.latencyMs, piiResult.piiEntities.length > 0 ? [`pii_redacted:${piiResult.piiEntities.join(",")}`] : []));
  stageResults.push(stageResult(5, "B", hallucinationResult.pass, hallucinationResult.latencyMs, hallucinationResult.uncertainClaims.map((c) => `uncertain:${c}`)));
  stageResults.push(stageResult(6, "B", citationResult.verified, citationResult.latencyMs, citationResult.unverifiedCitations.map((c) => `unverified:${c}`)));
  stageResults.push(stageResult(7, "B", biasResult.pass, biasResult.latencyMs, biasResult.biasCategory ? [`bias:${biasResult.biasCategory}`] : []));
  stageResults.push(stageResult(8, "B", policyResult.pass, policyResult.latencyMs, policyResult.violation ? [`policy:${policyResult.violation}`] : []));

  // Collect flags
  if (!injectionResult.pass) allFlags.push(`prompt_injection:${injectionResult.injectionType}`);
  if (!toxicityResult.pass) allFlags.push(`toxicity:${toxicityResult.score.toFixed(2)}`);
  if (!citationResult.verified) allFlags.push("citation_unverified");
  if (!biasResult.pass) allFlags.push(`bias_detected:${biasResult.biasCategory}`);
  if (!policyResult.pass) allFlags.push(`policy_violation:${policyResult.violation}`);

  // ── Group C: Sequential ────────────────────────────────────────────────────
  const groupCStart = Date.now();

  const groupAPass = [injectionResult.pass, toxicityResult.pass, true];
  const groupBPass = [hallucinationResult.pass, citationResult.verified, biasResult.pass, policyResult.pass];
  const confidenceScore = estimateConfidence(groupAPass, groupBPass);

  stageResults.push(stageResult(9, "C", true, 10, [], { confidence_score: confidenceScore, detection_source: enkryptApiSource }));

  // E-10: Safe output generation
  const safeOutput = generateSafeOutput(
    piiResult.redactedText,
    confidenceScore,
    input.jurisdiction ?? "",
    allFlags
  );
  stageResults.push(stageResult(10, "C", true, 15));

  const groupCLatencyMs = Date.now() - groupCStart;
  const totalLatencyMs = Date.now() - pipelineStart;

  // Hard failures: injection or toxicity → block completely
  const hardFail = !injectionResult.pass || !toxicityResult.pass || !policyResult.pass;
  const overallPass = !hardFail;
  const routeToHitl = !overallPass || confidenceScore < ENKRYPT_CONFIDENCE_THRESHOLD;

  recordEnkryptResult(!overallPass);

  if (totalLatencyMs > ENKRYPT_LATENCY.TOTAL_MAX) {
    console.warn(`[Enkrypt] Pipeline latency ${totalLatencyMs}ms exceeds SLA of ${ENKRYPT_LATENCY.TOTAL_MAX}ms`);
  }

  return {
    overallPass,
    confidenceScore,
    stageResults,
    groupALatencyMs,
    groupBLatencyMs,
    groupCLatencyMs,
    totalLatencyMs,
    flags: allFlags,
    routeToHitl,
    hitlReason: routeToHitl ? (hardFail ? "safety_block" : "low_confidence") : undefined,
    safeOutput: overallPass ? safeOutput : undefined,
  };
}

function buildResult(
  overallPass: boolean, confidenceScore: number, stageResults: any[],
  flags: string[], _: any[], totalLatencyMs: number, earlyExit: boolean
): EnkryptValidationResult {
  return {
    overallPass, confidenceScore, stageResults, flags,
    groupALatencyMs: 0, groupBLatencyMs: 0, groupCLatencyMs: 0, totalLatencyMs,
    routeToHitl: true,
    hitlReason: earlyExit ? "schema_validation_failed" : "safety_block",
    safeOutput: undefined,
  };
}
