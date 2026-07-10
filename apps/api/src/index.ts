/**
 * LexGuard AI — API Gateway Entry Point
 *
 * Node.js Express server that acts as the API Gateway layer.
 * Implements the security chain from PRD v2.0 Section 13.3:
 *
 *   Incoming Request
 *     → AWS WAF (infra layer)
 *     → AWS Shield Advanced (infra layer)
 *     → Rate Limiter (Redis token bucket)   ← apps/api/src/middleware/rate-limit.ts
 *     → JWT RS256 Validation                ← apps/api/src/middleware/auth.ts
 *     → IP Allowlist (enterprise tenants)   ← future middleware
 *     → Tenant ID extraction
 *     → Routes
 *
 * OTel instrumentation: auto-instrumented via @opentelemetry/auto-instrumentations-node
 */

// IMPORTANT: OTel must be initialized BEFORE any other imports
import { initTracer } from "@lexguard/observability/tracer";
import { initMetrics } from "@lexguard/observability/metrics";

// Initialize env first
import "dotenv/config";
import { parseEnv } from "@lexguard/shared/env";
const env = parseEnv();

// Then init observability
initTracer("lexguard-api");
initMetrics();

import express from "express";
import type { Express } from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import { contractsRouter } from "./routes/contracts";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { getQdrantClient } from "@lexguard/qdrant/client";

// ─── App Setup ────────────────────────────────────────────────────────────────

const app: Express = express();
const prisma = new PrismaClient();
const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });

// ─── Security Headers ─────────────────────────────────────────────────────────
// Helmet sets HSTS, CSP, X-Frame-Options, etc.
app.use(
  helmet({
    hsts: {
      maxAge: 31536000,        // 1 year
      includeSubDomains: true,
      preload: true,
    },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
      },
    },
  })
);

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins =
  env.NODE_ENV === "production"
    ? ["https://app.lexguard.ai", "https://dashboard.lexguard.ai"]
    : ["http://localhost:3000", "http://localhost:3001"];

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "X-Tenant-ID",
      "traceparent",
      "tracestate",
    ],
    credentials: true,
  })
);

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(compression());

// ─── Health / Readiness Probes ────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "lexguard-api",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

app.get("/ready", async (_req, res) => {
  const checks: Record<string, "ok" | "degraded"> = { api: "ok" };
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.postgres = "ok";
  } catch {
    checks.postgres = "degraded";
  }
  try {
    await redis.connect();
    await redis.ping();
    checks.redis = "ok";
  } catch {
    checks.redis = "degraded";
  } finally {
    if (redis.status === "ready") {
      await redis.quit();
    }
  }
  try {
    const healthy = await getQdrantClient().healthCheck();
    checks.qdrant = healthy ? "ok" : "degraded";
  } catch {
    checks.qdrant = "degraded";
  }

  const allOk = Object.values(checks).every((v) => v === "ok");
  res.status(allOk ? 200 : 503).json({
    ready: allOk,
    checks,
    timestamp: new Date().toISOString(),
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use("/api/v1/contracts", contractsRouter);
app.use("/api/v1/qa", contractsRouter);        // QA route is on contracts router
app.use("/api/v1/hitl", contractsRouter);      // HITL routes on contracts router
app.use("/api/v1/gdpr", contractsRouter);      // GDPR on contracts router
app.use("/api/v1/audit", contractsRouter);     // Audit on contracts router

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({
    error: "NOT_FOUND",
    message: "The requested endpoint does not exist",
  });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("[LexGuard][API] Unhandled error:", err);
    res.status(500).json({
      error: "INTERNAL_SERVER_ERROR",
      message:
        env.NODE_ENV === "development" ? err.message : "An error occurred",
    });
  }
);

// ─── Server Startup ───────────────────────────────────────────────────────────

let server: ReturnType<typeof app.listen> | null = null;

function startServer() {
  if (server) return server;
  server = app.listen(env.API_PORT, env.API_HOST, () => {
    console.log(`
╔════════════════════════════════════════╗
║       LexGuard AI — API Gateway        ║
╚════════════════════════════════════════╝
  Listening: http://${env.API_HOST}:${env.API_PORT}
  Environment: ${env.NODE_ENV}
  OTel: ${env.OTEL_EXPORTER_OTLP_ENDPOINT}
  Enkrypt: ${env.ENKRYPT_ENABLED ? "✅ enabled" : "⚠️  disabled"}
  LexisNexis: ${env.LEXISNEXIS_ENABLED ? "✅ enabled" : "⚠️  disabled"}
  HITL: ${env.HITL_ENABLED ? "✅ enabled" : "⚠️  disabled"}
`);
  });
  return server;
}

// Graceful shutdown (Disposability — 12-Factor)
process.on("SIGTERM", () => {
  console.log("[LexGuard][API] SIGTERM received. Graceful shutdown...");
  if (!server) {
    process.exit(0);
    return;
  }
  server.close(() => {
    console.log("[LexGuard][API] HTTP server closed.");
    process.exit(0);
  });
});

if (process.env.NODE_ENV !== "test") {
  startServer();
}

export { app, startServer };
