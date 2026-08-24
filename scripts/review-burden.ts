// PHI-free review-burden metrics at correct grain.
//
//   npm run records:burden -- <caseId|caseNumber>
//
// Counts distinct findings by identity, canonical notes from persisted
// segments, and blockers once at their own scope. Prints aggregates only —
// never names, dates, summaries, excerpts or filenames.

import { PrismaClient } from "@/generated/prisma";
import { CURRENT_OUTPUT_WHERE } from "@/lib/records/encounterLifecycle";
import { measureReviewBurden, type BurdenFinding, type BurdenRow } from "@/lib/records/reviewBurden";

const db = new PrismaClient();

async function main() {
  const key = process.argv[2];
  if (!key) {
    console.error("usage: npm run records:burden -- <caseId|caseNumber>");
    process.exit(1);
  }
  const theCase = await db.case.findFirst({
    where: { OR: [{ id: key }, { caseNumber: key }] },
    select: { id: true, caseNumber: true, firmId: true },
  });
  if (!theCase) {
    console.error(`no case matches "${key}"`);
    process.exit(1);
  }

  const documents = await db.document.findMany({ where: { caseId: theCase.id }, select: { id: true, segments: true } });
  const rows = await db.extractedEncounter.findMany({
    where: { caseId: theCase.id, ...CURRENT_OUTPUT_WHERE },
    select: {
      id: true, sourceDocumentId: true, status: true, auditResult: true, dateStatus: true, analysisClass: true,
      auditVersion: true, corroboration: true,
      // The identity-bearing fields, so this report groups rows into
      // encounters exactly as the Records page does. Without them the two
      // would be counting different groupings of the same case and neither
      // could be checked against the other. Nothing below prints them.
      encounterDate: true, provider: true, facility: true, segmentKey: true, page: true, pageEnd: true,
      substanceClass: true, claims: true,
    },
  });
  const findings = await db.recordFinding
    .findMany({
      where: { caseId: theCase.id },
      select: { id: true, fingerprint: true, scope: true, type: true, status: true, blocking: true, sourceDocumentId: true, canonicalNoteId: true, encounterId: true },
    })
    .catch(() => []);
  const pages = await db.sourcePage.findMany({ where: { caseId: theCase.id }, select: { status: true } }).catch(() => []);

  const burden = measureReviewBurden({
    documents,
    rows: rows.map((r) => ({
      id: r.id,
      sourceDocumentId: r.sourceDocumentId,
      status: r.status,
      auditResult: r.auditResult,
      dateStatus: r.dateStatus,
      // The KIND, so a legitimately dateless fee schedule is not counted as a
      // clinical dating gap.
      analysisClass: r.analysisClass,
      auditVersion: r.auditVersion,
      corroborationResult: (r.corroboration as { result?: string } | null)?.result ?? null,
      encounterDate: r.encounterDate,
      provider: r.provider,
      facility: r.facility,
      segmentKey: r.segmentKey,
      page: r.page,
      pageEnd: r.pageEnd,
      substanceClass: r.substanceClass,
      claims: Array.isArray(r.claims) ? (r.claims as { field: string; value: string; excerpt?: string | null; page?: number | null }[]) : [],
    })) as BurdenRow[],
    findings: findings as BurdenFinding[],
    pages,
  });

  const stale = await db.extractedEncounter.count({ where: { caseId: theCase.id, status: "STALE" } });
  const genLoss = await db.extractedEncounter.count({ where: { caseId: theCase.id, status: "GENERATION_LOSS" } });

  console.log(`case ${theCase.caseNumber} — review burden (PHI-free)\n`);
  console.log(`  active extraction rows            ${burden.activeRows}`);
  console.log(`  canonical encounters              ${burden.canonicalNotes}`);
  console.log(`    of which multi-row              ${burden.multiRowNotes}`);
  console.log(`    grouped by compatibility path   ${burden.fallbackNotes}`);
  console.log(`    rows with no persisted segment  ${burden.rowsWithoutSegment}`);
  console.log(`  review units before consolidation ${burden.decisionsBeforeConsolidation}`);
  console.log(`  review units after consolidation  ${burden.decisionsAfterConsolidation}`);
  console.log(`\n  REQUIRED DECISIONS (exceptions)   ${burden.requiredDecisions}`);
  console.log(`    encounter exceptions            ${burden.requiredDecisionsByKind.encounterExceptions}`);
  console.log(`      of which ambiguous assignment ${burden.requiredDecisionsByKind.ambiguousAssignments}`);
  console.log(`    case / document / page blockers ${burden.requiredDecisionsByKind.caseBlockers} / ${burden.requiredDecisionsByKind.documentBlockers} / ${burden.requiredDecisionsByKind.pageBlockers}`);
  console.log(`\n  notes needing attention           ${burden.notesNeedingAttention}`);
  console.log(`  notes carrying a caution          ${burden.notesCarryingCaution}`);
  console.log(`  clean notes (case-level confirm)  ${burden.cleanNotesAwaitingAttestation}`);
  console.log(`\n  AI_DRAFT rows                     ${burden.aiDraft}`);
  console.log(`  AI_AUDIT_PASSED rows              ${burden.aiAuditPassed}`);
  console.log(`  machine-corroborated rows         ${burden.machineCorroborated}`);
  console.log(`  stale rows                        ${stale}`);
  console.log(`  generation-loss rows              ${genLoss}`);
  console.log(`  undated rows needing a date       ${burden.undatedClinical}`);
  console.log(`  undated rows dateless by design   ${burden.undatedDatelessByDesign}`);
  console.log(`  cross-document copies covered     ${burden.crossDocumentCopies}`);
  console.log(`\n  distinct findings by scope        ${JSON.stringify(burden.findingsByScope)}`);
  console.log(`  distinct findings by type         ${JSON.stringify(burden.findingsByType)}`);
  console.log(`  distinct entries with findings    ${burden.entriesWithFindings}`);
  console.log(`  distinct notes with findings      ${burden.notesWithFindings}`);
  console.log(`  case / document / page blockers   ${burden.caseBlockers} / ${burden.documentBlockers} / ${burden.pageBlockers}`);
  console.log(`\n  (counts are by identity, never by repeated finding text)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
