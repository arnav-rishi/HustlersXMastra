"use client";
import { useState, useRef, useEffect } from "react";
import { API_BASE_URL, getApiHeaders } from "@/lib/api";

const CONTRACTS = [
  { id: "00000000-0000-0000-0000-000000000101", name: "Acme Corp — SaaS Subscription Agreement v3.pdf" },
  { id: "00000000-0000-0000-0000-000000000102", name: "TechFlow — NDA Mutual Confidentiality 2026.pdf" },
  { id: "00000000-0000-0000-0000-000000000103", name: "GlobalEdge — Master Service Agreement Q3.pdf" },
];

type Message = { role: "user" | "ai"; text: string; citations?: string[] };

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

    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/contracts/qa`, {
        method: "POST",
        headers: getApiHeaders(true),
        body: JSON.stringify({
          contractId: selectedContract,
          orgId: "00000000-0000-0000-0000-000000000001",
          question: userMsg,
        }),
      });
      if (!response.ok) {
        throw new Error("QA request failed");
      }
      const payload = (await response.json()) as { answer?: string; citations?: string[] };
      setMessages(prev => [
        ...prev,
        {
          role: "ai",
          text: payload.answer ?? "No answer returned by the QA agent.",
          citations: Array.isArray(payload.citations) ? payload.citations : [],
        },
      ]);
    } catch {
      setMessages(prev => [
        ...prev,
        {
          role: "ai",
          text: "The QA service is unavailable right now. Please verify API and infra services.",
          citations: [],
        },
      ]);
    } finally {
      setLoading(false);
    }
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
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border-accent)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border)"; }}
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
              onChange={e => setInput((e.target as HTMLTextAreaElement).value)}
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
