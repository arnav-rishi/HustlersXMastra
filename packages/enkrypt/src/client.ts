/**
 * LexGuard AI — Enkrypt AI Guardrails REST Client
 *
 * Thin wrapper around Enkrypt AI's real Guardrails detect endpoint
 * (per docs.enkryptai.com): POST {ENKRYPT_API_URL}/guardrails/detect,
 * authenticated with an `apikey` header (not `Authorization: Bearer`).
 *
 * The `summary` object in the response (binary 0/1 flag per requested
 * detector) is the one part of the response shape confirmed against
 * Enkrypt's published OpenAPI schema. `details` carries per-detector
 * specifics (scores, entities, etc.) but its exact sub-schema varies by
 * detector and account tier, so callers must treat it defensively.
 *
 * Returns `null` (never throws) when Enkrypt is disabled, unconfigured,
 * or unreachable within the timeout — callers fall back to local
 * heuristics in that case. This keeps the pipeline's hard latency SLA
 * (packages/shared/src/constants.ts ENKRYPT_LATENCY) intact even if the
 * external API is slow or down.
 */

import { getEnv } from "@lexguard/shared/env";

const DETECT_PATH = "/guardrails/detect";

export interface EnkryptDetectorsConfig {
  injection_attack?: { enabled: boolean };
  toxicity?: { enabled: boolean };
  pii?: { enabled: boolean; entities?: string[] };
  bias?: { enabled: boolean };
  nsfw?: { enabled: boolean };
  keyword_detector?: { enabled: boolean; banned_keywords?: string[] };
  topic_detector?: { enabled: boolean; topic?: string[] };
  policy_violation?: { enabled: boolean; coc_policy_name?: string };
}

export interface EnkryptDetectResponse {
  /**
   * Per-detector flag, shape varies by detector (confirmed against live API
   * responses, not just the published schema): `pii`/`bias`/`injection_attack`
   * are a binary 0/1, but `toxicity` is an array of flagged category names
   * (e.g. `["HARASSMENT","VIOLENCE_THREATS"]`), empty when clean — never 0/1.
   */
  summary: Record<string, number | string[]>;
  /** Per-detector detail payloads; shape varies by detector — read defensively */
  details: Record<string, unknown>;
}

export async function enkryptDetect(
  text: string,
  detectors: EnkryptDetectorsConfig
): Promise<EnkryptDetectResponse | null> {
  const env = getEnv();
  if (!env.ENKRYPT_ENABLED || !env.ENKRYPT_API_KEY) return null;
  if (!text) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ENKRYPT_TIMEOUT_MS);

  try {
    const res = await fetch(`${env.ENKRYPT_API_URL}${DETECT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.ENKRYPT_API_KEY,
      },
      body: JSON.stringify({ text, detectors }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[Enkrypt] Guardrails API returned ${res.status} ${res.statusText} — falling back to local heuristics`);
      return null;
    }

    const body = (await res.json()) as Partial<EnkryptDetectResponse>;
    if (!body || typeof body.summary !== "object" || body.summary === null) {
      console.warn("[Enkrypt] Guardrails API response missing 'summary' — falling back to local heuristics");
      return null;
    }

    return { summary: body.summary, details: body.details ?? {} };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[Enkrypt] Guardrails API call failed (${reason}) — falling back to local heuristics`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
