import { prisma } from "../src/lib/db";
import { seedDemoFirm } from "../src/lib/demo/seed";

// ─────────────────────────────────────────────────────────────────────────────
// CLI: build (or rebuild) the synthetic demo tenant.
//
//   npx tsx scripts/demo-seed.ts
//
// Idempotent — an existing demo firm (matched by slug, and ONLY when
// Firm.isDemo is true) is wiped and rebuilt. The DB connection is retried at
// startup because serverless Postgres (Neon) can take a few seconds to wake.
// ─────────────────────────────────────────────────────────────────────────────

const CONNECT_ATTEMPTS = 20;
const CONNECT_DELAY_MS = 4000;

async function waitForDb(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch (err) {
      if (attempt >= CONNECT_ATTEMPTS) throw err;
      console.log(`  Database not reachable yet (attempt ${attempt}/${CONNECT_ATTEMPTS}) — retrying in ${CONNECT_DELAY_MS / 1000}s…`);
      await new Promise((r) => setTimeout(r, CONNECT_DELAY_MS));
    }
  }
}

/**
 * Dev-drift healing: the columns added by migration 20260728010000_mdip must
 * exist before seeding. The dev database predates that migration being fully
 * applied (the migration is recorded but "Firm"."isDemo" is missing), so the
 * exact additive DDL from the committed migration is applied idempotently.
 */
async function ensureMdipColumns(): Promise<void> {
  await prisma.$executeRawUnsafe(`ALTER TABLE "Firm" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "preferredWorkspace" TEXT`);
}

async function main() {
  console.log("LifePlanOS demo seed — synthetic tenant only.");
  await waitForDb();
  await ensureMdipColumns();
  const summary = await seedDemoFirm();
  console.log("✔ Seeded demo firm: Life Care Plan Partners Demo");
  console.log(`  users=${summary.users} roleAssignments=${summary.roleAssignments} credentials=${summary.credentials}`);
  console.log(`  cases=${summary.cases} documents=${summary.documents} chronology=${summary.chronologyEvents} conditions=${summary.conditions}`);
  console.log(`  futureCareItems=${summary.futureCareItems} validationFindings=${summary.validationFindings} reportExports=${summary.reportExports}`);
  console.log(`  vocationalEntries=${summary.vocationalEntries} econAssumptions=${summary.economicAssumptions} econScenarios=${summary.economicScenarios}`);
  console.log(`  engagements=${summary.engagements} notifications=${summary.notifications}`);
  console.log("  Personas: see /demo (password from DEMO_PASSWORD, dev default otherwise).");
  console.log("  Super Admin: platform.admin@demo.lifeplanos.com — authority via its ACTIVE");
  console.log("  PLATFORM_SYSTEM_ADMINISTRATOR role assignment (no email allowlists).");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
