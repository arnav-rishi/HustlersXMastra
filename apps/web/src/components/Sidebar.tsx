"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { API_BASE_URL, getApiHeaders } from "@/lib/api";

const navItems = [
  { href: "/",          icon: "⬡", label: "Dashboard"   },
  { href: "/review",    icon: "⚑", label: "Review Queue" },
  { href: "/contracts", icon: "📄", label: "Contracts"   },
  { href: "/qa",        icon: "💬", label: "Legal Q&A"   },
  { href: "/analytics", icon: "📊", label: "Analytics"   },
  { href: "/settings",  icon: "⚙", label: "Settings"    },
];

export default function Sidebar() {
  const pathname = usePathname();
  const qdrantDashboardUrl =
    process.env.NEXT_PUBLIC_QDRANT_DASHBOARD_URL ??
    "http://localhost:6333/dashboard";
  const grafanaUrl =
    process.env.NEXT_PUBLIC_GRAFANA_URL ?? "http://localhost:3001";
  const jaegerUrl =
    process.env.NEXT_PUBLIC_JAEGER_URL ?? "http://localhost:16686";

  // Real pending-HITL count for the Review Queue badge — was hardcoded to 7
  // regardless of actual queue state. null = not loaded yet / request failed,
  // renders no badge rather than a stale number.
  const [pendingReviewCount, setPendingReviewCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/analytics/summary`, {
          headers: getApiHeaders(),
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { hitl?: { pending?: number } };
        if (!cancelled) setPendingReviewCount(payload.hitl?.pending ?? 0);
      } catch {
        if (!cancelled) setPendingReviewCount(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon">⚖</div>
        <div>
          <div className="sidebar-logo-text">LexGuard AI</div>
          <div className="sidebar-logo-sub">LEGAL INTELLIGENCE</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        <div className="nav-section-label">Navigation</div>
        {navItems.map(({ href, icon, label }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          const badge = href === "/review" ? pendingReviewCount : null;
          return (
            <Link key={href} href={href} className={`nav-item ${active ? "active" : ""}`}>
              <span className="nav-icon">{icon}</span>
              {label}
              {!!badge && <span className="nav-badge">{badge}</span>}
            </Link>
          );
        })}

        <div className="nav-section-label" style={{ marginTop: 24 }}>Infrastructure</div>
        <a href={qdrantDashboardUrl} target="_blank" className="nav-item">
          <span className="nav-icon">🗄</span> Qdrant
        </a>
        <a href={grafanaUrl} target="_blank" className="nav-item">
          <span className="nav-icon">📈</span> Grafana
        </a>
        <a href={jaegerUrl} target="_blank" className="nav-item">
          <span className="nav-icon">🔍</span> Jaeger
        </a>
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-user">
          <div className="sidebar-avatar">AR</div>
          <div className="sidebar-user-info">
            <div className="sidebar-user-name">Arnav R.</div>
            <div className="sidebar-user-role">Admin · Legal Ops</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
