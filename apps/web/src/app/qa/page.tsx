"use client";
import { useState, useRef, useEffect } from "react";

const CONTRACTS = [
  { id: "c-001", name: "Acme Corp — SaaS Subscription Agreement v3.pdf" },
  { id: "c-002", name: "TechFlow — NDA Mutual Confidentiality 2026.pdf" },
  { id: "c-003", name: "GlobalEdge — Master Service Agreement Q3.pdf" },
];

type Message = { role: "user" | "ai"; text: string; citations?: string[] };

const MOCK_RESPONSES: Record<string, { text: string; citations: string[] }> = {
  default: {
    text: "Based on my analysis of the contract, the liability limitation clause (Section 12.3) is the highest risk item. The vendor has capped their maximum exposure to $500 and included a broad consequential damages waiver with no carve-outs for gross negligence. This is materially unfavourable to your company.",
    citations: ["Section 12.3 — Limitation of Liability", "Section 12.4 — Consequential Damages Waiver"],
  },
  liability: {
    text: "The liability cap is set at the lower of $500 or fees paid in the prior 3 months. Market standard for SaaS contracts of this size is typically 12 months' fees. I recommend negotiating this to a minimum of $50,000 or 12 months' subscription fees, whichever is greater.",
    citations: ["Section 12.3", "Benchmark: legal_templates collection (87th percentile unfavourable)"],
  },
  termination: {
    text: "The termination clause (Section 15) allows the vendor to terminate with 90 days notice for any reason while requiring you to pay outstanding fees. The auto-renewal notice period of 90 days is significantly above market standard of 30 days. I recommend reducing this to 30 days and adding a price cap on renewals.",
    citations: ["Section 15.1 — Termination for Convenience", "Section 15.4 — Auto-Renewal"],
  },
  gdpr: {
    text: "The data processing provisions lack a compliant Article 28 Data Processing Agreement. The current language in Section 8.2 gives the vendor an irrevocable licence to Customer Data for 'service improvement' purposes, which is not permissible under GDPR for Controller-Processor relationships. A DPA must be executed before data transfer.",
    citations: ["Section 8.2 — Data Usage", "GDPR Article 28 — Processor Obligations", "Jurisdiction Rule: EU-GDPR"],
  },
};

function getMockResponse(query: string) {
  const lower = query.toLowerCase();
  if (lower.includes("liability") || lower.includes("cap")) return MOCK_RESPONSES.liability;
  if (lower.includes("terminat") || lower.includes("renewal")) return MOCK_RESPONSES.termination;
  if (lower.includes("gdpr") || lower.includes("data") || lower.includes("privacy")) return MOCK_RESPONSES.gdpr;
  return MOCK_RESPONSES.default;
}

export default function QAPage() {
  const [selectedContract, setSelectedContract] = useState(CONTRACTS[0].id);
  const [messages, setMessages] = useState<Message[]>([
    { role: "ai", text: "Hello! I have analysed the selected contract. Ask me anything about its clauses, risks, compliance issues, or negotiation strategies.", citations: [] },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", text: userMsg }]);
    setLoading(true);

    await new Promise(r => setTimeout(r, 1200));
    const resp = getMockResponse(userMsg);
    setMessages(prev => [...prev, { role: "ai", text: resp.text, citations: resp.citations }]);
    setLoading(false);
  };

  const suggestions = ["What are the top 3 risks?", "Explain the liability cap", "Is this GDPR compliant?", "What's the termination notice period?", "Summarise the IP ownership clause"];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Legal Q&A</h1>
          <p className="page-subtitle">Multi-turn AI conversation powered by Agent #12 + conversation memory</p>
        </div>
      </div>

      <div className="qa-container">
        {/* Left Panel */}
        <div className="qa-sidebar">
          <div className="decision-label">Select Contract</div>
          {CONTRACTS.map(c => (
            <div
              key={c.id}
              onClick={() => setSelectedContract(c.id)}
              style={{
                padding: "10px 12px",
                borderRadius: "var(--radius-sm)",
                marginBottom: 6,
                cursor: "pointer",
                background: selectedContract === c.id ? "var(--accent-glow)" : "transparent",
                border: `1px solid ${selectedContract === c.id ? "var(--border-accent)" : "transparent"}`,
                color: selectedContract === c.id ? "var(--accent)" : "var(--text-secondary)",
                fontSize: 12.5,
                transition: "all 0.15s",
              }}
            >
              📄 {c.name.slice(0, 40)}…
            </div>
          ))}

          <div className="decision-label" style={{ marginTop: 20 }}>Suggested Questions</div>
          {suggestions.map(s => (
            <div
              key={s}
              onClick={() => setInput(s)}
              style={{
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                marginBottom: 5,
                cursor: "pointer",
                background: "var(--bg-surface)",
                border: "1px solid var(--border)",
                fontSize: 12,
                color: "var(--text-secondary)",
                transition: "all 0.12s",
              }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = "var(--border-accent)")}
              onMouseLeave={e => (e.currentTarget.style.borderColor = "var(--border)")}
            >
              {s}
            </div>
          ))}

          <div className="decision-label" style={{ marginTop: 20 }}>Session Info</div>
          <div style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.8 }}>
            <div>🧠 Memory: 30-day TTL</div>
            <div>📚 Qdrant: conversation_memory</div>
            <div>🛡 Enkrypt: enabled</div>
            <div>💬 Messages: {messages.length}</div>
          </div>
        </div>

        {/* Chat */}
        <div className="qa-chat">
          <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border)", fontSize: 12, color: "var(--text-muted)", display: "flex", gap: 8, alignItems: "center" }}>
            <span className="status-chip complete">Agent #12 Active</span>
            <span>·</span>
            <span>{CONTRACTS.find(c => c.id === selectedContract)?.name.slice(0, 50)}…</span>
          </div>

          <div className="chat-messages">
            {messages.map((msg, i) => (
              <div key={i} className={`chat-message ${msg.role}`}>
                <div className={`message-avatar ${msg.role}`}>{msg.role === "ai" ? "⚖" : "AR"}</div>
                <div>
                  <div className="message-bubble">{msg.text}</div>
                  {msg.citations && msg.citations.length > 0 && (
                    <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {msg.citations.map((c, j) => (
                        <span key={j} style={{ fontSize: 10, padding: "2px 7px", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--accent)" }}>
                          📎 {c}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div className="chat-message ai">
                <div className="message-avatar ai">⚖</div>
                <div className="message-bubble" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <div className="spinner" />
                  <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>Analysing contract…</span>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="chat-input-area">
            <textarea
              className="chat-input"
              rows={2}
              placeholder="Ask about clauses, risks, compliance, negotiation…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
            <button className="btn btn-primary" onClick={send} disabled={loading || !input.trim()}>
              {loading ? <div className="spinner" style={{ width: 16, height: 16 }} /> : "Send"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
