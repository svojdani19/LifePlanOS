import { prisma } from "../src/lib/db";
import { resetDemoFirm } from "../src/lib/demo/seed";

// ─────────────────────────────────────────────────────────────────────────────
// CLI: reset the demo environment — delete the demo firm's data and reseed.
//
//   npx tsx scripts/demo-reset.ts --confirm
//
// Guardrails: refuses without --confirm; the deletion path finds the firm by
// the demo slug and refuses unless Firm.isDemo is true, so no other tenant can
// ever be affected. The reset is audited ("demo.reset") under the recreated
// firm.
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

async function main() {
  if (!process.argv.includes("--confirm")) {
    console.error("Refusing to reset: this deletes and rebuilds the ENTIRE demo firm.");
    console.error("Re-run with:  npx tsx scripts/demo-reset.ts --confirm");
    process.exit(1);
  }
  console.log("LifePlanOS demo reset — deleting and reseeding the demo tenant…");
  await waitForDb();
  const summary = await resetDemoFirm({ email: "firm.admin@demo.lifeplanos.com" });
  console.log("✔ Demo environment reset.");
  console.log(`  users=${summary.users} cases=${summary.cases} documents=${summary.documents} items=${summary.futureCareItems}`);
  console.log(`  engagements=${summary.engagements} notifications=${summary.notifications} reportExports=${summary.reportExports}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
