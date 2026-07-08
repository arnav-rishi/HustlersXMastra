"use client";
import Link from "next/link";

export default function AnalyticsPage() {
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Analytics & Intelligence</h1>
          <p className="page-subtitle">Platform metrics, agent performance, and risk trends</p>
        </div>
        <button className="btn btn-ghost btn-sm">Generate Report</button>
      </div>

      <div className="card" style={{ textAlign: "center", padding: "64px 20px", marginTop: 24 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>📊</div>
        <h2 style={{ marginBottom: 8 }}>Analytics Dashboard (Coming Soon)</h2>
        <p style={{ color: "var(--text-secondary)", maxWidth: 500, margin: "0 auto 24px", lineHeight: 1.6 }}>
          This feature is scheduled for Phase 6. It will include charts mapping organisational risk exposure over time, Enkrypt AI safety metrics, and historical compliance rates.
        </p>
        <Link href="/" className="btn btn-primary">← Return to Dashboard</Link>
      </div>
    </>
  );
}
