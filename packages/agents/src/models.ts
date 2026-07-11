/**
 * LexGuard AI — Azure OpenAI Model Clients
 *
 * All 13 agents run on Azure OpenAI (Azure AI Foundry) deployments.
 * Two client shapes are exported:
 *  - `gpt4o` / `gpt4oMini`: ai-sdk model handles wired to Mastra `Agent` definitions.
 *  - `getAzureOpenAIClient()`: the raw `openai` SDK's native `AzureOpenAI` client,
 *    used by tool executors that call `.chat.completions.create()` /
 *    `.embeddings.create()` directly (the actual LLM call path in this codebase).
 *
 * NOTE: this module is evaluated at import time, before `parseEnv()` runs in
 * apps/api/src/index.ts (ES module dependency evaluation order). The ai-sdk
 * handles below therefore read `process.env` directly rather than `getEnv()`.
 * The lazy `getAzureOpenAIClient()`/deployment getters are safe to use `getEnv()`
 * because they only run inside request-time tool executors, after server boot.
 */

import { createAzure } from "@ai-sdk/azure";
import { AzureOpenAI } from "openai";
import { getEnv } from "@lexguard/shared/env";

function resourceNameFromEndpoint(endpoint?: string): string | undefined {
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint).hostname.split(".")[0];
  } catch {
    return undefined;
  }
}

const azure = createAzure({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  resourceName: resourceNameFromEndpoint(process.env.AZURE_OPENAI_ENDPOINT),
  apiVersion: process.env.AZURE_OPENAI_API_VERSION,
});

const chatDeploymentFallback = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o";
const chatDeploymentMiniFallback =
  process.env.AZURE_OPENAI_DEPLOYMENT_MINI || chatDeploymentFallback;

export const gpt4o: any = azure(chatDeploymentFallback);
export const gpt4oMini: any = azure(chatDeploymentMiniFallback);

// ─── Raw AzureOpenAI client (used by tool executors) ──────────────────────────

let _azureOpenAI: AzureOpenAI | null = null;

export function getAzureOpenAIClient(): AzureOpenAI {
  if (_azureOpenAI) return _azureOpenAI;
  const env = getEnv();
  _azureOpenAI = new AzureOpenAI({
    apiKey: env.AZURE_OPENAI_API_KEY,
    endpoint: env.AZURE_OPENAI_ENDPOINT,
    apiVersion: env.AZURE_OPENAI_API_VERSION,
  });
  return _azureOpenAI;
}

export function getChatDeployment(): string {
  return getEnv().AZURE_OPENAI_DEPLOYMENT;
}

export function getChatDeploymentMini(): string {
  const env = getEnv();
  return env.AZURE_OPENAI_DEPLOYMENT_MINI || env.AZURE_OPENAI_DEPLOYMENT;
}

export function getEmbeddingDeployment(): string {
  const env = getEnv();
  if (!env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT) {
    throw new Error(
      "[LexGuard] AZURE_OPENAI_EMBEDDING_DEPLOYMENT is not set. Deploy a text-embedding model " +
        "(e.g. text-embedding-3-large) in Azure AI Foundry and set AZURE_OPENAI_EMBEDDING_DEPLOYMENT."
    );
  }
  return env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;
}
