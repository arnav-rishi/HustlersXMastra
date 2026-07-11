"use client";
import { useEffect, useState } from "react";
import { API_BASE_URL, getApiHeaders } from "@/lib/api";
import { downloadCsv } from "@/lib/export";

type AnalyticsSummary = {
  totalContracts: number;
  statusCounts: Record<string, number>;
  riskCounts: { critical: number; moderate: number; low: number };
  hitl: { pending: number; decided: number };
  complianceRatePct: number | null;
  avgProcessingMs: number | null;
  completedCount: number;
};

function formatDuration(ms: number | null): string {
  if (ms === null) return "N/A";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s`;
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/analytics/summary`, {
          headers: getApiHeaders(),
        });
        if (!response.ok) throw new Error("Failed to load analytics");
        setData((await response.json()) as AnalyticsSummary);
      } catch {
        setError("Unable to load analytics. Check API connectivity.");
      }
    })();
  }, []);

  const totalRisk = data ? data.riskCounts.critical + data.riskCounts.moderate + data.riskCounts.low : 0;
  const riskPct = (n: number) => (totalRisk > 0 ? Math.round((n / totalRisk) * 100) : 0);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Analytics & Intelligence</h1>
          <p className="page-subtitle">Platform metrics, agent performance, and risk trends</p>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            if (!data) return;
            downloadCsv(`lexguard-analytics-${new Date().toISOString().slice(0, 10)}.csv`, [
              {
                totalContracts: data.totalContracts,
                critical: data.riskCounts.critical,
                moderate: data.riskCounts.moderate,
                low: data.riskCounts.low,
                hitlPending: data.hitl.pending,
                hitlDecided: data.hitl.decided,
                complianceRatePct: data.complianceRatePct,
                avgProcessingMs: data.avgProcessingMs,
              },
            ]);
          }}
          disabled={!data}
        >
          Generate Report
        </button>
      </div>

      {error ? (
        <div className="card" style={{ textAlign: "center", padding: 48 }}>
          <p className="text-muted">{error}</p>
        </div>
      ) : !data ? (
        <div className="card">Loading analytics…</div>
      ) : (
        <>
          <div className="metrics-grid">
            <div className="metric-card">
              <div className="metric-icon">📄</div>
              <div className="metric-value">{data.totalContracts}</div>
              <div className="metric-label">Total Contracts</div>
              <div className="metric-delta">{data.completedCount} completed</div>
            </div>
            <div className="metric-card danger">
              <div className="metric-icon danger">⚠</div>
              <div className="metric-value" style={{ color: "var(--risk-high)" }}>
                {data.hitl.pending}
              </div>
              <div className="metric-label">Pending HITL Review</div>
              <div className="metric-delta" style={{ color: "var(--risk-high)" }}>
                {data.hitl.decided} decided historically
              </div>
            </div>
            <div className="metric-card success">
              <div className="metric-icon success">✓</div>
              <div className="metric-value" style={{ color: "var(--risk-low)" }}>
                {data.complianceRatePct === null ? "N/A" : `${data.complianceRatePct}%`}
              </div>
              <div className="metric-label">Compliance Rate</div>
              <div className="metric-delta">Across completed contracts</div>
            </div>
            <div className="metric-card">
              <div className="metric-icon">⏱</div>
              <div className="metric-value">{formatDuration(data.avgProcessingMs)}</div>
              <div className="metric-label">Avg Processing Time</div>
              <div className="metric-delta">Upload → report</div>
            </div>
          </div>

          <div className="two-col mb-6">
            <div className="card">
              <div className="section-title">Risk Distribution</div>
              {(["critical", "moderate", "low"] as const).map((tier) => (
                <div key={tier} style={{ marginBottom: 14 }}>
                  <div className="flex" style={{ justifyContent: "space-between", marginBottom: 4 }}>
                    <span className="text-sm" style={{ textTransform: "capitalize" }}>
                      {tier}
                    </span>
                    <span className="text-sm text-muted">
                      {data.riskCounts[tier]} ({riskPct(data.riskCounts[tier])}%)
                    </span>
                  </div>
                  <div className="progress-bar">
                    <div
                      className="progress-fill"
                      style={{
                        width: `${riskPct(data.riskCounts[tier])}%`,
                        background:
                          tier === "critical"
                            ? "var(--risk-high)"
                            : tier === "moderate"
                              ? "var(--risk-med)"
                              : "var(--risk-low)",
                      }}
                    />
                  </div>
                </div>
              ))}
              {totalRisk === 0 ? (
                <p className="text-sm text-muted">No completed contracts with risk data yet.</p>
              ) : null}
            </div>

            <div className="card">
              <div className="section-title">Workflow Status</div>
              {Object.entries(data.statusCounts).length === 0 ? (
                <p className="text-sm text-muted">No contracts processed yet.</p>
              ) : (
                Object.entries(data.statusCounts).map(([status, count]) => (
                  <div
                    key={status}
                    className="flex"
                    style={{
                      justifyContent: "space-between",
                      padding: "8px 0",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <span className="text-sm" style={{ textTransform: "capitalize" }}>
                      {status.replace(/_/g, " ")}
                    </span>
                    <span style={{ fontWeight: 700 }}>{count}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
