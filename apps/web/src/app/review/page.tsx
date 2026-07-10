"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { API_BASE_URL, getApiHeaders } from "@/lib/api";


type QueueItem = {
  id: string;
  contractId: string;
  clauseIndex: number;
  reason: string;
  confidenceScore: number | null;
  status: string;
  createdAt: string;
  slaDeadline: string;
};

export default function ReviewQueuePage() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/contracts/hitl/queue`, {
          headers: getApiHeaders(),
        });
        if (!response.ok) {
          throw new Error("Failed to load review queue");
        }
        const payload = (await response.json()) as { items?: QueueItem[] };
        setItems(Array.isArray(payload.items) ? payload.items : []);
      } catch {
        setError("Unable to load live HITL queue.");
      }
    })();
  }, []);

  const stats = useMemo(() => {
    const highRisk = items.filter((item) => (item.confidenceScore ?? 1) < 0.6).length;
    const mediumRisk = items.filter((item) => {
      const score = item.confidenceScore ?? 1;
      return score >= 0.6 && score < 0.7;
    }).length;
    const avgConfidence = items.length
      ? items.reduce((acc, item) => acc + (item.confidenceScore ?? 0), 0) / items.length
      : 0;
    return { highRisk, mediumRisk, avgConfidence };
  }, [items]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">HITL Review Queue</h1>
          <p className="page-subtitle">Contracts flagged for human review · Enkrypt confidence &lt; 0.70</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-ghost btn-sm">⬇ Export Queue</button>
          <div className="tag">{items.length} PENDING</div>
        </div>
      </div>

      {/* Summary Metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
        <div className="card card-sm" style={{ borderLeft: "3px solid var(--risk-high)" }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>HIGH RISK</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--risk-high)" }}>{stats.highRisk}</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Confidence &lt; 0.60 · Immediate action</div>
        </div>
        <div className="card card-sm" style={{ borderLeft: "3px solid var(--risk-med)" }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>MEDIUM RISK</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--risk-med)" }}>{stats.mediumRisk}</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Confidence 0.60–0.70 · Review today</div>
        </div>
        <div className="card card-sm" style={{ borderLeft: "3px solid var(--accent)" }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>AVG CONFIDENCE</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--accent)" }}>{stats.avgConfidence.toFixed(2)}</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Across pending items</div>
        </div>
      </div>

      <div className="section-title">Pending Reviews</div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Contract</th>
              <th>Risk</th>
              <th>AI Confidence</th>
              <th>Flagged Clauses</th>
              <th>Jurisdiction</th>
              <th>Assigned To</th>
              <th>Due</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <div style={{ maxWidth: 280 }} className="truncate">Contract {item.contractId}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>Clause #{item.clauseIndex}</div>
                </td>
                <td>
                  <span className={`risk-badge ${(item.confidenceScore ?? 1) < 0.6 ? "high" : "medium"}`}>
                    {((item.confidenceScore ?? 0) < 0.6 ? "high" : "medium").toUpperCase()}
                  </span>
                </td>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 700, color: (item.confidenceScore ?? 1) < 0.60 ? "var(--risk-high)" : "var(--risk-med)" }}>
                      {((item.confidenceScore ?? 0) * 100).toFixed(0)}%
                    </span>
                    <div className="progress-bar" style={{ width: 60 }}>
                      <div className="progress-fill" style={{ width: `${(item.confidenceScore ?? 0) * 100}%`, background: (item.confidenceScore ?? 1) < 0.60 ? "var(--risk-high)" : "var(--risk-med)" }} />
                    </div>
                  </div>
                </td>
                <td style={{ fontWeight: 700 }}>1</td>
                <td><span className="tag" style={{ fontSize: 9 }}>N/A</span></td>
                <td style={{ color: "var(--text-muted)" }}>Unassigned</td>
                <td style={{ color: "var(--text-secondary)", fontWeight: 600 }}>{new Date(item.slaDeadline).toLocaleString()}</td>
                <td>
                  <Link href={`/review/${item.id}`} className="btn btn-primary btn-sm">Review →</Link>
                </td>
              </tr>
            ))}
            {items.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ color: "var(--text-muted)" }}>
                  {error ?? "No pending HITL reviews."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
