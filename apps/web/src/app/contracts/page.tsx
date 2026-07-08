"use client";
import Link from "next/link";

export default function ContractsPage() {
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Contract Repository</h1>
          <p className="page-subtitle">View and search all processed legal documents</p>
        </div>
        <button className="btn btn-primary btn-sm">+ Upload Contract</button>
      </div>

      <div className="card" style={{ textAlign: "center", padding: "64px 20px", marginTop: 24 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>📂</div>
        <h2 style={{ marginBottom: 8 }}>Contract Repository (Coming Soon)</h2>
        <p style={{ color: "var(--text-secondary)", maxWidth: 500, margin: "0 auto 24px", lineHeight: 1.6 }}>
          This feature is scheduled for Phase 6. It will include full-text semantic search via Qdrant, document versioning, and direct integration with your AWS S3 bucket.
        </p>
        <Link href="/" className="btn btn-ghost">← Return to Dashboard</Link>
      </div>
    </>
  );
}
