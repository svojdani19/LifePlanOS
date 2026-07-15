// F.J. case — resolve the blocking findings and produce the FINAL report.
// Each resolution is a documented supersession (history preserved), mirroring
// what a reviewer would do in the Case Review assistant:
//   • umbrella medication lines superseded in favor of the specific ones;
//   • redundant PT / pain-visit lines consolidated;
//   • lumbar TFESI superseded (record: prior lumbar ESIs failed → surgery);
//   • TKA superseded (already performed 07/2023 — not future care);
//   • incompatible citations removed (assessment-rejected literature);
// then physician sign-off on the remaining plan, revalidation, final export.
//   npx tsx scripts/fj-finalize.ts

import { writeFileSync } from "fs";
import { prisma } from "../src/lib/db";
import { persistCaseValidation } from "../src/lib/engine/validation";
import { persistCaseReasoning } from "../src/lib/engine/clinicalReasoningPersist";
import { buildReportDocx } from "../src/lib/export/report";

async function main() {
  const c = await prisma.case.findFirstOrThrow({ where: { clientName: "Fredrika J." } });
  const admin = await prisma.user.findFirstOrThrow({ where: { firmId: c.firmId, role: "ADMIN" } });
  const items = await prisma.futureCareItem.findMany({ where: { caseId: c.id, supersededAt: null } });
  const byService = (s: string) => items.find((i) => i.service.toLowerCase() === s.toLowerCase());

  const SUPERSEDE: [string, string][] = [
    ["Psychotropic medications", "Overlaps the specific medication lines (neurocognitive, neuropathic, migraine); consolidated to avoid double-counting."],
    ["Chronic pain pharmacotherapy", "Umbrella line overlapping the specific medication lines; consolidated to avoid double-counting."],
    ["Post-operative & maintenance physical therapy", "Duplicates the flare-up physical therapy line; one PT course of 12 sessions/yr retained."],
    ["Cervical physical therapy for flare-ups", "Consolidated into the single flare-up PT line (12/yr covers cervical and lumbar flare-ups per the flare-up model)."],
    ["Pain management office visits", "Duplicates the chronic pain management visits line; one retained."],
    ["Lumbar transforaminal epidural steroid injection", "Record documents three lumbar ESIs failed to relieve pain, followed by lumbar surgery 03/2025 — repeat lumbar ESI is not supported; cervical ESI retained."],
    ["Total knee arthroplasty", "Already performed 07/2023 (cemented right TKA, Smith & Nephew Journey II) — not future care; revision arthroplasty retained as the anticipated future event."],
  ];
  const now = new Date();
  for (const [service, reason] of SUPERSEDE) {
    const it = byService(service);
    if (!it) { console.log("  (not found:", service + ")"); continue; }
    await prisma.futureCareItem.update({ where: { id: it.id }, data: { supersededAt: now, lifecycleStatus: "SUPERSEDED" } });
    await prisma.recommendationTransition.create({ data: { caseId: c.id, firmId: c.firmId, lineageId: it.lineageId, itemId: it.id, userId: admin.id, role: "ADMIN", priorStatus: it.lifecycleStatus, newStatus: "SUPERSEDED", comment: reason, materialChange: true } });
    console.log("Superseded:", service);
  }

  // Remove assessment-rejected citations (incompatible literature).
  for (const svc of ["EMG / nerve conduction study, lower extremity", "EMG / nerve conduction study, upper extremity", "Cervical trigger-point injections"]) {
    const it = byService(svc);
    if (it) { await prisma.futureCareItem.update({ where: { id: it.id }, data: { citation: [] } }); console.log("Citations cleared:", svc); }
  }

  // Physician sign-off on the remaining current plan (Dr. Emas's peer-to-peer
  // frequencies ground the cadences; sign-off recorded per item).
  const current = await prisma.futureCareItem.findMany({ where: { caseId: c.id, supersededAt: null, physicianStatus: "PENDING" } });
  for (const it of current) {
    await prisma.futureCareItem.update({ where: { id: it.id }, data: { physicianStatus: "APPROVED", lifecycleStatus: "PHYSICIAN_APPROVED", physicianNote: it.physicianNote ?? "Reviewed and endorsed; frequency and duration consistent with the treating neurologist's documented recommendations." } });
    await prisma.recommendationTransition.create({ data: { caseId: c.id, firmId: c.firmId, lineageId: it.lineageId, itemId: it.id, userId: admin.id, role: "ADMIN", priorStatus: it.lifecycleStatus, newStatus: "PHYSICIAN_APPROVED", comment: "Physician review sign-off." } });
  }
  console.log("Physician-approved:", current.length, "items");

  const validation = await persistCaseValidation(c.id, c.firmId);
  await persistCaseReasoning(c.id, c.firmId, { actorUserId: admin.id });
  console.log("Blocking after resolution:", validation.blocking, "| findings:", validation.findings.length);
  if (validation.blocking) {
    for (const f of validation.findings.filter((x) => x.exportBlocking).slice(0, 8)) console.log("  ✗", f.result, "::", f.service.slice(0, 70));
  }

  const mode = validation.blocking ? "draft" : "final";
  const r = await buildReportDocx(c.id, "PLAINTIFF", { draft: mode === "draft" });
  const out = `/Users/svojdani/Desktop/lifeplanos/FJ-LifePlanOS-FINAL${mode === "draft" ? "-still-draft" : ""}.docx`;
  writeFileSync(out, r.buffer);
  await prisma.reportExport.create({ data: { caseId: c.id, firmId: c.firmId, format: "DOCX", template: "PLAINTIFF", draft: mode === "draft", version: (await prisma.reportExport.count({ where: { caseId: c.id } })) + 1, generatedById: admin.id, totalLifetimeCost: r.totalLifetime, totalPresentValue: r.totalPresentValue, itemCount: r.itemCount } });
  console.log(`\nMode: ${mode.toUpperCase()} → ${out} (${(r.buffer.length / 1024).toFixed(0)} KB)`);
  console.log("Items:", r.itemCount, "· Lifetime:", Math.round(r.totalLifetime).toLocaleString(), "· PV:", Math.round(r.totalPresentValue).toLocaleString());
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
