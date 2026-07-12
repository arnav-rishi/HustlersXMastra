/**
 * LexGuard AI — Mastra Studio Entry Point
 *
 * Registers the real 13-agent swarm (tools, Zod schemas, Enkrypt/Qdrant
 * integration — the same code `packages/workflows/src/contract-analysis.ts`
 * and `apps/api` execute) with Mastra Studio.
 * Runs at: http://localhost:4111 (Mastra Studio)
 *
 * This file previously redeclared all 13 agents inline as prompt-only stubs,
 * disconnected from `@lexguard/agents`. That meant Studio never exercised the
 * agents' tools, schemas, or Enkrypt safety gate — only a look-alike copy.
 * It now imports directly from `@lexguard/agents`, so Studio and the
 * production API path run identical agent code.
 *
 * `pnpm dev:ui` resolves `@lexguard/*` workspace packages to their live
 * source (not a prior `dist/` build) via `--conditions=development`,
 * set in scripts/start-mastra-studio.mjs.
 *
 * Required env vars (add to .env.local):
 *   AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT — see packages/agents/src/models.ts
 *   MASTRA_API_KEY      — Mastra Cloud platform key
 *   QDRANT_URL           — Qdrant Cloud cluster endpoint
 *   QDRANT_API_KEY        — Qdrant Cloud API key
 */

import { Mastra } from "@mastra/core";
// Imported from each agent's own subpath, not the package's root barrel:
// packages/agents ships CommonJS dist output, and the barrel's `export *`
// re-exports (compiled to a dynamic __exportStar loop) aren't statically
// analyzable by Node's CJS->ESM interop, so named imports through the root
// silently fail at runtime. Subpath imports hit each agent's `exports.xAgent =`
// assignment directly, which Node's interop *can* see — the same pattern
// packages/workflows/src/contract-analysis.ts already uses.
import { documentAgent } from "@lexguard/agents/document-agent";
import { parsingAgent } from "@lexguard/agents/parsing-agent";
import { embeddingAgent } from "@lexguard/agents/embedding-agent";
import { classificationAgent } from "@lexguard/agents/classification-agent";
import { retrievalAgent } from "@lexguard/agents/retrieval-agent";
import { riskAgent } from "@lexguard/agents/risk-agent";
import { benchmarkAgent } from "@lexguard/agents/benchmark-agent";
import { rewriteAgent } from "@lexguard/agents/rewrite-agent";
import { complianceAgent } from "@lexguard/agents/compliance-agent";
import { evaluationAgent } from "@lexguard/agents/evaluation-agent";
import { memoryAgent } from "@lexguard/agents/memory-agent";
import { qaAgent } from "@lexguard/agents/qa-agent";
import { reportingAgent } from "@lexguard/agents/reporting-agent";

export const mastra = new Mastra({
  agents: {
    documentAgent,
    parsingAgent,
    embeddingAgent,
    classificationAgent,
    retrievalAgent,
    riskAgent,
    benchmarkAgent,
    rewriteAgent,
    complianceAgent,
    evaluationAgent,
    memoryAgent,
    qaAgent,
    reportingAgent,
  },
});

export default mastra;
