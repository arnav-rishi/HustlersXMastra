/**
 * LexGuard AI — OpenTelemetry Tracer
 *
 * Configures distributed tracing per PRD v2.0 Section 14.
 * Every user request generates a single trace spanning all 13 agents.
 * W3C TraceContext headers (traceparent, tracestate) propagated through
 * the Mastra event bus.
 *
 * Call initTracer() ONCE at application startup before anything else.
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  trace,
  context,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { getEnv } from "@lexguard/shared/env";
import { OTEL_SPAN_NAMES } from "@lexguard/shared/constants";

let sdk: NodeSDK | null = null;
let _tracer: Tracer | null = null;

// ─── SDK Initialization ───────────────────────────────────────────────────────

export function initTracer(serviceName?: string): void {
  const env = getEnv();
  const name = serviceName ?? env.OTEL_SERVICE_NAME;

  const traceExporter = new OTLPTraceExporter({
    url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
  });

  const metricExporter = new OTLPMetricExporter({
    url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics`,
  });

  sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: name,
      [SemanticResourceAttributes.SERVICE_VERSION]: "1.0.0",
      "lexguard.environment": env.NODE_ENV,
    }),
    spanProcessor: new BatchSpanProcessor(traceExporter),
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 15_000,
    }),
    textMapPropagator: new W3CTraceContextPropagator(),
  });

  sdk.start();

  _tracer = trace.getTracer(name, "1.0.0");

  process.on("SIGTERM", async () => {
    await sdk?.shutdown();
    console.log("[LexGuard][OTel] SDK shut down gracefully");
  });

  console.log(`[LexGuard][OTel] Tracer initialized: ${name} → ${env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
}

// ─── Tracer Accessor ──────────────────────────────────────────────────────────

export function getTracer(): Tracer {
  if (!_tracer) {
    // Fallback: no-op tracer if not initialized
    _tracer = trace.getTracer("lexguard-noop");
  }
  return _tracer;
}

// ─── Span Helpers ─────────────────────────────────────────────────────────────

/**
 * Wraps an async operation in an OTel span.
 * Records exceptions and sets error status automatically.
 *
 * @example
 * const result = await withSpan("agent.parsing.execute", { orgId, contractId }, async (span) => {
 *   span.setAttribute("page_count", 10);
 *   return await parseDocument(s3Key);
 * });
 */
export async function withSpan<T>(
  spanName: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(spanName, async (span) => {
    try {
      // Set base attributes
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value);
      }

      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Get the current trace context for propagation through message bus.
 * Returns W3C traceparent and tracestate headers.
 */
export function getCurrentTraceHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const propagator = new W3CTraceContextPropagator();
  propagator.inject(context.active(), headers, {
    set(carrier: Record<string, string>, key: string, value: string) {
      carrier[key] = value;
    },
  });
  return headers;
}

/**
 * Extract span attributes commonly used across all LexGuard agents.
 * Provides a consistent attribute baseline per PRD Appendix C (OTel Span Catalog).
 */
export function commonSpanAttributes(params: {
  orgId: string;
  contractId: string;
  agentId: string;
}): Record<string, string> {
  return {
    "lexguard.org_id": params.orgId,
    "lexguard.contract_id": params.contractId,
    "lexguard.agent_id": params.agentId,
  };
}

// Re-export span name constants for convenience
export { OTEL_SPAN_NAMES };
export { SpanStatusCode, context, trace };
