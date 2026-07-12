// In production this should be set to "" (empty string) so fetch() calls stay
// relative (e.g. "/api/v1/contracts") and resolve against the page's own
// origin. next.config.mjs then proxies them server-side to API_INTERNAL_URL,
// so the browser only ever talks to one origin — no CORS involved.
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

export const DEV_TENANT_ID =
  process.env.NEXT_PUBLIC_DEV_TENANT_ID ?? "00000000-0000-0000-0000-000000000001";

export function getApiHeaders(contentType = false): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${process.env.NEXT_PUBLIC_DEV_AUTH_TOKEN ?? "test"}`,
    "X-Tenant-ID": DEV_TENANT_ID,
  };
  if (contentType) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}
