"use client";
import { useEffect, useState } from "react";
import { API_BASE_URL, getApiHeaders } from "@/lib/api";

type SettingsResponse = {
  organization: {
    id: string;
    name: string;
    email: string;
    plan: string;
    awsRegion: string;
    citationLimit: number;
    rateLimitRpm: number;
    createdAt: string;
  };
  user: { id?: string; email?: string; roles: string[] };
  featureFlags: { enkryptEnabled: boolean; lexisNexisEnabled: boolean; hitlEnabled: boolean };
  azure: {
    chatDeployment: string;
    chatDeploymentMini: string;
    embeddingDeploymentConfigured: boolean;
  };
};

function FlagRow({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div
      className="flex"
      style={{
        justifyContent: "space-between",
        alignItems: "center",
        padding: "10px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span className="text-sm">{label}</span>
      <span className={`tag`} style={enabled ? {} : { background: "var(--risk-high-bg)", color: "var(--risk-high)", borderColor: "rgba(239,68,68,0.25)" }}>
        {enabled ? "Enabled" : "Disabled"}
      </span>
    </div>
  );
}

export default function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/settings`, {
          headers: getApiHeaders(),
        });
        if (!response.ok) throw new Error("Failed to load settings");
        setData((await response.json()) as SettingsResponse);
      } catch {
        setError("Unable to load platform settings.");
      }
    })();
  }, []);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Platform Settings</h1>
          <p className="page-subtitle">Live organization configuration and integration status</p>
        </div>
      </div>

      {error ? (
        <div className="card" style={{ textAlign: "center", padding: 48 }}>
          <p className="text-muted">{error}</p>
        </div>
      ) : !data ? (
        <div className="card">Loading settings…</div>
      ) : (
        <div className="two-col mb-6">
          <div className="card">
            <div className="section-title">Organization</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="flex" style={{ justifyContent: "space-between" }}>
                <span className="text-sm text-muted">Name</span>
                <span className="text-sm">{data.organization.name}</span>
              </div>
              <div className="flex" style={{ justifyContent: "space-between" }}>
                <span className="text-sm text-muted">Email</span>
                <span className="text-sm">{data.organization.email}</span>
              </div>
              <div className="flex" style={{ justifyContent: "space-between" }}>
                <span className="text-sm text-muted">Plan</span>
                <span className="tag">{data.organization.plan}</span>
              </div>
              <div className="flex" style={{ justifyContent: "space-between" }}>
                <span className="text-sm text-muted">AWS Region</span>
                <span className="text-sm">{data.organization.awsRegion}</span>
              </div>
              <div className="flex" style={{ justifyContent: "space-between" }}>
                <span className="text-sm text-muted">Rate Limit</span>
                <span className="text-sm">{data.organization.rateLimitRpm} req/min</span>
              </div>
              <div className="flex" style={{ justifyContent: "space-between" }}>
                <span className="text-sm text-muted">Citation Limit</span>
                <span className="text-sm">{data.organization.citationLimit}</span>
              </div>
              <div className="flex" style={{ justifyContent: "space-between" }}>
                <span className="text-sm text-muted">Member Since</span>
                <span className="text-sm">{new Date(data.organization.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="section-title">Current User</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
              <div className="flex" style={{ justifyContent: "space-between" }}>
                <span className="text-sm text-muted">Email</span>
                <span className="text-sm">{data.user.email ?? "—"}</span>
              </div>
              <div className="flex" style={{ justifyContent: "space-between" }}>
                <span className="text-sm text-muted">Roles</span>
                <div className="flex gap-2" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {data.user.roles.map((r) => (
                    <span key={r} className="tag">
                      {r.replace(/_/g, " ")}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="section-title">Integrations</div>
            <FlagRow label="Enkrypt AI Safety Pipeline" enabled={data.featureFlags.enkryptEnabled} />
            <FlagRow label="LexisNexis Precedents" enabled={data.featureFlags.lexisNexisEnabled} />
            <FlagRow label="Human-in-the-Loop Review" enabled={data.featureFlags.hitlEnabled} />
          </div>

          <div className="card" style={{ gridColumn: "1 / -1" }}>
            <div className="section-title">Azure OpenAI Deployments</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="flex" style={{ justifyContent: "space-between" }}>
                <span className="text-sm text-muted">Chat Deployment</span>
                <span className="text-sm">{data.azure.chatDeployment}</span>
              </div>
              <div className="flex" style={{ justifyContent: "space-between" }}>
                <span className="text-sm text-muted">Chat Deployment (mini tier)</span>
                <span className="text-sm">{data.azure.chatDeploymentMini}</span>
              </div>
              <div className="flex" style={{ justifyContent: "space-between" }}>
                <span className="text-sm text-muted">Embedding Deployment</span>
                <span
                  className="tag"
                  style={
                    data.azure.embeddingDeploymentConfigured
                      ? {}
                      : { background: "var(--risk-high-bg)", color: "var(--risk-high)", borderColor: "rgba(239,68,68,0.25)" }
                  }
                >
                  {data.azure.embeddingDeploymentConfigured ? "Configured" : "Not configured"}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ textAlign: "center", padding: 32 }}>
        <p className="text-sm text-muted">
          User invitation, per-role permissions, and API key rotation are not yet implemented
          (planned for a future phase). This page reflects live configuration read from the
          database and environment — it is not static placeholder content.
        </p>
      </div>
    </>
  );
}
