import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  $queryRaw: vi.fn(),
  contract: {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  hitlQueueItem: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
  workflowStageMetric: {
    findMany: vi.fn(),
  },
};

vi.mock("@prisma/client", () => {
  return {
    PrismaClient: vi.fn(() => prismaMock),
  };
});
vi.mock("@lexguard/qdrant/client", () => ({
  getQdrantClient: () => ({
    healthCheck: vi.fn().mockResolvedValue(true),
  }),
}));

const redisConnectMock = vi.fn().mockResolvedValue(undefined);
const redisPingMock = vi.fn().mockResolvedValue("PONG");
const redisQuitMock = vi.fn().mockResolvedValue(undefined);

vi.mock("ioredis", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      connect: redisConnectMock,
      ping: redisPingMock,
      quit: redisQuitMock,
      status: "ready",
    })),
  };
});

const triggerContractAnalysisMock = vi.fn();
vi.mock("@lexguard/workflows/contract-analysis", () => ({
  triggerContractAnalysis: triggerContractAnalysisMock,
}));

const executeQAAgentMock = vi.fn();
vi.mock("@lexguard/agents/qa-agent", () => ({
  executeQAAgent: executeQAAgentMock,
}));

const executeMemoryAgentMock = vi.fn();
vi.mock("@lexguard/agents/memory-agent", () => ({
  executeMemoryAgent: executeMemoryAgentMock,
}));

// Prevent initTracer / initMetrics from attempting OTLP network connections
vi.mock("@lexguard/observability/tracer", () => ({
  initTracer: vi.fn(),
  withSpan: vi.fn((_name: string, _attrs: unknown, fn: (span: unknown) => unknown) =>
    fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() })
  ),
  OTEL_SPAN_NAMES: { MASTRA_WORKFLOW_START: "mastra.workflow.start" },
  getTracer: vi.fn(() => ({ startActiveSpan: vi.fn() })),
}));

vi.mock("@lexguard/observability/metrics", () => ({
  initMetrics: vi.fn(),
  recordContractAnalysisLatency: vi.fn(),
}));

describe("contracts routes", () => {
  let app: Awaited<typeof import("../src/index")>["app"];

  beforeAll(async () => {
    app = (await import("../src/index")).app;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  });

  it("starts analysis and persists queued contract", async () => {
    prismaMock.contract.create.mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000101",
    });
    prismaMock.contract.update.mockResolvedValue({});
    triggerContractAnalysisMock.mockResolvedValue({
      workflowId: "00000000-0000-0000-0000-000000000777",
      contractId: "00000000-0000-0000-0000-000000000101",
    });

    const response = await request(app)
      .post("/api/v1/contracts/analyze")
      .set("x-tenant-id", "00000000-0000-0000-0000-000000000001")
      .send({
        contractText: "sample contract text",
        fileName: "sample.txt",
      });

    expect(response.status).toBe(202);
    expect(prismaMock.contract.create).toHaveBeenCalledTimes(1);
    expect(triggerContractAnalysisMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.contract.update).toHaveBeenCalledTimes(1);
  });

  it("returns pending contracts", async () => {
    prismaMock.contract.findMany.mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000101",
        fileName: "A.pdf",
        documentType: "DIGITAL_PDF",
        status: "PROCESSING",
        overallRisk: "MODERATE",
        createdAt: new Date("2026-07-09T00:00:00.000Z"),
      },
    ]);
    const response = await request(app)
      .get("/api/v1/contracts/pending")
      .set("x-tenant-id", "00000000-0000-0000-0000-000000000001");

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items[0].status).toBe("processing");
    expect(prismaMock.contract.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 25, skip: 0 })
    );
  });

  it("returns contract status from persistence", async () => {
    prismaMock.contract.findFirst.mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000101",
      status: "PROCESSING",
      workflowStatus: "processing",
      workflowStep: "embedding",
      progressPct: 30,
      updatedAt: new Date("2026-07-09T00:00:00.000Z"),
    });
    const response = await request(app)
      .get("/api/v1/contracts/00000000-0000-0000-0000-000000000101/status")
      .set("x-tenant-id", "00000000-0000-0000-0000-000000000001")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(200);
    expect(response.body.currentStep).toBe("embedding");
  });

  it("returns contract analysis payload", async () => {
    prismaMock.contract.findFirst.mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000101",
      status: "COMPLETED",
      workflowStatus: "completed",
      analysisJson: { summary: "ok" },
      reportId: "00000000-0000-0000-0000-000000000201",
      completedAt: new Date("2026-07-09T00:00:00.000Z"),
    });
    const response = await request(app)
      .get("/api/v1/contracts/00000000-0000-0000-0000-000000000101/analysis")
      .set("x-tenant-id", "00000000-0000-0000-0000-000000000001")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(200);
    expect(response.body.analysis.summary).toBe("ok");
  });

  it("downloads report json", async () => {
    prismaMock.contract.findFirst.mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000101",
      analysisJson: { executiveSummary: "ok" },
    });
    const response = await request(app)
      .get("/api/v1/contracts/00000000-0000-0000-0000-000000000101/report")
      .set("x-tenant-id", "00000000-0000-0000-0000-000000000001")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(200);
    expect(response.header["content-disposition"]).toContain("report.json");
  });

  it("answers QA via qa agent", async () => {
    executeQAAgentMock.mockResolvedValue({
      answer: "hello",
      citations: [],
      readabilityScore: 61,
      enkryptConfidence: 0.95,
      sessionId: "00000000-0000-0000-0000-000000000301",
      requiresHitl: false,
    });
    const response = await request(app)
      .post("/api/v1/contracts/qa")
      .set("x-tenant-id", "00000000-0000-0000-0000-000000000001")
      .send({
        contractId: "00000000-0000-0000-0000-000000000101",
        question: "What are key risks?",
      });

    expect(response.status).toBe(200);
    expect(response.body.answer).toBe("hello");
  });

  it("returns hitl queue from database", async () => {
    prismaMock.hitlQueueItem.findMany.mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000401",
        contractId: "00000000-0000-0000-0000-000000000101",
        clauseIndex: 4,
        reason: "ENKRYPT_CONFIDENCE_LOW",
        confidenceScore: 0.62,
        status: "PENDING",
        createdAt: new Date("2026-07-09T00:00:00.000Z"),
        slaDeadline: new Date("2026-07-09T05:00:00.000Z"),
      },
    ]);
    const response = await request(app)
      .get("/api/v1/contracts/hitl/queue")
      .set("x-tenant-id", "00000000-0000-0000-0000-000000000001")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(prismaMock.hitlQueueItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 25, skip: 0 })
    );
  });

  it("returns hitl item detail", async () => {
    prismaMock.hitlQueueItem.findFirst.mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000401",
      contractId: "00000000-0000-0000-0000-000000000101",
      clauseIndex: 2,
      reason: "ENKRYPT_CONFIDENCE_LOW",
      originalClause: "Original clause text",
      aiSuggestion: "Suggested rewrite",
      riskReason: "Low confidence",
      confidenceScore: 0.61,
      status: "PENDING",
      reviewerNotes: null,
      createdAt: new Date("2026-07-09T00:00:00.000Z"),
      slaDeadline: new Date("2026-07-09T05:00:00.000Z"),
    });
    const response = await request(app)
      .get("/api/v1/contracts/hitl/00000000-0000-0000-0000-000000000401")
      .set("x-tenant-id", "00000000-0000-0000-0000-000000000001")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(200);
    expect(response.body.originalClause).toBe("Original clause text");
  });

  it("records hitl decision and updates memory", async () => {
    prismaMock.hitlQueueItem.findFirst.mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000401",
      contractId: "00000000-0000-0000-0000-000000000101",
      originalClause: "bad clause",
      riskReason: "high risk",
    });
    prismaMock.hitlQueueItem.update.mockResolvedValue({});
    prismaMock.contract.updateMany.mockResolvedValue({});
    executeMemoryAgentMock.mockResolvedValue({
      collectionsUpdated: ["org_preferences"],
    });
    const response = await request(app)
      .post("/api/v1/contracts/hitl/00000000-0000-0000-0000-000000000401/decision")
      .set("x-tenant-id", "00000000-0000-0000-0000-000000000001")
      .set("Authorization", "Bearer test")
      .send({
        decision: "approve",
      });

    expect(response.status).toBe(200);
    expect(executeMemoryAgentMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.hitlQueueItem.update).toHaveBeenCalledTimes(1);
  });

  it("returns ready=true when dependencies are healthy", async () => {
    const response = await request(app).get("/ready");
    expect(response.status).toBe(200);
    expect(response.body.ready).toBe(true);
    expect(response.body.checks.postgres).toBe("ok");
    expect(response.body.checks.redis).toBe("ok");
    expect(response.body.checks.qdrant).toBe("ok");
  });

  it("returns ready=false when postgres check fails", async () => {
    prismaMock.$queryRaw.mockRejectedValueOnce(new Error("db down"));
    const response = await request(app).get("/ready");
    expect(response.status).toBe(503);
    expect(response.body.ready).toBe(false);
    expect(response.body.checks.postgres).toBe("degraded");
  });

  it("returns ready=false when redis check fails", async () => {
    redisPingMock.mockRejectedValueOnce(new Error("redis down"));
    const response = await request(app).get("/ready");
    expect(response.status).toBe(503);
    expect(response.body.ready).toBe(false);
    expect(response.body.checks.redis).toBe("degraded");
  });

  it("returns ready=false when qdrant check fails", async () => {
    const qdrantMock = await import("@lexguard/qdrant/client");
    vi.spyOn(qdrantMock, "getQdrantClient").mockReturnValueOnce({
      healthCheck: vi.fn().mockRejectedValueOnce(new Error("qdrant down")),
    } as any);
    const response = await request(app).get("/ready");
    expect(response.status).toBe(503);
    expect(response.body.ready).toBe(false);
    expect(response.body.checks.qdrant).toBe("degraded");
  });

  it("returns workflow stage metrics for a contract", async () => {
    prismaMock.contract.findFirst.mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000101",
    });
    prismaMock.workflowStageMetric.findMany.mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000501",
        stageName: "document-validation",
        status: "completed",
        durationMs: 320,
        errorMessage: null,
        createdAt: new Date("2026-07-09T00:00:00.000Z"),
      },
      {
        id: "00000000-0000-0000-0000-000000000502",
        stageName: "parsing",
        status: "completed",
        durationMs: 1140,
        errorMessage: null,
        createdAt: new Date("2026-07-09T00:00:01.000Z"),
      },
    ]);

    const response = await request(app)
      .get("/api/v1/contracts/00000000-0000-0000-0000-000000000101/metrics")
      .set("x-tenant-id", "00000000-0000-0000-0000-000000000001")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(200);
    expect(response.body.totalStages).toBe(2);
    expect(response.body.stages[0].stageName).toBe("document-validation");
    expect(response.body.stages[1].durationMs).toBe(1140);
  });

  it("returns 404 for metrics of unknown contract", async () => {
    prismaMock.contract.findFirst.mockResolvedValue(null);

    const response = await request(app)
      .get("/api/v1/contracts/00000000-0000-0000-0000-000000000999/metrics")
      .set("x-tenant-id", "00000000-0000-0000-0000-000000000001")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("NOT_FOUND");
  });

  it("hitl decision populates analysisJson on contract", async () => {
    prismaMock.hitlQueueItem.findFirst.mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000401",
      contractId: "00000000-0000-0000-0000-000000000101",
      originalClause: "bad clause",
      riskReason: "high risk",
    });
    prismaMock.hitlQueueItem.update.mockResolvedValue({});
    prismaMock.contract.updateMany.mockResolvedValue({ count: 1 });
    executeMemoryAgentMock.mockResolvedValue({
      collectionsUpdated: ["org_preferences"],
    });

    const response = await request(app)
      .post("/api/v1/contracts/hitl/00000000-0000-0000-0000-000000000401/decision")
      .set("x-tenant-id", "00000000-0000-0000-0000-000000000001")
      .set("Authorization", "Bearer test")
      .send({ decision: "reject", reviewerNotes: "Too risky" });

    expect(response.status).toBe(200);
    // Verify the updateMany call includes analysisJson
    const updateManyCall = prismaMock.contract.updateMany.mock.calls[0]?.[0];
    expect(updateManyCall).toBeDefined();
    if (!updateManyCall) {
      throw new Error("Expected contract.updateMany to be called");
    }
    expect(updateManyCall.data.analysisJson).toBeDefined();
    expect(updateManyCall.data.analysisJson.decision).toBe("reject");
    expect(updateManyCall.data.status).toBe("COMPLETED");
  });
});
