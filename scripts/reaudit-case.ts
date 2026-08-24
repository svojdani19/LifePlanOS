// ─────────────────────────────────────────────────────────────────────────────
// Apply the CURRENT deterministic audit rules to a case, with no model calls.
//
//   npm run records:reaudit -- <caseId|caseNumber>
//   npm run records:reaudit -- <caseId|caseNumber> --dry-run
//
// Corrected deterministic rules should not require hours of re-extraction to
// take effect: everything the audit reads is already persisted. Extracted
// facts, human review states, verification hashes and history are untouched;
// only machine rows move between AI_DRAFT and AI_AUDIT_PASSED, and only where
// the current rules justify it.
//
// Prints aggregate, PHI-free counts only.
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@/generated/prisma";
import { CURRENT_OUTPUT_WHERE } from "@/lib/records/encounterLifecycle";
import { planReaudit, AUDIT_VERSION, type ReauditDocument, type ReauditRunState } from "@/lib/records/reaudit";
import { writeFindings } from "@/lib/records/recordFindings";

const db = new PrismaClient();

async function main() {
  const key = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!key) {
    console.error("usage: npm run records:reaudit -- <caseId|caseNumber> [--dry-run]");
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

  const built: ReauditDocument[] = [];
  for (const doc of documents) {
    const rows = await db.extractedEncounter.findMany({
      where: { caseId: theCase.id, sourceDocumentId: doc.id, ...CURRENT_OUTPUT_WHERE },
      select: {
        id: true, sourceDocumentId: true, status: true, auditResult: true, auditVersion: true, dateStatus: true,
        encounterDate: true, provider: true, encounterType: true, factualSummary: true, synthesis: true,
        claims: true, page: true, unresolvedDisputes: true, contradictedFields: true,
        // Identity-bearing, so a NOTE-scoped finding this pass writes names the
        // same canonical encounter the Records page shows.
        facility: true, pageEnd: true, substanceClass: true, segmentKey: true, analysisClass: true,
      },
    });
    // A document with no active rows is audited, not skipped — see planReaudit.
    const pages = await db.sourcePage.findMany({
      where: { sourceDocumentId: doc.id },
      select: { pageNumber: true, status: true, ocrConfidence: true },
    }).catch(() => [] as { pageNumber: number; status: string; ocrConfidence: number | null }[]);
    // The LATEST run, whatever its status. Reading only COMPLETE runs made an
    // abandoned or paused document look finished, and counting historical
    // failed runs made a document that later succeeded look broken.
    const run = await db.recordExtraction.findFirst({
      where: { sourceDocumentId: doc.id },
      orderBy: { createdAt: "desc" },
      select: { status: true, coverageGaps: true, failedSections: true, truncated: true },
    });
    built.push({
      id: doc.id,
      firmId: theCase.firmId,
      caseId: theCase.id,
      segments: doc.segments,
      rows: rows as never,
      pages,
      runState: (run?.status as ReauditRunState) ?? "NOT_RUN",
      run: {
        coverageGaps: run?.coverageGaps ?? 0,
        failedSections: run?.failedSections ?? 0,
        truncated: run?.truncated ?? false,
      },
    });
  }

  // Case facts from the LATEST run of each document, never from run counts.
  const failedDocs = built.filter((d) => d.runState === "EXTRACTION_FAILED" || d.runState === "BLOCKED_OCR").length;
  const allDocumentsProcessed = built.length > 0 && built.every((d) => d.runState === "COMPLETE");

  const plan = planReaudit(built, { failedExtractions: failedDocs, allDocumentsProcessed });

  console.log(`case ${theCase.caseNumber} — deterministic re-audit at ${AUDIT_VERSION}${dryRun ? " (dry run)" : ""}`);
  console.log(`  documents            ${plan.summary.documents} (${plan.summary.documentsEvaluated} evaluated, ${plan.summary.documentsSkipped} not authoritative)`);
  console.log(`  documents with no active rows  ${plan.summary.emptyDocuments}`);
  console.log(`  rows examined        ${plan.summary.rows}`);
  console.log(`  audit result changed ${plan.summary.changedResult}`);
  console.log(`  row status changed   ${plan.summary.changedStatus}`);
  console.log(`  human rows untouched ${plan.summary.humanRowsUntouched}`);
  console.log(`  scoped findings      ${plan.summary.findingsDerived}`);
  console.log(`  supersession scope   ${plan.evaluatedWholeCase ? "whole case (every document evaluated)" : `${plan.evaluatedDocumentIds.length} document(s); case-scope findings untouched`}`);
  console.log("  run states           ", render(tally(built.map((d) => d.runState))));

  const before = tally(plan.results.map((r) => r.before ?? "none"));
  const after = tally(plan.results.map((r) => r.after));
  console.log("\n  before:", render(before));
  console.log("  after :", render(after));

  if (dryRun) {
    // Read-only: report exactly what a real pass would change, at the grain it
    // would change it, and touch nothing.
    const wouldChange = plan.results.filter((r) => r.before !== r.after || r.statusBefore !== r.statusAfter).length;
    const supersedable = await db.recordFinding.count({
      where: {
        caseId: theCase.id,
        source: "DETERMINISTIC_VALIDATOR",
        status: "OPEN",
        OR: [
          ...(plan.evaluatedDocumentIds.length ? [{ sourceDocumentId: { in: plan.evaluatedDocumentIds } }] : []),
          ...(plan.evaluatedWholeCase ? [{ sourceDocumentId: null }] : []),
        ],
      },
    });
    console.log(`\ndry run: nothing written`);
    console.log(`  rows that would change            ${wouldChange}`);
    console.log(`  findings that would be written    ${plan.findings.length}`);
    console.log(`  open machine findings in scope    ${supersedable} (those not re-derived would resolve)`);
    return;
  }

  for (const r of plan.results) {
    if (r.before === r.after && r.statusBefore === r.statusAfter) continue;
    await db.extractedEncounter.update({
      where: { id: r.id },
      data: { auditResult: r.after, status: r.statusAfter, auditVersion: AUDIT_VERSION },
    });
  }
  const written = await writeFindings(db as never, plan.findings, {
    caseId: theCase.id,
    sources: ["DETERMINISTIC_VALIDATOR"],
    // Only the documents this pass actually read. A document whose latest run
    // did not complete keeps its findings: not reproducing a blocker is not
    // the same as establishing that it is gone.
    evaluatedDocumentIds: plan.evaluatedDocumentIds,
    evaluatedWholeCase: plan.evaluatedWholeCase,
  });
  console.log(
    `\nwrote ${written.written} finding(s); ${written.resolved} stale machine finding(s) resolved; ${written.reopened} disposition(s) reopened after a source change`,
  );
}

const tally = (values: string[]) => {
  const t = new Map<string, number>();
  for (const v of values) t.set(v, (t.get(v) ?? 0) + 1);
  return t;
};
const render = (t: Map<string, number>) => [...t].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ");

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
