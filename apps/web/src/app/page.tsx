"use client";
import { useState, useCallback } from "react";
import Link from "next/link";

const MOCK_CONTRACTS = [
  { id: "c-001", name: "Acme Corp — SaaS Subscription Agreement v3.pdf", type: "SaaS", risk: "high",   status: "pending",   date: "2026-07-07", score: 78 },
  { id: "c-002", name: "TechFlow — NDA Mutual Confidentiality 2026.pdf",  type: "NDA", risk: "low",    status: "complete",  date: "2026-07-06", score: 12 },
  { id: "c-003", name: "GlobalEdge — Master Service Agreement Q3.pdf",    type: "MSA", risk: "medium", status: "reviewing", date: "2026-07-06", score: 54 },
  { id: "c-004", name: "Nexus Labs — IP Assignment & License Grant.pdf",  type: "IP",  risk: "high",   status: "pending",   date: "2026-07-05", score: 91 },
  { id: "c-005", name: "Orbit Systems — Employment Agreement Sr.Eng.pdf", type: "EMP", risk: "low",    status: "complete",  date: "2026-07-04", score: 8  },
];

export default function DashboardPage() {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    setUploading(true);
    setTimeout(() => setUploading(false), 2500);
  }, []);

  return (
    <>
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Monday, 7 July 2026 · India Standard Time</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-ghost btn-sm">⬇ Export Report</button>
          <button className="btn btn-primary btn-sm">+ New Analysis</button>
        </div>
      </div>

      {/* Metrics */}
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-icon">📄</div>
          <div className="metric-value">142</div>
          <div className="metric-label">Contracts Analyzed</div>
          <div className="metric-delta">↑ 12 this week</div>
        </div>
        <div className="metric-card danger">
          <div className="metric-icon danger">⚠</div>
          <div className="metric-value" style={{ color: "var(--risk-high)" }}>7</div>
          <div className="metric-label">Pending HITL Review</div>
          <div className="metric-delta" style={{ color: "var(--risk-high)" }}>Requires attention</div>
        </div>
        <div className="metric-card warning">
          <div className="metric-icon warning">🚩</div>
          <div className="metric-value" style={{ color: "var(--risk-med)" }}>3</div>
          <div className="metric-label">High Risk Flagged</div>
          <div className="metric-delta" style={{ color: "var(--risk-med)" }}>Enkrypt score &lt; 0.70</div>
        </div>
        <div className="metric-card success">
          <div className="metric-icon success">✓</div>
          <div className="metric-value" style={{ color: "var(--risk-low)" }}>94.2%</div>
          <div className="metric-label">Compliance Rate</div>
          <div className="metric-delta">↑ 2.1% vs last month</div>
        </div>
      </div>

      {/* Upload + Table */}
      <div className="two-col mb-6">
        {/* Upload Zone */}
        <div>
          <div className="section-title">Upload Contract</div>
          <div
            className={`upload-zone ${dragging ? "dragging" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => document.getElementById("file-input")?.click()}
          >
            <input id="file-input" type="file" accept=".pdf,.docx,.doc" style={{ display: "none" }} />
            {uploading ? (
              <>
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
                  <div className="spinner" style={{ width: 36, height: 36 }} />
                </div>
                <div className="upload-title">Processing contract…</div>
                <div className="upload-subtitle">13-agent pipeline running</div>
                <div className="progress-bar" style={{ maxWidth: 240, margin: "16px auto 0" }}>
                  <div className="progress-fill" style={{ width: "60%" }} />
                </div>
              </>
            ) : (
              <>
                <div className="upload-icon">📂</div>
                <div className="upload-title">Drop contract here</div>
                <div className="upload-subtitle">or click to browse files</div>
                <div className="upload-types">
                  <span className="upload-type-badge">PDF</span>
                  <span className="upload-type-badge">DOCX</span>
                  <span className="upload-type-badge">DOC</span>
                </div>
              </>
            )}
          </div>

          <div className="card card-sm mt-4">
            <div className="section-title" style={{ marginBottom: 12 }}>Pipeline Steps</div>
            {["Document Validation", "OCR & Parsing", "Embedding → Qdrant", "Classification + Retrieval", "Risk Analysis + Benchmark", "Rewrite Suggestions", "Compliance Check", "Enkrypt Safety (10-stage)", "HITL Gate", "Report Generation"].map((step, i) => (
              <div key={i} className="flex items-center gap-2 mb-4" style={{ fontSize: 12.5 }}>
                <span style={{ color: "var(--accent)", fontWeight: 700, width: 20, textAlign: "right" }}>{i + 1}</span>
                <span style={{ color: "var(--text-secondary)" }}>{step}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Quick Stats */}
        <div>
          <div className="section-title">Recent Contracts</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Risk</th>
                  <th>Status</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {MOCK_CONTRACTS.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/contracts/${c.id}`} style={{ color: "var(--text-primary)" }}>
                        <div style={{ maxWidth: 220 }} className="truncate">{c.name}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{c.type} · {c.date}</div>
                      </Link>
                    </td>
                    <td>
                      <span className={`risk-badge ${c.risk}`}>{c.risk.toUpperCase()}</span>
                    </td>
                    <td>
                      <span className={`status-chip ${c.status}`}>{c.status}</span>
                    </td>
                    <td style={{ color: c.score > 70 ? "var(--risk-high)" : c.score > 40 ? "var(--risk-med)" : "var(--risk-low)", fontWeight: 700 }}>
                      {c.score}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Link href="/contracts" className="btn btn-ghost btn-sm mt-4">View all contracts →</Link>
        </div>
      </div>
    </>
  );
}
