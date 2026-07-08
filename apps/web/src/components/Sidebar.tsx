"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/",          icon: "⬡", label: "Dashboard"   },
  { href: "/review",    icon: "⚑", label: "Review Queue", badge: 7 },
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
        {navItems.map(({ href, icon, label, badge }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link key={href} href={href} className={`nav-item ${active ? "active" : ""}`}>
              <span className="nav-icon">{icon}</span>
              {label}
              {badge && <span className="nav-badge">{badge}</span>}
            </Link>
          );
        })}

        <div className="nav-section-label" style={{ marginTop: 24 }}>Infrastructure</div>
        <a href={qdrantDashboardUrl} target="_blank" className="nav-item">
          <span className="nav-icon">🗄</span> Qdrant
        </a>
        <a href="http://localhost:3001" target="_blank" className="nav-item">
          <span className="nav-icon">📈</span> Grafana
        </a>
        <a href="http://localhost:16686" target="_blank" className="nav-item">
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
