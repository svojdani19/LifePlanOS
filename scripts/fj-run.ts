// Reverse-analysis run: F.J. finalized LCP (Dr. Glazer, 09/15/2025) → LifePlanOS.
//
// The finalized plan was reverse-analyzed into its source clinical data
// (demographics, diagnoses, record chronology, treating providers, interview
// findings). This script seeds that data as a real case — the records-review
// text is attached as a document exactly as an uploaded record would be — and
// then runs the ACTUAL pipeline end-to-end: generatePlan (conditions →
// chronology → future care → citations → costs) → validation → clinical
// reasoning → DOCX export (final if unblocked; draft with watermark+appendix
// otherwise). Nothing is hand-placed downstream of intake: every condition,
// chronology event, recommendation, cost, and narrative is the program's own.
//
//   npx tsx scripts/fj-run.ts

import { readFileSync, writeFileSync } from "fs";
import { prisma } from "../src/lib/db";
import { generatePlan } from "../src/lib/engine/generate";
import { persistCaseValidation } from "../src/lib/engine/validation";
import { persistCaseReasoning } from "../src/lib/engine/clinicalReasoningPersist";
import { buildReportDocx } from "../src/lib/export/report";

const SOURCE_TEXT = "/private/tmp/claude-501/-Users-svojdani-Desktop-Claude/c5a96349-bf20-4238-ba9c-52c395667a87/scratchpad/fj-lcp.txt";

async function main() {
  const firm = await prisma.firm.findFirstOrThrow();
  const admin = await prisma.user.findFirstOrThrow({ where: { firmId: firm.id, role: "ADMIN" } });

  // Fresh case each run.
  const prior = await prisma.case.findFirst({ where: { firmId: firm.id, clientName: "Fredrika J." } });
  if (prior) { await prisma.case.delete({ where: { id: prior.id } }); console.log("(removed prior F.J. case)"); }

  const nCases = await prisma.case.count({ where: { firmId: firm.id } });
  const c = await prisma.case.create({
    data: {
      firmId: firm.id,
      createdById: admin.id,
      caseNumber: `LCP-2026-${String(nCases + 1).padStart(4, "0")}`,
      clientName: "Fredrika J.",
      dateOfBirth: new Date("1972-02-09"),
      sex: "FEMALE",
      caseType: "PERSONAL_INJURY",
      side: "PLAINTIFF",
      dateOfInjury: new Date("2023-06-11"),
      injurySpecialty: "TBI",
      diagnosis: "Mild traumatic brain injury with brief loss of consciousness",
      icd10Code: "S06.0X1A",
      additionalDiagnoses: [
        { diagnosis: "Postconcussional syndrome", icd10Code: "F07.81" },
        { diagnosis: "Chronic post-traumatic headache with migraine exacerbation", icd10Code: "G44.329" },
        { diagnosis: "Peripheral and central vestibular dysfunction", icd10Code: "H81.90" },
        { diagnosis: "Cervical disc herniation C6-C7 with radiculitis and cervicogenic headache", icd10Code: "M50.222" },
        { diagnosis: "Lumbar disc protrusion L4-L5 and L5-S1 with left radiculopathy, status post lumbar decompression", icd10Code: "M51.26" },
        { diagnosis: "Lumbar spinal stenosis with neurogenic claudication", icd10Code: "M48.062" },
        { diagnosis: "Aggravation of right knee degenerative arthritis, status post total knee arthroplasty with arthrofibrosis", icd10Code: "M17.11" },
        { diagnosis: "Adjustment disorder with anxiety and depressed mood, secondary to chronic pain", icd10Code: "F43.23" },
      ],
      lifeExpectancyYears: 32.2, // SSA remaining life expectancy per the record
      preExistingConditions:
        "Migraines (controlled pre-fall), anemia, osteoarthritis, right hip arthrodesis (age 12), right shoulder rotator cuff repair (2019), right knee arthroscopy and microfracture (2019), partial hysterectomy (2021), obesity",
      preExistingReviewed: true,
      status: "RECORDS",
    },
  });
  console.log("Case:", c.caseNumber, c.id);

  // The compiled records-review text (chronology entries, diagnoses, imaging
  // impressions, treatment notes) attached exactly as an uploaded record.
  const text = readFileSync(SOURCE_TEXT, "utf8");
  await prisma.document.create({
    data: {
      caseId: c.id, firmId: firm.id,
      filename: "FJ-compiled-medical-records.pdf",
      type: "MEDICAL_RECORD",
      status: "PROCESSED",
      pageCount: 43,
      extractedText: text,
      ocrConfidence: 0.98,
      uploadedById: admin.id,
    },
  });
  console.log("Document attached:", text.length, "chars");

  // Treating providers (confirmed from the record).
  const providers: [string, string, string, string][] = [
    ["Mark Emas, M.D.", "MD", "Neurology", "EMAS Spine and Brain Specialists"],
    ["Edward Young, M.D.", "MD", "Orthopedic Surgery", "Jacksonville Orthopaedic Institute"],
    ["David Doward, M.D.", "MD", "Orthopedic Spine Surgery", "Jacksonville Orthopaedic Institute"],
    ["Gregory Keller, M.D.", "MD", "Orthopedic Surgery", "Jacksonville Orthopaedic Institute"],
    ["Anika Goel, M.D.", "MD", "Neurology", "EMAS Spine and Brain Specialists"],
    ["Richard Newman, M.D.", "MD", "Neuro-otology", "EMAS Spine and Brain Specialists"],
    ["Robert Hurford, M.D.", "MD", "Orthopedic Surgery", "Southeast Orthopedic Specialists"],
    ["Jill A. Ward, M.D.", "MD", "Emergency Medicine", "HCA Florida Memorial Hospital"],
  ];
  const provIds = new Map<string, string>();
  for (const [name, credentials, specialty, facility] of providers) {
    const p = await prisma.treatingProvider.create({
      data: { caseId: c.id, firmId: firm.id, name, credentials, specialty, facility, status: "CONFIRMED", nameKey: name.toLowerCase().replace(/[^a-z]/g, ""), addedById: admin.id },
    });
    provIds.set(name, p.id);
  }
  console.log("Providers:", providers.length);

  // Interview findings — the patient interview (08/18/2025) and the treating
  // neurologist's peer-to-peer (09/08/2025), whose explicit frequency
  // recommendations ground the plan's cadences.
  const emasId = provIds.get("Mark Emas, M.D.")!;
  const interviews: { subject: "PATIENT" | "PROVIDER"; category: string; text: string; quote?: string; providerId?: string; interviewDate: string }[] = [
    { subject: "PATIENT", category: "current_complaints", interviewDate: "2025-08-18", text: "Ongoing headaches (now also posterior, exacerbated from controlled pre-fall migraines), neck pain, low back stiffness and pain radiating to the left lower extremity, memory impairment, dizziness with vestibular symptoms, insomnia, and mood symptoms including anxiety and depression, 27 months after the fall.", quote: "the only thing I remember is hearing my Mom knocking on the door and calling my name" },
    { subject: "PATIENT", category: "functional_limitations", interviewDate: "2025-08-18", text: "Significant physical functional impairment affecting several activities of daily living; easy aggravation with regular activities and secondary loss of function; fear/avoidance behaviors regarding further injections and surgery." },
    { subject: "PATIENT", category: "treatment_barriers", interviewDate: "2025-08-18", text: "Financial barriers to care: insurance copayments have been difficult to afford; vestibular therapy has been deferred because of copayment cost." },
    { subject: "PROVIDER", category: "provider_opinion", providerId: emasId, interviewDate: "2025-09-08", text: "All of the evaluation and treatment documented is related to the slip and fall of 06/11/2023. Recommends: neurology visits two to three per year; medications including gabapentin, nortriptyline (Pamelor), Ubrelvy, memantine, and baclofen; blood lab work at least twice per year; MRI of the brain, cervical spine, and lumbar spine every 5 years; VNG every 4 years; EMG/NCS of the lower extremities every 4 years; complex cognitive evaluation with a neuropsychologist every 3–5 years; vestibular therapy 4–6 visits every 3 years; long-term TENS device for pain management to reduce medication use; referral to pain management.", quote: "the injured party will continue to have repeated flare-ups two times a year and these flare-ups would increase in frequency as the individual gets older" },
    { subject: "PROVIDER", category: "provider_opinion", providerId: emasId, interviewDate: "2025-09-08", text: "As of the last visit (07/14/2025) the patient reported memory impairment, neck pain, low back pain, lower-extremity radicular pain, headaches, and vestibular impairment, all related to the fall. Pain and functional loss lasting 27 months make psychosocial barriers to recovery likely; evaluation by a psychologist is indicated." },
  ];
  for (const f of interviews) {
    await prisma.interviewFinding.create({ data: { caseId: c.id, firmId: firm.id, subject: f.subject, category: f.category, text: f.text, quote: f.quote ?? null, providerId: f.providerId ?? null, interviewDate: new Date(f.interviewDate), createdById: admin.id } });
  }
  console.log("Interview findings:", interviews.length);

  // ── Run the actual pipeline ────────────────────────────────────────────────
  console.log("\nRunning AI pipeline (conditions → chronology → future care → citations → costs)…");
  const result = await generatePlan(c.id, { userId: admin.id, role: "ADMIN" });
  console.log("Pipeline:", JSON.stringify(result));

  console.log("Running validation + clinical reasoning…");
  const validation = await persistCaseValidation(c.id, firm.id);
  const assessments = await persistCaseReasoning(c.id, firm.id, { actorUserId: admin.id });
  console.log("Validation findings:", validation.findings.length, "blocking:", validation.blocking);
  console.log("Reasoning assessments:", assessments.length, "statuses:", [...new Set(assessments.map((a) => a.status))].join(", "));

  // ── Export (final if unblocked; draft with watermark + appendix otherwise) ─
  const mode = validation.blocking ? "draft" : "final";
  const r = await buildReportDocx(c.id, "PLAINTIFF", { draft: mode === "draft" });
  const out = `/Users/svojdani/Desktop/lifeplanos/FJ-LifePlanOS-Output${mode === "draft" ? "-DRAFT" : ""}.docx`;
  writeFileSync(out, r.buffer);
  console.log(`\nExport mode: ${mode.toUpperCase()}`);
  console.log("Report written:", out, `(${(r.buffer.length / 1024).toFixed(0)} KB)`);
  console.log("Items:", r.itemCount, "· Lifetime (undiscounted):", Math.round(r.totalLifetime).toLocaleString(), "· Present value:", Math.round(r.totalPresentValue).toLocaleString());

  const items = await prisma.futureCareItem.findMany({ where: { caseId: c.id, supersededAt: null }, orderBy: { presentValue: "desc" }, select: { service: true, category: true, frequencyPerYear: true, isLifetime: true, durationYears: true, presentValue: true, lifetimeCost: true, probability: true } });
  console.log("\nTop recommendations:");
  for (const it of items.slice(0, 20)) {
    console.log(` • ${it.service} — ${it.frequencyPerYear}/yr ${it.isLifetime ? "for life" : it.durationYears ? `× ${it.durationYears}y` : "one-time"} · PV $${Math.round(it.presentValue).toLocaleString()} · ${it.probability}`);
  }
  console.log(`(${items.length} total)`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
