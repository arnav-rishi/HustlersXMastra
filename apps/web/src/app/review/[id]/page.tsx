"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { API_BASE_URL, getApiHeaders } from "@/lib/api";


type HitlItem = {
  id: string;
  contractId: string;
  clauseIndex: number;
  reason: string;
  originalClause: string;
  aiSuggestion: string | null;
  riskReason: string | null;
  confidenceScore: number | null;
  status: string;
};

export default function ReviewDetailPage({ params }: { params: { id: string } }) {
  const [item, setItem] = useState<HitlItem | null>(null);
  const [decision, setDecision] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/contracts/hitl/${params.id}`, {
          headers: getApiHeaders(),
        });
        if (!response.ok) {
          throw new Error("Failed to load HITL item");
        }
        const payload = await response.json();
        setItem(payload);
      } catch {
        setError("Unable to load this HITL review item.");
      } finally {
        setLoading(false);
      }
    })();
  }, [params.id]);

  const handleSubmit = async () => {
    if (!decision) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/contracts/hitl/${params.id}/decision`, {
        method: "POST",
        headers: {
          ...getApiHeaders(true),
        },
        body: JSON.stringify({
          decision,
          reviewerNotes: note,
        }),
      });
      if (!response.ok) {
        throw new Error("Decision submit failed");
      }
      setSubmitted(true);
    } catch {
      setError("Failed to submit review decision.");
    }
  };

  if (loading) {
    return <div className="card">Loading HITL item...</div>;
  }

  if (!item) {
    return <div className="card">{error ?? "HITL item not found."}</div>;
  }

  return (
    <>
      <div className="page-header">
        <div>
          <Link href="/review" className="btn btn-ghost btn-sm" style={{ marginBottom: 8 }}>← Back to Queue</Link>
          <h1 className="page-title" style={{ fontSize: 18 }}>Contract {item.contractId}</h1>
          <div className="flex gap-2" style={{ marginTop: 6 }}>
            <span className="tag">HITL-{params.id}</span>
            <span className={`risk-badge ${(item.confidenceScore ?? 1) < 0.6 ? "high" : "medium"}`}>
              {(item.confidenceScore ?? 1) < 0.6 ? "HIGH RISK" : "MEDIUM RISK"}
            </span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Enkrypt Confidence: {((item.confidenceScore ?? 0) * 100).toFixed(0)}% · Clause #{item.clauseIndex} · Reason: {item.reason}
            </span>
          </div>
        </div>
        {!submitted && <button className="btn btn-primary" onClick={handleSubmit} disabled={!decision}>Submit Decision</button>}
        {submitted && <div className="tag" style={{ fontSize: 13, padding: "8px 16px" }}>✓ Decision Submitted</div>}
      </div>

      {submitted ? (
        <div className="card" style={{ textAlign: "center", padding: 48 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
          <h2 style={{ marginBottom: 8 }}>Decision Recorded</h2>
          <p style={{ color: "var(--text-secondary)", marginBottom: 24 }}>
            The {decision} decision has been saved to the audit log and the workflow has been resumed.
            Memory Agent will update risk patterns in Qdrant.
          </p>
          <Link href="/review" className="btn btn-primary">Return to Queue</Link>
        </div>
      ) : (
        <div className="review-action-panel">
          <div className="risk-detail">
            <div className="decision-label">Clause Text</div>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.7 }}>{item.originalClause}</p>
          </div>

          {item.aiSuggestion ? (
            <div className="risk-detail">
              <div className="decision-label">AI Rewrite Suggestion</div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.7 }}>{item.aiSuggestion}</p>
            </div>
          ) : null}

          <div className="risk-detail">
            <div className="decision-label">Risk Reason</div>
            <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>{item.riskReason ?? "No risk reason provided."}</p>
          </div>

          <div className="decision-panel">
            <div className="decision-label">Your Decision</div>
            <div className="decision-buttons">
              <button
                className={`btn w-full ${decision === "approve" ? "btn-success" : "btn-ghost"}`}
                onClick={() => setDecision("approve")}
              >✓ Approve — Send to Reporting</button>
              <button
                className={`btn w-full ${decision === "reject" ? "btn-danger" : "btn-ghost"}`}
                onClick={() => setDecision("reject")}
              >✕ Reject — Block Contract</button>
              <button
                className={`btn w-full ${decision === "edit" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setDecision("edit")}
              >✎ Approve with Rewrite</button>
            </div>
            <textarea
              className="note-input"
              placeholder="Add notes for the audit log (optional)…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            {error ? <div style={{ color: "var(--risk-high)", fontSize: 12 }}>{error}</div> : null}
          </div>
        </div>
      )}
    </>
  );
}
