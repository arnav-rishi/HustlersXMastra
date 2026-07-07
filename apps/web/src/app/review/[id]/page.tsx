"use client";
import { useState } from "react";
import Link from "next/link";

const CLAUSES = [
  { id: 1, type: "Limitation of Liability", flagged: true,  risk: "high",   text: 'IN NO EVENT SHALL VENDOR BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, PUNITIVE, OR CONSEQUENTIAL DAMAGES... regardless of whether vendor has been advised of the possibility of such damages, and notwithstanding any failure of essential purpose of any limited remedy.', findings: ["Uncapped liability waiver", "No carve-out for gross negligence or wilful misconduct", "Conflicts with CCPA §1798.150"] },
  { id: 2, type: "Data Processing",          flagged: true,  risk: "high",   text: "Vendor may collect, store, process and share Customer Data with third-party sub-processors globally for the purpose of providing, improving, and developing new services. Customer grants Vendor an irrevocable, perpetual, worldwide licence to use Customer Data in anonymised or aggregated form.", findings: ["Irrevocable data rights are excessive", "No list of approved sub-processors", "GDPR Article 28 DPA required"] },
  { id: 3, type: "Auto-Renewal",             flagged: true,  risk: "medium", text: "This Agreement shall automatically renew for successive one (1) year terms unless either party provides written notice of non-renewal at least 90 days prior to the end of the then-current term.", findings: ["90-day notice period is excessive (market standard: 30 days)", "No price cap on renewal terms"] },
  { id: 4, type: "Governing Law",            flagged: false, risk: "low",    text: "This Agreement shall be governed by and construed in accordance with the laws of the State of California, without regard to its conflict of law provisions.", findings: [] },
  { id: 5, type: "IP Ownership",             flagged: true,  risk: "high",   text: "Any improvements, modifications, or derivative works created by Vendor using Customer Data or in connection with the Services shall be owned exclusively by Vendor.", findings: ["Customer data used to build IP assigned to Vendor", "Work-for-hire doctrine may not apply", "Conflicts with trade secret protections"] },
  { id: 6, type: "Termination",              flagged: false, risk: "low",    text: "Either party may terminate this Agreement for convenience upon thirty (30) days written notice. Upon termination, Customer shall pay all fees due through the termination date.", findings: [] },
];

const REWRITES: Record<number, string[]> = {
  1: [
    "Vendor's total cumulative liability shall not exceed the fees paid by Customer in the 12 months preceding the claim. This limitation shall not apply to (i) gross negligence or wilful misconduct, (ii) death or personal injury, or (iii) any breach of confidentiality obligations.",
    "Each party's liability shall be limited to direct damages up to the value of the contract. Neither party waives liability for intentional acts or fraud.",
  ],
  2: [
    "Vendor may process Customer Data solely to provide the contracted Services. Vendor shall not use Customer Data for product development or share with third parties without prior written consent. A list of approved sub-processors is attached as Schedule B.",
    "Vendor may only process Customer Data as directed by Customer (Controller) under a separate Data Processing Agreement compliant with GDPR Article 28 and CCPA regulations.",
  ],
  3: [
    "This Agreement shall automatically renew unless either party provides written notice of non-renewal at least 30 days prior to expiry. Renewal pricing shall not exceed a 5% increase over the prior term's fees.",
    "This Agreement shall renew annually unless cancelled by either party with 30 days' notice. Vendor shall send a renewal reminder no later than 60 days before expiry.",
  ],
  5: [
    "All intellectual property created by Vendor specifically for Customer under this Agreement shall be owned by Customer. Vendor retains ownership of its pre-existing IP and general know-how.",
    "Improvements made using Customer Data shall be owned by Customer. Vendor retains a non-exclusive, royalty-free licence to use anonymised learnings solely to improve service quality.",
  ],
};

export default function ReviewDetailPage({ params }: { params: { id: string } }) {
  const [selectedClause, setSelectedClause] = useState(CLAUSES[0]);
  const [decision, setDecision] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [selectedRewrite, setSelectedRewrite] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const rewrites = REWRITES[selectedClause.id] ?? [];

  const handleSubmit = () => {
    if (!decision) return;
    setSubmitted(true);
  };

  return (
    <>
      <div className="page-header">
        <div>
          <Link href="/review" className="btn btn-ghost btn-sm" style={{ marginBottom: 8 }}>← Back to Queue</Link>
          <h1 className="page-title" style={{ fontSize: 18 }}>Acme Corp — SaaS Subscription Agreement v3.pdf</h1>
          <div className="flex gap-2" style={{ marginTop: 6 }}>
            <span className="tag">HITL-{params.id}</span>
            <span className="risk-badge high">HIGH RISK</span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Enkrypt Confidence: 61% · 4 flagged clauses · US-CA</span>
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
        <div className="review-split">
          {/* Clause List */}
          <div className="review-clause-panel">
            <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)" }}>
              {CLAUSES.length} Clauses · {CLAUSES.filter(c => c.flagged).length} Flagged
            </div>
            {CLAUSES.map((c) => (
              <div
                key={c.id}
                className={`clause-item ${selectedClause.id === c.id ? "active" : ""} ${c.flagged ? "flagged" : ""}`}
                onClick={() => { setSelectedClause(c); setSelectedRewrite(null); }}
              >
                <div className="clause-type">{c.type} {c.flagged && <span className={`risk-badge ${c.risk}`} style={{ marginLeft: 6 }}>{c.risk}</span>}</div>
                <div className="clause-text" style={{ WebkitLineClamp: 2, display: "-webkit-box", WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {c.text}
                </div>
              </div>
            ))}
          </div>

          {/* Right Panel */}
          <div className="review-action-panel">
            {/* Current Clause Text */}
            <div className="risk-detail">
              <div className="decision-label">Clause Text</div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.7 }}>{selectedClause.text}</p>
            </div>

            {/* Risk Analysis */}
            {selectedClause.flagged && (
              <div className="risk-detail">
                <div className="risk-score-ring">
                  <div className={`score-circle ${selectedClause.risk}`}>
                    {selectedClause.risk === "high" ? "87" : "54"}
                  </div>
                  <div>
                    <div style={{ fontWeight: 700 }}>Risk Score</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Agent #6 — GPT-4o + CRISPE</div>
                  </div>
                </div>
                <div className="decision-label">AI Findings</div>
                <div className="risk-findings">
                  {selectedClause.findings.map((f, i) => (
                    <div key={i} className="finding-item">
                      <span className="finding-icon">⚠</span>
                      <span>{f}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Rewrite Suggestions */}
            {rewrites.length > 0 && (
              <div className="risk-detail">
                <div className="decision-label">AI Rewrite Suggestions <span style={{ fontWeight: 400, textTransform: "none", fontSize: 11 }}>(Agent #8)</span></div>
                {rewrites.map((rw, i) => (
                  <div
                    key={i}
                    onClick={() => setSelectedRewrite(i)}
                    style={{
                      background: selectedRewrite === i ? "var(--accent-glow)" : "var(--bg-surface)",
                      border: `1px solid ${selectedRewrite === i ? "var(--border-accent)" : "var(--border)"}`,
                      borderRadius: "var(--radius-sm)",
                      padding: "10px 12px",
                      marginBottom: 8,
                      cursor: "pointer",
                      fontSize: 12.5,
                      color: "var(--text-secondary)",
                      lineHeight: 1.6,
                      transition: "all 0.15s",
                    }}
                  >
                    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)", marginBottom: 4 }}>OPTION {i + 1}</div>
                    {rw}
                  </div>
                ))}
              </div>
            )}

            {/* Decision Panel */}
            <div className="decision-panel">
              <div className="decision-label">Your Decision</div>
              <div className="decision-buttons">
                <button
                  className={`btn w-full ${decision === "approved" ? "btn-success" : "btn-ghost"}`}
                  onClick={() => setDecision("approved")}
                >✓ Approve — Send to Reporting</button>
                <button
                  className={`btn w-full ${decision === "rejected" ? "btn-danger" : "btn-ghost"}`}
                  onClick={() => setDecision("rejected")}
                >✕ Reject — Block Contract</button>
                <button
                  className={`btn w-full ${decision === "edited" ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setDecision("edited")}
                >✎ Approve with Rewrite</button>
              </div>
              <textarea
                className="note-input"
                placeholder="Add notes for the audit log (optional)…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
