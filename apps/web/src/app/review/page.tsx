"use client";
import Link from "next/link";

const QUEUE = [
  { id: "h-001", contract: "Acme Corp — SaaS Subscription Agreement v3.pdf", type: "SaaS",    risk: "high",   confidence: 0.61, clauses: 4,  lawyer: "Sarah Mitchell", due: "2h",  jurisdiction: "US-CA" },
  { id: "h-002", contract: "Nexus Labs — IP Assignment & License Grant.pdf",  type: "IP",     risk: "high",   confidence: 0.58, clauses: 6,  lawyer: "James Okafor",   due: "4h",  jurisdiction: "US-NY" },
  { id: "h-003", contract: "Titan Corp — Data Processing Agreement (DPA).pdf",type: "DPA",    risk: "medium", confidence: 0.68, clauses: 2,  lawyer: "Sarah Mitchell", due: "6h",  jurisdiction: "EU-GDPR" },
  { id: "h-004", contract: "Vertex AI — Cloud Services Frame Agreement.pdf",  type: "CSA",    risk: "medium", confidence: 0.65, clauses: 3,  lawyer: "Unassigned",      due: "12h", jurisdiction: "US-DE" },
  { id: "h-005", contract: "BlueWave — Strategic Partnership MOU 2026.pdf",   type: "MOU",    risk: "medium", confidence: 0.66, clauses: 1,  lawyer: "James Okafor",   due: "1d",  jurisdiction: "UK-ENG" },
  { id: "h-006", contract: "DeltaTech — Software License Perpetual.pdf",      type: "LIC",    risk: "high",   confidence: 0.55, clauses: 5,  lawyer: "Unassigned",      due: "2d",  jurisdiction: "US-TX" },
  { id: "h-007", contract: "Solaris Corp — Vendor Services Agreement Q3.pdf", type: "VSA",    risk: "medium", confidence: 0.64, clauses: 2,  lawyer: "Unassigned",      due: "2d",  jurisdiction: "AU" },
];

export default function ReviewQueuePage() {
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">HITL Review Queue</h1>
          <p className="page-subtitle">Contracts flagged for human review · Enkrypt confidence &lt; 0.70</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-ghost btn-sm">⬇ Export Queue</button>
          <div className="tag">7 PENDING</div>
        </div>
      </div>

      {/* Summary Metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
        <div className="card card-sm" style={{ borderLeft: "3px solid var(--risk-high)" }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>HIGH RISK</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--risk-high)" }}>3</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Confidence &lt; 0.60 · Immediate action</div>
        </div>
        <div className="card card-sm" style={{ borderLeft: "3px solid var(--risk-med)" }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>MEDIUM RISK</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--risk-med)" }}>4</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Confidence 0.60–0.70 · Review today</div>
        </div>
        <div className="card card-sm" style={{ borderLeft: "3px solid var(--accent)" }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>AVG CONFIDENCE</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--accent)" }}>0.62</div>
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
            {QUEUE.map((item) => (
              <tr key={item.id}>
                <td>
                  <div style={{ maxWidth: 280 }} className="truncate">{item.contract}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{item.type}</div>
                </td>
                <td><span className={`risk-badge ${item.risk}`}>{item.risk.toUpperCase()}</span></td>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 700, color: item.confidence < 0.60 ? "var(--risk-high)" : "var(--risk-med)" }}>
                      {(item.confidence * 100).toFixed(0)}%
                    </span>
                    <div className="progress-bar" style={{ width: 60 }}>
                      <div className="progress-fill" style={{ width: `${item.confidence * 100}%`, background: item.confidence < 0.60 ? "var(--risk-high)" : "var(--risk-med)" }} />
                    </div>
                  </div>
                </td>
                <td style={{ fontWeight: 700 }}>{item.clauses}</td>
                <td><span className="tag" style={{ fontSize: 9 }}>{item.jurisdiction}</span></td>
                <td style={{ color: item.lawyer === "Unassigned" ? "var(--text-muted)" : "var(--text-secondary)" }}>{item.lawyer}</td>
                <td style={{ color: item.due.includes("h") ? "var(--risk-high)" : "var(--text-secondary)", fontWeight: 600 }}>{item.due}</td>
                <td>
                  <Link href={`/review/${item.id}`} className="btn btn-primary btn-sm">Review →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
