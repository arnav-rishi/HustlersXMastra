// Server-side proxy target for the API. Next.js's rewrite runs on the server
// (not in the browser), so the frontend and API can be deployed on entirely
// separate hosts/networks while the browser only ever talks to one origin —
// this is what makes NEXT_PUBLIC_API_BASE_URL="" (relative fetches) work in
// production without CORS. Defaults to the local dev API for `pnpm dev:web`.
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${API_INTERNAL_URL}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
