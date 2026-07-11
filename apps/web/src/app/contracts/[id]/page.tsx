"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { API_BASE_URL, getApiHeaders } from "@/lib/api";

type Risk = {
  severity: string;
  description: string;
  triggeringLanguage: string;
  financialExposure: string;
  citation: string;
};
type Rewrite = { text: string; version?: number };
type ClauseBreakdown = {
  clauseIndex: number;
  clauseType: string;
  clauseText: string;
  overallRisk: string;
  risks: Risk[];
  rewrites: Rewrite[];
  benchmarkScore?: number;
  benchmarkPercentile?: number;
  complianceFlags: string[];
  enkryptConfidence: number;
  hitlStatus: string;
};
type AnalysisReport = {
  executiveSummary: string;
  overallRisk: string;
  totalClauses: number;
  criticalCount: number;
  moderateCount: number;
  lowCount: number;
  clauseBreakdown: ClauseBreakdown[];
  jurisdictionFlags: string[];
};
type ContractAnalysisResponse = {
  contractId: string;
  status: string;
  workflowStatus: string;
  reportId: string | null;
  completedAt: string | null;
  analysis: AnalysisReport | null;
};
type ContractStatusResponse = {
  contractId: string;
  workflowStatus: string;
  currentStep: string;
  progress: number;
  status: string;
  updatedAt: string;
};

const PIPELINE_STEPS = [
  "document-validation",
  "parsing",
  "embedding",
  "classification-and-retrieval",
  "risk-and-benchmark",
  "rewrite",
  "compliance",
  "evaluation",
  "hitl-gate",
  "reporting",
];

const riskClass = (risk: string | undefined) =>
  risk === "Critical" ? "high" : risk === "Moderate" ? "medium" : "low";

export default function ContractDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [data, setData] = useState<ContractAnalysisResponse | null>(null);
  const [statusData, setStatusData] = useState<ContractStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeClause, setActiveClause] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const deleteContract = useCallback(async () => {
    if (!window.confirm("Permanently delete this contract? This removes all clauses, embeddings, and HITL history. This cannot be undone.")) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/contracts/${params.id}`, {
        method: "DELETE",
        headers: getApiHeaders(),
      });
      if (!res.ok) throw new Error("Delete failed");
      router.push("/contracts");
    } catch {
      setError("Failed to delete this contract. Check API and retry.");
      setDeleting(false);
    }
  }, [params.id, router]);

  const fetchAnalysis = useCallback(async (): Promise<ContractAnalysisResponse | null> => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/contracts/${params.id}/analysis`, {
        headers: getApiHeaders(),
      });
      if (!res.ok) throw new Error("Contract not found");
      const payload = (await res.json()) as ContractAnalysisResponse;
      setData(payload);
      return payload;
    } catch {
      setError("Unable to load this contract.");
      return null;
    }
  }, [params.id]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/contracts/${params.id}/status`, {
        headers: getApiHeaders(),
      });
      if (!res.ok) return;
      setStatusData((await res.json()) as ContractStatusResponse);
    } catch {
      // keep last known status if the poll fails
    }
  }, [params.id]);

  useEffect(() => {
    void fetchAnalysis();
    void fetchStatus();
  }, [fetchAnalysis, fetchStatus]);

  useEffect(() => {
    if (!data || data.status === "completed" || data.status === "failed") {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(async () => {
      const fresh = await fetchAnalysis();
      await fetchStatus();
      if (fresh && (fresh.status === "completed" || fresh.status === "failed") && pollRef.current) {
        clearInterval(pollRef.current);
      }
    }, 4000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [data, fetchAnalysis, fetchStatus]);

  if (error) {
    return (
      <div className="card" style={{ textAlign: "center", padding: 48 }}>
        <p className="text-muted">{error}</p>
        <Link href="/contracts" className="btn btn-ghost mt-4">← Back to Contracts</Link>
      </div>
    );
  }

  if (!data) {
    return <div className="card">Loading contract…</div>;
  }

  const report = data.analysis;
  const currentStepIndex = statusData ? PIPELINE_STEPS.indexOf(statusData.currentStep) : -1;
  const inProgress = data.status !== "completed" && data.status !== "failed";

  return (
    <>
      <div className="page-header">
        <div>
          <Link href="/contracts" className="btn btn-ghost btn-sm" style={{ marginBottom: 8 }}>
            ← Back to Contracts
          </Link>
          <h1 className="page-title" style={{ fontSize: 18 }}>
            Contract {data.contractId.slice(0, 8)}
          </h1>
          <div className="flex gap-2" style={{ marginTop: 6 }}>
            <span
              className={`status-chip ${
                data.status === "completed" ? "complete" : data.status === "failed" ? "" : "pending"
              }`}
            >
              {data.status}
            </span>
            {report ? (
              <span className={`risk-badge ${riskClass(report.overallRisk)}`}>
                {report.overallRisk?.toUpperCase()}
              </span>
            ) : null}
          </div>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          style={{ color: "var(--risk-high)" }}
          onClick={deleteContract}
          disabled={deleting}
        >
          🗑 {deleting ? "Deleting…" : "Delete Contract"}
        </button>
      </div>

      {inProgress ? (
        <div className="card mb-6">
          <div className="section-title">Pipeline Progress</div>
          <div className="progress-bar" style={{ maxWidth: 400 }}>
            <div className="progress-fill" style={{ width: `${statusData?.progress ?? 0}%` }} />
          </div>
          <p className="text-sm text-muted mt-4">
            Current step: {statusData?.currentStep ?? "starting"} ({statusData?.progress ?? 0}%)
          </p>
          <div className="card-sm mt-4" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {PIPELINE_STEPS.map((step, i) => (
              <div key={step} className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
                <span
                  style={{
                    color:
                      i < currentStepIndex
                        ? "var(--risk-low)"
                        : i === currentStepIndex
                          ? "var(--accent)"
                          : "var(--text-muted)",
                    fontWeight: 700,
                    width: 20,
                    textAlign: "right",
                  }}
                >
                  {i < currentStepIndex ? "✓" : i + 1}
                </span>
                <span style={{ color: i <= currentStepIndex ? "var(--text-primary)" : "var(--text-secondary)" }}>
                  {step}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {data.status === "failed" ? (
        <div className="card" style={{ borderLeft: "3px solid var(--risk-high)" }}>
          <p style={{ color: "var(--risk-high)" }}>
            Analysis failed. Check the API logs or GET /api/v1/audit/trace/:traceId for details.
          </p>
        </div>
      ) : null}

      {report ? (
        <>
          <div className="two-col mb-6">
            <div className="card">
              <div className="section-title">Executive Summary</div>
              <p className="text-sm text-muted" style={{ lineHeight: 1.7 }}>
                {report.executiveSummary}
              </p>
            </div>
            <div className="card">
              <div className="section-title">Risk Distribution</div>
              <div style={{ display: "flex", gap: 24 }}>
                <div>
                  <div className="metric-value" style={{ color: "var(--risk-high)" }}>
                    {report.criticalCount}
                  </div>
                  <div className="metric-label">Critical</div>
                </div>
                <div>
                  <div className="metric-value" style={{ color: "var(--risk-med)" }}>
                    {report.moderateCount}
                  </div>
                  <div className="metric-label">Moderate</div>
                </div>
                <div>
                  <div className="metric-value" style={{ color: "var(--risk-low)" }}>
                    {report.lowCount}
                  </div>
                  <div className="metric-label">Low</div>
                </div>
              </div>
            </div>
          </div>

          <div className="section-title">
            Clause-by-Clause Breakdown <span>{report.totalClauses} clauses</span>
          </div>
          <div className="review-split">
            <div className="review-clause-panel">
              {report.clauseBreakdown.map((clause, i) => (
                <div
                  key={clause.clauseIndex}
                  className={`clause-item ${activeClause === i ? "active" : ""} ${
                    clause.overallRisk === "Critical" ? "flagged" : ""
                  }`}
                  onClick={() => setActiveClause(i)}
                >
                  <div className="clause-type">{clause.clauseType.replace(/_/g, " ")}</div>
                  <div className="clause-text">
                    {clause.clauseText.slice(0, 140)}
                    {clause.clauseText.length > 140 ? "…" : ""}
                  </div>
                </div>
              ))}
            </div>
            <div className="review-action-panel">
              {report.clauseBreakdown[activeClause] ? (
                <ClauseDetail clause={report.clauseBreakdown[activeClause]} />
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

function ClauseDetail({ clause }: { clause: ClauseBreakdown }) {
  const cls = riskClass(clause.overallRisk);
  return (
    <>
      <div className="risk-detail">
        <div className="risk-score-ring">
          <div className={`score-circle ${cls}`}>{clause.overallRisk?.[0] ?? "?"}</div>
          <div>
            <div style={{ fontWeight: 700 }}>{clause.overallRisk} Risk</div>
            <div className="text-sm text-muted">
              Benchmark: {clause.benchmarkScore ?? "N/A"}th percentile
            </div>
          </div>
        </div>
        <div className="risk-findings">
          {clause.risks.map((risk, i) => (
            <div key={i} className="finding-item">
              <span className="finding-icon">⚠</span>
              <div>
                <strong>{risk.severity}:</strong> {risk.description}
                <div className="text-muted" style={{ marginTop: 4 }}>
                  Financial exposure: {risk.financialExposure}
                </div>
              </div>
            </div>
          ))}
          {clause.risks.length === 0 ? (
            <p className="text-sm text-muted">No specific risks flagged for this clause.</p>
          ) : null}
        </div>
      </div>

      {clause.rewrites.length > 0 ? (
        <div className="risk-detail">
          <div className="decision-label">Suggested Rewrite</div>
          <p className="text-sm text-muted" style={{ lineHeight: 1.7 }}>
            {clause.rewrites[0].text}
          </p>
        </div>
      ) : null}

      {clause.complianceFlags.length > 0 ? (
        <div className="risk-detail">
          <div className="decision-label">Compliance Flags</div>
          {clause.complianceFlags.map((flag, i) => (
            <p key={i} className="text-sm text-muted">
              {flag}
            </p>
          ))}
        </div>
      ) : null}
    </>
  );
}
