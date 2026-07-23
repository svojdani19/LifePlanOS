// Clinical Validation Framework (Reliability Phase 13) — a release scorecard
// measured against the live database. Run per release and track over time.
//   npx tsx scripts/clinical-validation.ts
import { prisma } from "../src/lib/db";
import { lintAssessmentNarratives } from "../src/lib/engine/narrativeSanity";

async function main() {
  const asmts = await prisma.clinicalReasoningAssessment.findMany({ where: { status: { not: "SUPERSEDED" } } });
  const findings = await prisma.validationFinding.findMany({ select: { result: true, exportBlocking: true } });
  const items = await prisma.futureCareItem.count({ where: { supersededAt: null } });
  const decided = await prisma.futureCareItem.groupBy({ by: ["physicianStatus"], where: { supersededAt: null }, _count: true });
  const n = asmts.length || 1;
  const pct = (x: number) => `${Math.round((x / n) * 100)}%`;
  const has = (k: keyof (typeof asmts)[number]) => asmts.filter((a) => a[k] != null).length;
  const chainComplete = asmts.filter((a) => Array.isArray(a.reasoningChain) && (a.reasoningChain as unknown[]).length === 12).length;
  const insufficient = asmts.filter((a) => (a.evidenceSufficiency as { sufficient?: boolean } | null)?.sufficient === false).length;
  const anatomy = findings.filter((f) => /laterality|diagnosis mismatch/i.test(f.result)).length;
  const unsupported = findings.filter((f) => /unsupported|insufficient/i.test(f.result)).length;
  const badLit = findings.filter((f) => /citation|literature/i.test(f.result)).length;
  const statusOf = (s: string) => decided.find((d) => d.physicianStatus === s)?._count ?? 0;
  const reviewed = statusOf("APPROVED") + statusOf("MODIFIED") + statusOf("REJECTED");

  console.log("── Clinical Validation scorecard ────────────────────────────");
  console.log(`Assessments (current): ${asmts.length} covering ${items} recommendations`);
  console.log(`Reasoning completeness: chain ${pct(chainComplete)} · sufficiency ${pct(has("evidenceSufficiency"))} · critique ${pct(has("selfCritique"))} · confidence vector ${pct(has("confidenceVector"))}`);
  console.log(`Citation hygiene: ${badLit} literature findings open · Anatomy mismatches: ${anatomy}`);
  console.log(`Unsupported diagnosis/recommendation findings: ${unsupported} (blocking: ${findings.filter((f) => f.exportBlocking).length})`);
  console.log(`Insufficient-evidence verdicts (honestly stated): ${insufficient}`);
  // Narrative sanity sweep — every stored narrative linted against its item.
  const itemsById = new Map((await prisma.futureCareItem.findMany({ where: { supersededAt: null }, select: { id: true, physicianStatus: true, isLifetime: true, durationYears: true, frequencyPerYear: true } })).map((i) => [i.id, i]));
  let lintTotal = 0, lintHigh = 0;
  const ruleCounts = new Map<string, number>();
  for (const a of asmts) {
    const it = itemsById.get(a.recommendationId);
    const issues = lintAssessmentNarratives(a as never, { physicianStatus: it?.physicianStatus, isLifetime: it?.isLifetime, durationYears: it?.durationYears ?? null, frequencyPerYear: it?.frequencyPerYear, inclusionInTotalsStatus: a.inclusionInTotalsStatus ?? undefined, diagnosis: null });
    lintTotal += issues.length;
    lintHigh += issues.filter((x) => x.severity === "High").length;
    for (const x of issues) ruleCounts.set(x.rule, (ruleCounts.get(x.rule) ?? 0) + 1);
  }
  console.log(`Narrative sanity: ${lintTotal} issue(s) across ${asmts.length} assessments (${lintHigh} high) — ${[...ruleCounts.entries()].map(([k, v]) => `${k}×${v}`).join(", ") || "clean"}`);
  console.log(`Physician review: ${reviewed}/${items} decided · rejection rate ${items ? Math.round((statusOf("REJECTED") / items) * 100) : 0}% · modification rate ${items ? Math.round((statusOf("MODIFIED") / items) * 100) : 0}%`);
  console.log(`Statuses: ${[...new Set(asmts.map((a) => a.status))].map((s) => `${s}×${asmts.filter((a) => a.status === s).length}`).join(" · ")}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
