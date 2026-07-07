import { Mastra } from "@mastra/core";

/**
 * LexGuard AI — Mastra Dev Studio Entry Point
 *
 * This file registers all 13 agents and the master contract analysis workflow
 * with the Mastra Dev UI (http://localhost:4111).
 *
 * NOTE: Agent implementations are in packages/agents/src/.
 * To run the full pipeline, infrastructure (Qdrant, Postgres, Redis) must be
 * running. Start it with: pnpm infra:up
 *
 * For local development without infrastructure, set in .env.local:
 *   ENKRYPT_ENABLED=false
 *   LEXISNEXIS_ENABLED=false
 */

export const mastra = new Mastra({});

export default mastra;
