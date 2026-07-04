/**
 * LexGuard AI — Prometheus Metrics
 *
 * Exports all Prometheus metrics defined in PRD v2.0 Section 14.2.
 * Alert thresholds are defined as comments alongside each metric.
 *
 * Metrics are automatically exposed via /metrics endpoint in the API.
 */

import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import {
  metrics,
  type Histogram,
  type ObservableGauge,
  type Counter,
  type Meter,
} from "@opentelemetry/api";
import { getEnv } from "@lexguard/shared/env";

let _meter: Meter | null = null;

// ─── Metric Instances ─────────────────────────────────────────────────────────

// Histograms (latency)
let contractAnalysisLatency: Histogram;   // Alert: > 15s P95 → PagerDuty
let enkryptPipelineLatency: Histogram;    // Alert: > 1.5s → Warning

// Gauges (rates and states)
let enkryptRejectionRate: ObservableGauge;  // Alert: > 10% → Investigation
let qdrantMissRate: ObservableGauge;        // Alert: > 30% → Warning
let hitlQueueDepth: ObservableGauge;        // Alert: > 50 → Ops Alert
let hallucination_rate: ObservableGauge;    // Alert: > 1% → P0 Alert

// Counters
let llmTokenUsageTotal: Counter;            // Per-org budget alert

// ─── Internal State (in-process) ─────────────────────────────────────────────
// In production these feed from real event streams.

let _enkryptRejections = 0;
let _enkryptTotal = 0;
let _qdrantMisses = 0;
let _qdrantTotal = 0;
let _hitlDepth = 0;
let _hallucinations = 0;
let _hallucination_checks = 0;

// ─── Initialization ───────────────────────────────────────────────────────────

export function initMetrics(): void {
  const env = getEnv();

  const exporter = new OTLPMetricExporter({
    url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics`,
  });

  const meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 15_000,
      }),
    ],
  });

  metrics.setGlobalMeterProvider(meterProvider);
  _meter = metrics.getMeter("lexguard", "1.0.0");

  // ─── Contract Analysis Latency ──────────────────────────────────────────────
  contractAnalysisLatency = _meter.createHistogram(
    "lexguard_contract_analysis_latency_p95",
    {
      description:
        "End-to-end contract analysis latency in milliseconds. Alert: P95 > 15000ms",
      unit: "ms",
    }
  );

  // ─── Enkrypt Pipeline Latency ───────────────────────────────────────────────
  enkryptPipelineLatency = _meter.createHistogram(
    "lexguard_enkrypt_pipeline_latency_p95",
    {
      description:
        "Enkrypt 10-stage DAG total latency. Alert: P95 > 1500ms",
      unit: "ms",
    }
  );

  // ─── Enkrypt Rejection Rate ─────────────────────────────────────────────────
  enkryptRejectionRate = _meter.createObservableGauge(
    "lexguard_enkrypt_rejection_rate",
    {
      description:
        "Percentage of LLM outputs blocked by Enkrypt. Alert: > 10%",
    }
  );
  enkryptRejectionRate.addCallback((result) => {
    const rate = _enkryptTotal > 0
      ? (_enkryptRejections / _enkryptTotal) * 100
      : 0;
    result.observe(rate);
  });

  // ─── Qdrant Miss Rate ───────────────────────────────────────────────────────
  qdrantMissRate = _meter.createObservableGauge(
    "lexguard_qdrant_miss_rate",
    {
      description:
        "Percentage of queries returning zero results from Qdrant. Alert: > 30%",
    }
  );
  qdrantMissRate.addCallback((result) => {
    const rate = _qdrantTotal > 0
      ? (_qdrantMisses / _qdrantTotal) * 100
      : 0;
    result.observe(rate);
  });

  // ─── HITL Queue Depth ───────────────────────────────────────────────────────
  hitlQueueDepth = _meter.createObservableGauge(
    "lexguard_hitl_queue_depth",
    {
      description:
        "Number of pending HITL review items. Alert: > 50 → Ops Alert",
    }
  );
  hitlQueueDepth.addCallback((result) => {
    result.observe(_hitlDepth);
  });

  // ─── Hallucination Rate ─────────────────────────────────────────────────────
  hallucination_rate = _meter.createObservableGauge(
    "lexguard_hallucination_rate",
    {
      description:
        "Citations that failed LexisNexis verification. Alert: > 1% → P0",
    }
  );
  hallucination_rate.addCallback((result) => {
    const rate = _hallucination_checks > 0
      ? (_hallucinations / _hallucination_checks) * 100
      : 0;
    result.observe(rate);
  });

  // ─── LLM Token Usage ────────────────────────────────────────────────────────
  llmTokenUsageTotal = _meter.createCounter(
    "lexguard_llm_token_usage_total",
    {
      description: "Total LLM tokens consumed. Segmented by org_id and model.",
    }
  );

  console.log("[LexGuard][Metrics] Prometheus metrics initialized");
}

// ─── Metric Recording API ─────────────────────────────────────────────────────

export function recordContractAnalysisLatency(latencyMs: number): void {
  contractAnalysisLatency?.record(latencyMs);
}

export function recordEnkryptPipelineLatency(latencyMs: number): void {
  enkryptPipelineLatency?.record(latencyMs);
}

export function recordEnkryptResult(blocked: boolean): void {
  _enkryptTotal++;
  if (blocked) _enkryptRejections++;
}

export function recordQdrantQuery(missedResults: boolean): void {
  _qdrantTotal++;
  if (missedResults) _qdrantMisses++;
}

export function setHitlQueueDepth(depth: number): void {
  _hitlDepth = depth;
}

export function recordHallucinationCheck(wasHallucination: boolean): void {
  _hallucination_checks++;
  if (wasHallucination) _hallucinations++;
}

export function recordLlmTokens(
  orgId: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): void {
  const total = inputTokens + outputTokens;
  llmTokenUsageTotal?.add(total, {
    "lexguard.org_id": orgId,
    "lexguard.model": model,
  });
}
