"use client";
import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { API_BASE_URL, getApiHeaders } from "@/lib/api";
import { downloadCsv } from "@/lib/export";

type DashboardContract = {
  id: string;
  name: string;
  type: string;
  risk: string;
  status: string;
  date: string;
};

type DashboardMetrics = {
  totalContracts: number;
  riskCounts: { critical: number; moderate: number; low: number };
  hitl: { pending: number; decided: number };
  // Real value from GET /api/v1/analytics/summary — null when there are no
  // completed contracts yet to compute a rate from.
  complianceRatePct: number | null;
};

export default function DashboardPage() {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [recentContracts, setRecentContracts] = useState<DashboardContract[]>([]);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const uploadZoneRef = useRef<HTMLDivElement>(null);

  const fetchRecentContracts = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/contracts/pending`, {
        headers: getApiHeaders(),
      });
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as { items?: DashboardContract[] };
      setRecentContracts(Array.isArray(payload.items) ? payload.items : []);
    } catch {
      // Keep dashboard usable if API is unavailable.
      setRecentContracts([]);
    }
  }, []);

  const fetchMetrics = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/analytics/summary`, {
        headers: getApiHeaders(),
      });
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as DashboardMetrics;
      setMetrics(payload);
    } catch {
      setMetrics(null);
    }
  }, []);

  useEffect(() => {
    void fetchRecentContracts();
    void fetchMetrics();
  }, [fetchRecentContracts, fetchMetrics]);

  const analyzeContract = useCallback(async (file: File) => {
    setUploading(true);
    setUploadMessage(null);
    try {
      // Send the real file bytes via multipart upload so the server extracts
      // actual text (real PDF/DOCX parsing) instead of relying on the browser's
      // file.text() — which only produces readable text for plain .txt files
      // and garbles binary formats like PDF.
      const formData = new FormData();
      formData.append("contract", file);
      formData.append("jurisdiction", "Unknown");
      formData.append("priority", "standard");

      const response = await fetch(`${API_BASE_URL}/api/v1/contracts/upload`, {
        method: "POST",
        headers: getApiHeaders(), // no Content-Type — browser sets the multipart boundary
        body: formData,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message ?? "Failed to start analysis");
      }

      setUploadMessage("Contract accepted. 13-agent workflow started.");
      await fetchRecentContracts();
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : "Unable to start analysis. Check API and retry.");
    } finally {
      setUploading(false);
      setFileInputKey((prev) => prev + 1);
    }
  }, [fetchRecentContracts]);

  const onDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = (e.dataTransfer as DataTransfer).files?.[0];
    if (!file) return;
    await analyzeContract(file);
  }, [analyzeContract]);

  return (
    <>
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Monday, 7 July 2026 · India Standard Time</p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              if (recentContracts.length === 0) return;
              downloadCsv(
                `lexguard-contracts-${new Date().toISOString().slice(0, 10)}.csv`,
                recentContracts.map((c) => ({
                  id: c.id,
                  name: c.name,
                  type: c.type,
                  risk: c.risk,
                  status: c.status,
                  date: c.date,
                }))
              );
            }}
            disabled={recentContracts.length === 0}
          >
            ⬇ Export Report
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              uploadZoneRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
              document.getElementById("file-input")?.click();
            }}
          >
            + New Analysis
          </button>
        </div>
      </div>

      {/* Metrics */}
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-icon">📄</div>
          <div className="metric-value">{metrics ? metrics.totalContracts : "—"}</div>
          <div className="metric-label">Contracts Analyzed</div>
          <div className="metric-delta">All-time total</div>
        </div>
        <div className="metric-card danger">
          <div className="metric-icon danger">⚠</div>
          <div className="metric-value" style={{ color: "var(--risk-high)" }}>{metrics ? metrics.hitl.pending : "—"}</div>
          <div className="metric-label">Pending HITL Review</div>
          <div className="metric-delta" style={{ color: "var(--risk-high)" }}>
            {metrics && metrics.hitl.pending > 0 ? "Requires attention" : "None pending"}
          </div>
        </div>
        <div className="metric-card warning">
          <div className="metric-icon warning">🚩</div>
          <div className="metric-value" style={{ color: "var(--risk-med)" }}>{metrics ? metrics.riskCounts.critical : "—"}</div>
          <div className="metric-label">High Risk Flagged</div>
          <div className="metric-delta" style={{ color: "var(--risk-med)" }}>Enkrypt score &lt; 0.70</div>
        </div>
        <div className="metric-card success">
          <div className="metric-icon success">✓</div>
          <div className="metric-value" style={{ color: "var(--risk-low)" }}>
            {metrics && metrics.complianceRatePct !== null ? `${metrics.complianceRatePct}%` : "—"}
          </div>
          <div className="metric-label">Compliance Rate</div>
          <div className="metric-delta">Across all analyzed contracts</div>
        </div>
      </div>

      {/* Upload + Table */}
      <div className="two-col mb-6">
        {/* Upload Zone */}
        <div>
          <div className="section-title">Upload Contract</div>
          <div
            ref={uploadZoneRef}
            className={`upload-zone ${dragging ? "dragging" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => (document.getElementById("file-input") as HTMLInputElement | null)?.click()}
          >
            <input
              key={fileInputKey}
              id="file-input"
              type="file"
              accept=".pdf,.docx,.doc,.txt"
              style={{ display: "none" }}
              onChange={async (e: React.ChangeEvent<HTMLInputElement>) => {
                const file = e.target.files?.[0];
                if (!file) return;
                await analyzeContract(file);
              }}
            />
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
          {uploadMessage ? (
            <div className="card card-sm mt-4" style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
              {uploadMessage}
            </div>
          ) : null}

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
                {recentContracts.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/contracts/${c.id}`} style={{ color: "var(--text-primary)" }}>
                        <div style={{ maxWidth: 220 }} className="truncate">{c.name}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{c.type} · {c.date}</div>
                      </Link>
                    </td>
                    <td>
                      <span className={`risk-badge ${c.risk === "critical" ? "high" : c.risk}`}>{c.risk.toUpperCase()}</span>
                    </td>
                    <td>
                      <span className={`status-chip ${c.status}`}>{c.status}</span>
                    </td>
                    <td style={{ color: "var(--text-secondary)", fontWeight: 700 }}>
                      --
                    </td>
                  </tr>
                ))}
                {recentContracts.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ color: "var(--text-muted)" }}>
                      No pending contracts found in database.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <Link href="/contracts" className="btn btn-ghost btn-sm mt-4">View all contracts →</Link>
        </div>
      </div>
    </>
  );
}
