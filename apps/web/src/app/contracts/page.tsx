"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { API_BASE_URL, getApiHeaders } from "@/lib/api";
import { downloadCsv } from "@/lib/export";

type ContractRow = {
  id: string;
  name: string;
  type: string;
  status: string;
  risk: string;
  jurisdiction: string;
  date: string;
};

const STATUS_FILTERS = ["all", "queued", "processing", "hitl_required", "completed", "failed"];

export default function ContractsPage() {
  const [items, setItems] = useState<ContractRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const pageSize = 15;

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (statusFilter !== "all") qs.set("status", statusFilter);
      if (search.trim()) qs.set("search", search.trim());

      const response = await fetch(`${API_BASE_URL}/api/v1/contracts?${qs.toString()}`, {
        headers: getApiHeaders(),
      });
      if (!response.ok) throw new Error("Failed to load contracts");
      const payload = (await response.json()) as { items: ContractRow[]; total: number };
      setItems(payload.items);
      setTotal(payload.total);
      setError(null);
    } catch {
      setError("Unable to load the contract repository.");
    }
  }, [page, statusFilter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map((c) => c.id))));
  }, [items]);

  const deleteOne = useCallback(async (id: string, name: string) => {
    if (!window.confirm(`Permanently delete "${name}"? This removes the contract, its clauses, embeddings, and HITL history. This cannot be undone.`)) {
      return;
    }
    setDeleting(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/contracts/${id}`, {
        method: "DELETE",
        headers: getApiHeaders(),
      });
      if (!response.ok) throw new Error("Delete failed");
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await load();
    } catch {
      setError("Failed to delete contract. Check API and retry.");
    } finally {
      setDeleting(false);
    }
  }, [load]);

  const deleteSelected = useCallback(async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`Permanently delete ${selected.size} selected contract(s)? This removes all clauses, embeddings, and HITL history. This cannot be undone.`)) {
      return;
    }
    setDeleting(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/contracts`, {
        method: "DELETE",
        headers: getApiHeaders(true),
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (!response.ok) throw new Error("Bulk delete failed");
      setSelected(new Set());
      await load();
    } catch {
      setError("Failed to delete selected contracts. Check API and retry.");
    } finally {
      setDeleting(false);
    }
  }, [selected, load]);

  const deleteAll = useCallback(async () => {
    if (total === 0) return;
    if (!window.confirm(`Permanently delete ALL ${total} contract(s) in the repository? This removes every clause, embedding, and HITL record. This cannot be undone.`)) {
      return;
    }
    setDeleting(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/contracts`, {
        method: "DELETE",
        headers: getApiHeaders(true),
        body: JSON.stringify({ all: true }),
      });
      if (!response.ok) throw new Error("Delete all failed");
      setSelected(new Set());
      setPage(1);
      await load();
    } catch {
      setError("Failed to delete all contracts. Check API and retry.");
    } finally {
      setDeleting(false);
    }
  }, [total, load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Contract Repository</h1>
          <p className="page-subtitle">View and search all processed legal documents</p>
        </div>
        <div className="flex gap-2">
          {selected.size > 0 ? (
            <button
              className="btn btn-ghost btn-sm"
              style={{ color: "var(--risk-high)" }}
              onClick={deleteSelected}
              disabled={deleting}
            >
              🗑 Delete Selected ({selected.size})
            </button>
          ) : null}
          <button
            className="btn btn-ghost btn-sm"
            style={{ color: "var(--risk-high)" }}
            onClick={deleteAll}
            disabled={deleting || total === 0}
          >
            🗑 Delete All
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              downloadCsv(
                `lexguard-contracts-${new Date().toISOString().slice(0, 10)}.csv`,
                items
              )
            }
            disabled={items.length === 0}
          >
            ⬇ Export
          </button>
          <Link href="/" className="btn btn-primary btn-sm">
            + Upload Contract
          </Link>
        </div>
      </div>

      <div className="card card-sm mb-6" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          placeholder="Search by file name…"
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch((e.target as HTMLInputElement).value);
          }}
          style={{
            flex: 1,
            minWidth: 200,
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-primary)",
            fontSize: 13,
            padding: "8px 12px",
            outline: "none",
          }}
        />
        <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              className={`btn btn-sm ${statusFilter === s ? "btn-primary" : "btn-ghost"}`}
              onClick={() => {
                setPage(1);
                setStatusFilter(s);
              }}
            >
              {s.replace(/_/g, " ")}
            </button>
          ))}
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  checked={items.length > 0 && selected.size === items.length}
                  onChange={toggleSelectAll}
                />
              </th>
              <th>Contract</th>
              <th>Type</th>
              <th>Jurisdiction</th>
              <th>Risk</th>
              <th>Status</th>
              <th>Date</th>
              <th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td>
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelected(c.id)} />
                </td>
                <td>
                  <Link href={`/contracts/${c.id}`} style={{ color: "var(--text-primary)" }}>
                    <div style={{ maxWidth: 280 }} className="truncate">
                      {c.name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                      {c.id.slice(0, 8)}
                    </div>
                  </Link>
                </td>
                <td>{c.type}</td>
                <td>{c.jurisdiction}</td>
                <td>
                  <span className={`risk-badge ${c.risk === "critical" ? "high" : c.risk === "moderate" ? "medium" : c.risk === "low" ? "low" : ""}`}>
                    {c.risk.toUpperCase()}
                  </span>
                </td>
                <td>
                  <span className={`status-chip ${c.status === "completed" ? "complete" : c.status === "failed" ? "" : "pending"}`}>
                    {c.status}
                  </span>
                </td>
                <td style={{ color: "var(--text-secondary)" }}>{c.date}</td>
                <td>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ color: "var(--risk-high)", padding: "2px 8px" }}
                    onClick={() => deleteOne(c.id, c.name)}
                    disabled={deleting}
                    title="Delete permanently"
                  >
                    🗑
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ color: "var(--text-muted)" }}>
                  {error ?? "No contracts found. Upload one from the Dashboard to get started."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {total > pageSize ? (
        <div className="flex gap-2 mt-4" style={{ justifyContent: "flex-end", alignItems: "center" }}>
          <span className="text-sm text-muted">
            Page {page} of {totalPages} · {total} total
          </span>
          <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ← Prev
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      ) : null}
    </>
  );
}
