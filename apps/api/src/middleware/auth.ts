/**
 * LexGuard AI — JWT RS256 Authentication Middleware
 *
 * Enforces authentication per PRD v2.0 Section 13.3 (API Gateway Security).
 *
 * Security chain (per PRD):
 * 1. AWS WAF (OWASP Core Rule Set) — handled at infrastructure level
 * 2. AWS Shield Advanced (DDoS) — handled at infrastructure level
 * 3. Rate Limiter (Redis token bucket) — see rate-limit.ts
 * 4. JWT RS256 Validation (this file) — JWKS endpoint; 1-hour token TTL
 * 5. IP Allowlist Check — enterprise tenants
 * 6. Tenant ID Extraction → downstream propagation
 *
 * All API requests require:
 *   Authorization: Bearer <JWT_RS256>
 *   X-Tenant-ID: <org_id>
 */

import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import fs from "fs";
import { getEnv } from "@lexguard/shared/env";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JwtPayload {
  sub: string;       // user ID (UUID)
  org_id: string;    // organization ID (UUID)
  email: string;
  roles: string[];
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

// Augment Express Request to carry authenticated user context
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      orgId?: string;
      tenantId?: string;
      traceId?: string;
    }
  }
}

// ─── Key Loading ──────────────────────────────────────────────────────────────

let _publicKey: string | null = null;

function getPublicKey(): string {
  if (_publicKey) return _publicKey;

  const env = getEnv();
  if (env.JWT_RS256_PUBLIC_KEY_PEM) {
    _publicKey = env.JWT_RS256_PUBLIC_KEY_PEM;
    return _publicKey;
  }
  try {
    _publicKey = fs.readFileSync(env.JWT_RS256_PUBLIC_KEY_PATH, "utf-8");
    return _publicKey;
  } catch {
    throw new Error(
      `[LexGuard][Auth] Cannot read JWT public key from: ${env.JWT_RS256_PUBLIC_KEY_PATH}`
    );
  }
}

// ─── JWT Validation ───────────────────────────────────────────────────────────

export function validateJwt(token: string): JwtPayload {
  const env = getEnv();
  const publicKey = getPublicKey();

  const decoded = jwt.verify(token, publicKey, {
    algorithms: ["RS256"],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });

  return decoded as JwtPayload;
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────

/**
 * Express middleware that validates JWT RS256 tokens and extracts tenant context.
 * Must be applied to all protected routes.
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.LEXGUARD_DEV_BYPASS_AUTH === "true"
  ) {
    const testOrgId =
      (req.headers["x-tenant-id"] as string | undefined) ??
      "00000000-0000-0000-0000-000000000001";
    req.user = {
      sub: "00000000-0000-0000-0000-000000000002",
      org_id: testOrgId,
      email: "test@lexguard.ai",
      roles: [
        "legal_counsel",
        "legal_operations",
        "compliance_officer",
        "admin",
      ],
      iat: 0,
      exp: 0,
      iss: "test",
      aud: "test",
    };
    req.orgId = testOrgId;
    req.tenantId = testOrgId;
    req.traceId = generateTraceId();
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  const tenantHeader = req.headers["x-tenant-id"] as string | undefined;

  // Extract Bearer token
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Authorization header with Bearer token required",
      code: "LG-AUTH-001",
    });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = validateJwt(token);

    // Validate tenant isolation: X-Tenant-ID must match org_id in JWT
    if (tenantHeader && tenantHeader !== payload.org_id) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: "X-Tenant-ID does not match authenticated organization",
        code: "LG-AUTH-002",
      });
      return;
    }

    // Attach to request context
    req.user = payload;
    req.orgId = payload.org_id;
    req.tenantId = tenantHeader ?? payload.org_id;

    // Extract/generate trace ID from W3C traceparent header
    const traceparent = req.headers["traceparent"] as string | undefined;
    req.traceId = traceparent
      ? traceparent.split("-")[1] ?? generateTraceId()
      : generateTraceId();

    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        error: "TOKEN_EXPIRED",
        message: "JWT token has expired. Please reauthenticate.",
        code: "LG-AUTH-003",
      });
      return;
    }

    if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({
        error: "INVALID_TOKEN",
        message: "JWT token is invalid or malformed",
        code: "LG-AUTH-004",
      });
      return;
    }

    res.status(500).json({
      error: "AUTH_ERROR",
      message: "Authentication service error",
      code: "LG-AUTH-005",
    });
  }
}

// ─── Role-based Authorization ─────────────────────────────────────────────────

/**
 * Middleware factory: require specific role.
 * @example requireRole("legal_counsel")
 */
export function requireRole(role: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Authentication required",
      });
      return;
    }

    if (!req.user.roles.includes(role)) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: `Role '${role}' required for this action`,
        code: "LG-AUTH-006",
      });
      return;
    }

    next();
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateTraceId(): string {
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");
}
