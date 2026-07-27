// ─────────────────────────────────────────────────────────────────────────────
// Learning persistence. Recomputes a firm's learning profile from its OWN
// review history (all recommendation versions, including superseded ones —
// that history IS the signal) and stores it on FirmLearningProfile so plan
// generation and the review UI can read it cheaply. Firm-scoped by
// construction; recomputation is deterministic and idempotent.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";
import { buildLearningProfile, type LearningItemInput, type LearningProfile } from "./learning";

/** Recompute and persist the firm's learning profile. Best-effort callers
 *  (review routes) catch; the script surfaces errors. */
export async function refreshFirmLearning(firmId: string): Promise<LearningProfile> {
  const items = await prisma.futureCareItem.findMany({
    where: { case: { firmId } },
    select: {
      lineageId: true,
      version: true,
      service: true,
      category: true,
      frequencyPerYear: true,
      durationYears: true,
      isLifetime: true,
      physicianStatus: true,
      physicianNote: true,
      supersededAt: true,
      probability: true,
      caseId: true,
    },
  });
  // Probability class of each lineage's current version, for calibration.
  const probabilityByLineage = new Map<string, string>();
  for (const it of items) if (!it.supersededAt) probabilityByLineage.set(it.lineageId, it.probability);

  const profile = buildLearningProfile(items as unknown as LearningItemInput[], probabilityByLineage);
  const casesIncluded = new Set(items.map((i) => i.caseId)).size;
  await prisma.firmLearningProfile.upsert({
    where: { firmId },
    create: { firmId, payload: profile as never, lineagesIncluded: profile.lineagesIncluded, casesIncluded },
    update: { payload: profile as never, lineagesIncluded: profile.lineagesIncluded, casesIncluded },
  });
  return profile;
}

/** The stored profile, or null when the firm has no review history yet. */
export async function firmLearningProfile(firmId: string): Promise<LearningProfile | null> {
  const row = await prisma.firmLearningProfile.findUnique({ where: { firmId } });
  return row ? (row.payload as unknown as LearningProfile) : null;
}
