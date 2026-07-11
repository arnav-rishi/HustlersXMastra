/**
 * LexGuard AI — Environment Variable Validation
 *
 * Uses Zod to validate and parse all required environment variables at startup.
 * Throws a descriptive error if any required variable is missing or malformed.
 * This implements the 12-Factor App "Config" principle.
 */

import { z } from "zod";

const envSchema = z.object({
  // Node
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // OpenAI (legacy — superseded by Azure OpenAI below; kept optional for local scripts)
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_ORG_ID: z.string().optional(),

  // Azure OpenAI (Azure AI Foundry) — powers all 13 agents + embeddings
  AZURE_OPENAI_API_KEY: z.string().min(1, "AZURE_OPENAI_API_KEY is required"),
  AZURE_OPENAI_ENDPOINT: z
    .string()
    .url("AZURE_OPENAI_ENDPOINT must be a valid URL, e.g. https://<resource>.openai.azure.com"),
  AZURE_OPENAI_API_VERSION: z.string().default("2024-10-01-preview"),
  // Chat-completion deployment names (as created in Azure AI Foundry, not raw model names)
  AZURE_OPENAI_DEPLOYMENT: z.string().min(1, "AZURE_OPENAI_DEPLOYMENT is required"),
  AZURE_OPENAI_DEPLOYMENT_MINI: z.string().optional(),
  // Embedding deployment (e.g. a text-embedding-3-large deployment) — required only
  // for agents that generate embeddings (Embedding, Memory, QA, Retrieval agents)
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: z.string().optional(),

  // Mastra
  MASTRA_API_KEY: z.string().optional(),

  // Qdrant
  QDRANT_URL: z.string().url().default("http://localhost:6333"),
  QDRANT_API_KEY: z.string().optional(),

  // PostgreSQL
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid connection string"),

  // Redis
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  // AWS
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET_NAME: z.string().default("lexguard-contracts"),
  KMS_KEY_ARN: z.string().optional(),

  // Enkrypt
  ENKRYPT_API_KEY: z.string().optional(),
  ENKRYPT_API_URL: z
    .string()
    .url()
    .default("https://api.enkrypt.ai/v1"),

  // LexisNexis
  LEXISNEXIS_CLIENT_ID: z.string().optional(),
  LEXISNEXIS_CLIENT_SECRET: z.string().optional(),
  LEXISNEXIS_AUTH_URL: z
    .string()
    .url()
    .default("https://auth.lexisnexis.com/oauth/token"),
  LEXISNEXIS_API_URL: z
    .string()
    .url()
    .default("https://api.lexisnexis.com"),

  // JWT
  JWT_RS256_PRIVATE_KEY_PATH: z.string().default("./keys/private.pem"),
  JWT_RS256_PUBLIC_KEY_PATH: z.string().default("./keys/public.pem"),
  JWT_ISSUER: z.string().default("https://api.lexguard.ai"),
  JWT_AUDIENCE: z.string().default("lexguard-api"),
  JWT_TOKEN_TTL: z.coerce.number().default(3600),

  // API
  API_PORT: z.coerce.number().default(4000),
  API_HOST: z.string().default("0.0.0.0"),

  // OpenTelemetry
  OTEL_SERVICE_NAME: z.string().default("lexguard-api"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .string()
    .url()
    .default("http://localhost:4318"),
  OTEL_EXPORTER_OTLP_PROTOCOL: z
    .enum(["http/protobuf", "grpc"])
    .default("http/protobuf"),

  // Rate Limiting
  RATE_LIMIT_DEFAULT_RPM: z.coerce.number().default(100),

  // Feature Flags
  ENKRYPT_ENABLED: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  LEXISNEXIS_ENABLED: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  HITL_ENABLED: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

/**
 * Parse and validate environment variables.
 * Call this once at application startup.
 * @throws {Error} If any required variable is missing or invalid.
 */
export function parseEnv(overrides?: Record<string, string>): Env {
  const result = envSchema.safeParse({
    ...process.env,
    ...overrides,
  });

  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const message = Object.entries(errors)
      .map(([key, errs]) => `  ${key}: ${errs?.join(", ")}`)
      .join("\n");
    throw new Error(
      `[LexGuard] Environment validation failed:\n${message}`
    );
  }

  _env = result.data;
  return _env;
}

/**
 * Get the validated environment.
 * Must call parseEnv() first.
 */
export function getEnv(): Env {
  if (!_env) {
    throw new Error(
      "[LexGuard] Environment not initialized. Call parseEnv() at startup."
    );
  }
  return _env;
}
