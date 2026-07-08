"use client";
import Link from "next/link";

export default function SettingsPage() {
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Platform Settings</h1>
          <p className="page-subtitle">Manage users, API keys, and workflow configurations</p>
        </div>
      </div>

      <div className="card" style={{ textAlign: "center", padding: "64px 20px", marginTop: 24 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚙️</div>
        <h2 style={{ marginBottom: 8 }}>Settings Module (Coming Soon)</h2>
        <p style={{ color: "var(--text-secondary)", maxWidth: 500, margin: "0 auto 24px", lineHeight: 1.6 }}>
          This feature is scheduled for Phase 6. It will allow administrators to manage API integrations (Mastra, OpenAI, Qdrant, Enkrypt), adjust risk thresholds, and invite team members.
        </p>
        <Link href="/" className="btn btn-ghost">← Return to Dashboard</Link>
      </div>
    </>
  );
}
