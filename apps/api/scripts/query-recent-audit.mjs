// One-off dev helper: lists the most recent audit_log rows so we can grab a
// real traceId to test GET /api/v1/audit/trace/:traceId against.
// Run from repo root: pnpm --filter @lexguard/api exec dotenv -e ../../.env.local -- node scripts/query-recent-audit.mjs
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const rows = await prisma.auditLog.findMany({
  orderBy: { timestamp: "desc" },
  take: 5,
});
console.log(JSON.stringify(rows.map(r => ({ traceId: r.traceId, eventType: r.eventType, contractId: r.contractId })), null, 2));
await prisma.$disconnect();
