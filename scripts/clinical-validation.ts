// Clinical Validation Framework (Reliability Phase 13) — a release scorecard
// measured against the live database. Run per release and track over time.
//   npx tsx scripts/clinical-validation.ts
import { prisma } from "../src/lib/db";

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
  console.log(`Physician review: ${reviewed}/${items} decided · rejection rate ${items ? Math.round((statusOf("REJECTED") / items) * 100) : 0}% · modification rate ${items ? Math.round((statusOf("MODIFIED") / items) * 100) : 0}%`);
  console.log(`Statuses: ${[...new Set(asmts.map((a) => a.status))].map((s) => `${s}×${asmts.filter((a) => a.status === s).length}`).join(" · ")}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
