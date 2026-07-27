// Recompute every firm's cross-case learning profile from its review history.
//
// Profiles refresh automatically after each physician review action; this
// script backfills firms with pre-existing history (or rebuilds after a
// learning-engine change). Deterministic and idempotent.
//
//   npm run learning:refresh

import { prisma } from "../src/lib/db";
import { refreshFirmLearning } from "../src/lib/engine/learningService";

async function main() {
  const firms = await prisma.firm.findMany({ select: { id: true, name: true } });
  for (const firm of firms) {
    const profile = await refreshFirmLearning(firm.id);
    const withHistory = profile.services.filter((s) => s.samples > 0).length;
    console.log(
      `${firm.name}: ${profile.lineagesIncluded} reviewed lineage(s) across ${withHistory} service(s)` +
        (profile.calibration.length
          ? ` — calibration: ${profile.calibration.map((c) => `${c.probability} ${c.approvedOrModified}/${c.samples}`).join(", ")}`
          : ""),
    );
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
