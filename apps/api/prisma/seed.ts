/**
 * Local dev seed — creates the Organization + User referenced by the
 * LEXGUARD_DEV_BYPASS_AUTH request context (apps/api/src/middleware/auth.ts),
 * so contract uploads/analysis can be exercised without a real JWT issuer.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEV_ORG_ID = "00000000-0000-0000-0000-000000000001";
const DEV_USER_ID = "00000000-0000-0000-0000-000000000002";

async function main() {
  await prisma.organization.upsert({
    where: { id: DEV_ORG_ID },
    update: {},
    create: {
      id: DEV_ORG_ID,
      name: "LexGuard Dev Org",
      email: "dev-org@lexguard.local",
      consentTimestamp: new Date(),
    },
  });

  await prisma.user.upsert({
    where: { id: DEV_USER_ID },
    update: {},
    create: {
      id: DEV_USER_ID,
      orgId: DEV_ORG_ID,
      email: "dev@lexguard.local",
      displayName: "Local Dev User",
      roles: ["ADMIN", "GENERAL_COUNSEL", "COMPLIANCE_OFFICER"],
    },
  });

  console.log(`Seeded dev organization (${DEV_ORG_ID}) and user (${DEV_USER_ID}).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
