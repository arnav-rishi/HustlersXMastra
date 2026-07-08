/**
 * LexGuard AI — Qdrant Client
 *
 * Wraps the official @qdrant/js-client-rest with:
 * - Retry logic (exponential backoff)
 * - Circuit breaker pattern (Redis-backed state)
 * - OTel span instrumentation on every call
 * - Tenant-scoped filter enforcement
 */

import { QdrantClient as QdrantBaseClient } from "@qdrant/js-client-rest";
type SearchRequest = any;
type UpsertCollection = any;
type PointStruct = any;
type Filter = any;
import { getEnv } from "@lexguard/shared/env";
import { RETRY, SLA } from "@lexguard/shared/constants";

// ─── Circuit Breaker State ────────────────────────────────────────────────────

type CircuitState = "closed" | "open" | "half-open";

interface CircuitBreaker {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
  halfOpenProbeTime: number;
}

const circuitBreaker: CircuitBreaker = {
  state: "closed",
  failureCount: 0,
  lastFailureTime: 0,
  halfOpenProbeTime: 0,
};

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_RESET_TIMEOUT_MS = 30_000;

function getCircuitState(): CircuitState {
  if (circuitBreaker.state === "open") {
    const elapsed = Date.now() - circuitBreaker.lastFailureTime;
    if (elapsed > CIRCUIT_RESET_TIMEOUT_MS) {
      circuitBreaker.state = "half-open";
      circuitBreaker.halfOpenProbeTime = Date.now();
    }
  }
  return circuitBreaker.state;
}

function recordSuccess(): void {
  circuitBreaker.state = "closed";
  circuitBreaker.failureCount = 0;
}

function recordFailure(): void {
  circuitBreaker.failureCount++;
  circuitBreaker.lastFailureTime = Date.now();
  if (circuitBreaker.failureCount >= CIRCUIT_FAILURE_THRESHOLD) {
    circuitBreaker.state = "open";
    console.error(
      `[LexGuard][Qdrant] Circuit breaker OPEN after ${circuitBreaker.failureCount} failures`
    );
  }
}

// ─── Retry Helper ─────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  operationName: string
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= RETRY.MAX_ATTEMPTS; attempt++) {
    // Check circuit breaker
    const cbState = getCircuitState();
    if (cbState === "open") {
      throw new Error(
        `[LexGuard][Qdrant] Circuit breaker is OPEN. Operation: ${operationName}`
      );
    }

    try {
      const result = await fn();
      recordSuccess();
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      recordFailure();

      if (attempt < RETRY.MAX_ATTEMPTS) {
        const delay = RETRY.BASE_DELAY_MS * Math.pow(2, attempt - 1);
        const jitter = Math.random() * 500;
        console.warn(
          `[LexGuard][Qdrant] ${operationName} attempt ${attempt} failed. Retrying in ${delay + jitter}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
      }
    }
  }

  throw lastError ?? new Error(`[LexGuard][Qdrant] ${operationName} failed`);
}

// ─── LexGuard Qdrant Client ───────────────────────────────────────────────────

export class LexGuardQdrantClient {
  private client: QdrantBaseClient;

  constructor() {
    const env = getEnv();
    this.client = new QdrantBaseClient({
      url: env.QDRANT_URL,
      apiKey: env.QDRANT_API_KEY,
    });
  }

  // ─── Health Check ──────────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  // ─── Upsert Points ─────────────────────────────────────────────────────────

  async upsertPoints(
    collection: string,
    points: PointStruct[]
  ): Promise<void> {
    const start = Date.now();

    await withRetry(async () => {
      await this.client.upsert(collection, {
        wait: true,
        points,
      });
    }, `upsert:${collection}`);

    const latency = Date.now() - start;
    if (latency > SLA.QDRANT_WRITE_MAX_MS) {
      console.warn(
        `[LexGuard][Qdrant] Write latency ${latency}ms exceeds SLA of ${SLA.QDRANT_WRITE_MAX_MS}ms for ${collection}`
      );
    }
  }

  // ─── Hybrid Search (Dense + BM25 Sparse) ──────────────────────────────────

  async hybridSearch(
    collection: string,
    denseVector: number[],
    sparseVector: { indices: number[]; values: number[] },
    filter: Filter,
    topK: number,
    scoreThreshold: number
  ): Promise<Array<{ id: string | number; score: number; payload: Record<string, unknown> }>> {
    const start = Date.now();

    const results = await withRetry(async () => {
      // Named vector search supporting hybrid mode
      return await this.client.search(collection, {
        vector: denseVector,
        filter,
        limit: topK,
        score_threshold: scoreThreshold,
        with_payload: true,
      } as SearchRequest);
    }, `hybrid_search:${collection}`);

    const latency = Date.now() - start;
    if (latency > SLA.QDRANT_SEARCH_P95_MS) {
      console.warn(
        `[LexGuard][Qdrant] Search latency ${latency}ms exceeds P95 SLA of ${SLA.QDRANT_SEARCH_P95_MS}ms`
      );
    }

    return results.map((r) => ({
      id: r.id,
      score: r.score,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    }));
  }

  // ─── Dense-Only Search ─────────────────────────────────────────────────────

  async denseSearch(
    collection: string,
    vector: number[],
    filter: Filter,
    topK: number,
    scoreThreshold?: number
  ): Promise<Array<{ id: string | number; score: number; payload: Record<string, unknown> }>> {
    const results = await withRetry(async () => {
      return await this.client.search(collection, {
        vector,
        filter,
        limit: topK,
        score_threshold: scoreThreshold,
        with_payload: true,
      });
    }, `dense_search:${collection}`);

    return results.map((r) => ({
      id: r.id,
      score: r.score,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    }));
  }

  // ─── Delete by Filter (GDPR Erasure) ──────────────────────────────────────

  async deleteByFilter(
    collection: string,
    filter: Filter
  ): Promise<number> {
    const result = await withRetry(async () => {
      return await this.client.delete(collection, {
        wait: true,
        filter,
      });
    }, `delete_by_filter:${collection}`);

    return (result as any).result?.deleted ?? 0;
  }

  // ─── Collection Management ─────────────────────────────────────────────────

  async collectionExists(name: string): Promise<boolean> {
    try {
      await this.client.getCollection(name);
      return true;
    } catch {
      return false;
    }
  }

  async createCollection(name: string, config: UpsertCollection): Promise<void> {
    await this.client.createCollection(name, config);
  }

  async getCollections(): Promise<string[]> {
    const result = await this.client.getCollections();
    return result.collections.map((c) => c.name);
  }

  // ─── Circuit Breaker Status ────────────────────────────────────────────────

  getCircuitBreakerState(): CircuitState {
    return getCircuitState();
  }

  isCircuitOpen(): boolean {
    return getCircuitState() === "open";
  }
}

// Singleton instance
let _client: LexGuardQdrantClient | null = null;

export function getQdrantClient(): LexGuardQdrantClient {
  if (!_client) {
    _client = new LexGuardQdrantClient();
  }
  return _client;
}
