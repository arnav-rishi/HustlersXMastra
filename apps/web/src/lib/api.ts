export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export function getApiHeaders(contentType = false): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${process.env.NEXT_PUBLIC_DEV_AUTH_TOKEN ?? "test"}`,
    "X-Tenant-ID":
      process.env.NEXT_PUBLIC_DEV_TENANT_ID ??
      "00000000-0000-0000-0000-000000000001",
  };
  if (contentType) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}
