import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { ingestDocument } from "@/lib/documents/ingest";
import { generatePlan } from "@/lib/engine/generate";
import { buildReportDocx } from "@/lib/export/report";
import { storeAndRecord } from "@/lib/reports/persist";
import { lifecycleFor } from "@/lib/engine/lifecycle";
import { physicianBasis } from "@/lib/engine/lifeExpectancy";
import { deleteObject } from "@/lib/storage";
import { SAMPLE_DOCS } from "@/lib/documents/samples";
import { DEMO_FIRM_NAME, DEMO_FIRM_SLUG, DEMO_PERSONAS, demoPassword } from "@/lib/demo/config";
import type { Prisma, RecStatus, User } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Demo environment seed (docs/28 §6). Builds the fully synthetic "Life Care
// Plan Partners Demo" tenant: 13 personas (one per workspace role), 8 cases
// staged across the whole product lifecycle, plus engagements, findings,
// vocational/economic work product, one released report, and notifications.
//
// Everything here is OBVIOUSLY FICTIONAL (Demo- surnames, synthetic record
// text). Idempotent: an existing demo firm is deleted (refusing unless
// Firm.isDemo is true) and rebuilt from scratch. Reused by scripts/demo-seed.ts,
// scripts/demo-reset.ts, and the demo reset API.
// ─────────────────────────────────────────────────────────────────────────────

export interface DemoSeedSummary {
  firmId: string;
  users: number;
  roleAssignments: number;
  credentials: number;
  cases: number;
  documents: number;
  chronologyEvents: number;
  conditions: number;
  futureCareItems: number;
  validationFindings: number;
  vocationalEntries: number;
  economicAssumptions: number;
  economicScenarios: number;
  engagements: number;
  notifications: number;
  reportExports: number;
}

/**
 * Delete the demo firm and every row it owns. Finds the firm by the demo slug
 * and REFUSES to act unless Firm.isDemo is true — no other tenant can ever be
 * touched by this path. Returns true when a firm was deleted.
 */
export async function deleteDemoFirmData(): Promise<boolean> {
  const firm = await prisma.firm.findUnique({ where: { slug: DEMO_FIRM_SLUG } });
  if (!firm) return false;
  if (!firm.isDemo) {
    throw new Error(`Refusing to delete firm "${firm.slug}": Firm.isDemo is not true.`);
  }
  const firmId = firm.id;

  // Best-effort storage cleanup for stored report exports (PHI hygiene).
  const exports = await prisma.reportExport.findMany({ where: { firmId }, select: { storageKey: true } });
  for (const e of exports) {
    if (e.storageKey) await deleteObject(e.storageKey).catch(() => {});
  }

  // Models that carry firmId without an FK relation to Firm — these would be
  // orphaned by the cascade, so they are deleted explicitly first.
  await prisma.reportApproval.deleteMany({ where: { firmId } });
  await prisma.vocationalEntry.deleteMany({ where: { firmId } });
  await prisma.economicAssumption.deleteMany({ where: { firmId } });
  await prisma.economicScenario.deleteMany({ where: { firmId } });
  await prisma.futureDamagesEvaluation.deleteMany({ where: { firmId } });
  await prisma.caseEngagement.deleteMany({ where: { firmId } });
  await prisma.notification.deleteMany({ where: { firmId } });
  await prisma.userRoleAssignment.deleteMany({ where: { firmId } });
  await prisma.accessGrant.deleteMany({ where: { firmId } });
  await prisma.roleVersion.deleteMany({ where: { firmId } });
  await prisma.customRole.deleteMany({ where: { firmId } }); // cascades CustomRolePermission
  await prisma.office.deleteMany({ where: { firmId } });
  await prisma.learnedPrior.deleteMany({ where: { firmId } });
  await prisma.goldCase.deleteMany({ where: { firmId } });
  // Everything else (users, sessions, cases and all their clinical children,
  // documents, exports, audit, usage, credentials, …) cascades from the firm.
  await prisma.firm.delete({ where: { id: firmId } });
  return true;
}

// ── Small helpers ────────────────────────────────────────────────────────────

function period(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

/** Deterministic, internally consistent demo cost block for a care item. */
function costs(unitCost: number, frequencyPerYear: number, years: number) {
  const annualCost = Math.round(unitCost * frequencyPerYear);
  const lifetimeCost = Math.round(annualCost * years);
  return {
    unitCost,
    annualCost,
    lifetimeCost,
    presentValue: Math.round(lifetimeCost * 0.84),
    lowCost: Math.round(lifetimeCost * 0.85),
    highCost: Math.round(lifetimeCost * 1.2),
    pricingSource: "Medicare fee schedule benchmark (synthetic demo pricing)",
  };
}

interface Ctx {
  firmId: string;
  byEmail: Map<string, User>;
}

function u(ctx: Ctx, local: string): User {
  const user = ctx.byEmail.get(`${local}@demo.lifeplanos.com`);
  if (!user) throw new Error(`Demo persona missing: ${local}`);
  return user;
}

async function createDemoCase(
  ctx: Ctx,
  n: number,
  data: Omit<Prisma.CaseUncheckedCreateInput, "firmId" | "caseNumber">,
) {
  const c = await prisma.case.create({
    data: { firmId: ctx.firmId, caseNumber: `DEMO-2026-${String(n).padStart(4, "0")}`, ...data },
  });
  await prisma.usageRecord.create({
    data: { firmId: ctx.firmId, userId: data.createdById, metric: "CASE_CREATED", period: period(), caseId: c.id },
  });
  await prisma.auditLog.create({
    data: { firmId: ctx.firmId, userId: data.createdById, action: "case.create", targetType: "case", targetId: c.id, caseId: c.id },
  });
  return c;
}

const ingest = (ctx: Ctx, caseId: string, uploadedById: string, filename: string, text: string) =>
  ingestDocument({ caseId, firmId: ctx.firmId, uploadedById, filename, text });

// ── The seed ─────────────────────────────────────────────────────────────────

export async function seedDemoFirm(): Promise<DemoSeedSummary> {
  const password = demoPassword();
  if (!password) {
    throw new Error("DEMO_PASSWORD must be set to seed the demo environment in production.");
  }

  // Idempotent: rebuild from scratch (refuses to touch a non-demo firm).
  await deleteDemoFirmData();

  const passwordHash = await hashPassword(password);
  const now = new Date();

  const firm = await prisma.firm.create({
    data: {
      name: DEMO_FIRM_NAME,
      slug: DEMO_FIRM_SLUG,
      isDemo: true,
      state: "CA",
      primaryColor: "#0891b2",
      letterhead: "Life Care Plan Partners Demo · Synthetic evaluation environment · All persons and records fictional",
      subscription: {
        create: {
          tier: "ENTERPRISE",
          status: "ACTIVE",
          seats: 15,
          currentPeriodStart: now,
          currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        },
      },
      users: {
        create: DEMO_PERSONAS.map((p) => ({
          email: p.email,
          name: p.name,
          role: p.role,
          status: "ACTIVE" as const,
          passwordHash,
          preferredWorkspace: p.preferredWorkspace,
        })),
      },
    },
    include: { users: true },
  });

  const ctx: Ctx = { firmId: firm.id, byEmail: new Map(firm.users.map((x) => [x.email, x])) };
  const firmAdmin = u(ctx, "firm.admin");
  const caseManager = u(ctx, "case.manager");
  const planner = u(ctx, "planner");
  const physician = u(ctx, "physician");
  const attorney = u(ctx, "attorney");
  const vocational = u(ctx, "vocational");
  const economist = u(ctx, "economist");
  const qa = u(ctx, "qa");
  const medicalDirector = u(ctx, "medical.director");
  const recordsAnalyst = u(ctx, "records.analyst");
  const operations = u(ctx, "operations");

  // Role-template assignments (enterprise authz) — every persona carries ONLY
  // its intended template(s): the medical director's multi-role seat, the
  // observer's READ_ONLY_OBSERVER template, and the platform admin's
  // PLATFORM_SYSTEM_ADMINISTRATOR grant (the SOLE source of platform-admin
  // authority — src/lib/authz/platform.ts; no email lists anywhere).
  await prisma.userRoleAssignment.createMany({
    data: DEMO_PERSONAS.flatMap((p) => {
      const user = ctx.byEmail.get(p.email)!;
      return p.templateAssignments.map((builtInRole) => ({
        userId: user.id,
        firmId: firm.id,
        builtInRole,
        assignedById: firmAdmin.id,
        responsibility: builtInRole.replace(/_/g, " "),
        assignmentReason: "Synthetic demo persona",
        status: "ACTIVE",
        // Org-scoped (no officeId/caseId) and non-expiring (effectiveUntil null).
      }));
    }),
  });

  // Hard guarantee: the demo Super Admin's authority is this ACTIVE, org-scoped
  // DB grant. Fail loudly if it is ever missing.
  const platformGrants = await prisma.userRoleAssignment.count({
    where: {
      userId: u(ctx, "platform.admin").id,
      firmId: firm.id,
      builtInRole: "PLATFORM_SYSTEM_ADMINISTRATOR",
      status: "ACTIVE",
      effectiveUntil: null,
    },
  });
  if (platformGrants !== 1) {
    throw new Error("Demo seed integrity failure: platform.admin@demo.lifeplanos.com must hold exactly one ACTIVE PLATFORM_SYSTEM_ADMINISTRATOR assignment.");
  }

  // Org-verified credentials for the credential-gated experts.
  await prisma.userCredential.createMany({
    data: [
      { firmId: firm.id, userId: physician.id, type: "LICENSE" as const, category: "PHYSICIAN", label: "California Physician and Surgeon License (DEMO-P-10442)", filename: "synthetic-physician-license.txt", storageKey: "demo/credentials/physician-license", jurisdiction: "CA" },
      { firmId: firm.id, userId: vocational.id, type: "OTHER" as const, category: "VOCATIONAL", label: "Certified Rehabilitation Counselor (DEMO-CRC-2210)", filename: "synthetic-crc-certificate.txt", storageKey: "demo/credentials/vocational-crc" },
      { firmId: firm.id, userId: economist.id, type: "OTHER" as const, category: "ECONOMIST", label: "PhD, Economics — forensic economics practice (DEMO-PHD-77)", filename: "synthetic-economics-credential.txt", storageKey: "demo/credentials/economist-phd" },
      { firmId: firm.id, userId: medicalDirector.id, type: "LICENSE" as const, category: "PHYSICIAN", label: "California Physician and Surgeon License (DEMO-P-20881)", filename: "synthetic-medical-director-license.txt", storageKey: "demo/credentials/medical-director-license" },
    ].map((c) => ({ ...c, status: "ORG_VERIFIED", verifiedAt: now, verifiedById: firmAdmin.id, createdById: firmAdmin.id })),
  });

  // ── CASE 1 — fresh intake (case-manager workspace) ─────────────────────────
  const case1 = await createDemoCase(ctx, 1, {
    clientName: "Avery Demo-Castellanos",
    dateOfBirth: new Date("1991-03-14"),
    sex: "FEMALE",
    caseType: "PERSONAL_INJURY",
    side: "PLAINTIFF",
    status: "INTAKE",
    injurySpecialty: "GENERAL",
    jurisdiction: "CA — Los Angeles County",
    dateOfInjury: new Date("2026-05-02"),
    mechanism: "Rear-end motor vehicle collision (synthetic)",
    diagnosis: "Cervical strain with radicular complaints",
    createdById: caseManager.id,
  });

  // ── CASE 2 — records processing, with extraction issues (records analyst) ──
  const case2 = await createDemoCase(ctx, 2, {
    clientName: "Jordan Demo-Whitfield",
    dateOfBirth: new Date("1983-08-27"),
    sex: "MALE",
    caseType: "WORKERS_COMP",
    side: "NEUTRAL",
    status: "RECORDS",
    injurySpecialty: "ORTHOPEDIC_TRAUMA",
    jurisdiction: "CA — WCAB",
    dateOfInjury: new Date("2026-01-19"),
    mechanism: "Fall from scaffolding at a construction site (synthetic)",
    diagnosis: "Right distal radius fracture, status post ORIF",
    icd10Code: "S52.501A",
    createdById: caseManager.id,
  });
  await ingest(ctx, case2.id, recordsAnalyst.id, "Demo_ER_Record.pdf", `EMERGENCY DEPARTMENT RECORD
FACILITY: Demo Valley Medical Center, Fictionville, CA.
DATE OF SERVICE: 01/19/2026
ATTENDING: Dana Demoson, MD — Emergency Medicine.
CHIEF COMPLAINT: Right wrist pain after a fall from scaffolding, approximately 8 feet.
EXAM: Obvious dorsal deformity of the right wrist. Neurovascularly intact.
IMAGING: XR right wrist — displaced comminuted distal radius fracture.
DISPOSITION: Splinted, orthopedic surgery consulted, admitted for operative fixation.`);
  const case2op = await ingest(ctx, case2.id, recordsAnalyst.id, "Demo_Operative_Note.pdf", `OPERATIVE REPORT
FACILITY: Demo Valley Medical Center, Fictionville, CA.
DATE OF PROCEDURE: 01/20/2026
PREOPERATIVE DIAGNOSIS: Displaced comminuted right distal radius fracture.
POSTOPERATIVE DIAGNOSIS: Same.
PROCEDURE PERFORMED: Open reduction internal fixation, right distal radius, volar locking plate.
SURGEON: Lee Demoborn, MD — Orthopedic Surgery.
FINDINGS: Comminuted metaphyseal fracture reduced anatomically; fixation stable through range of motion.`);
  const case2pt = await ingest(ctx, case2.id, recordsAnalyst.id, "Demo_Therapy_Note.pdf", `PHYSICAL THERAPY PROGRESS NOTE
FACILITY: Demo Rehabilitation Associates, Fictionville, CA.
DATE OF SERVICE: 03/04/2026
THERAPIST: Sam Demofield, PT, DPT.
SUBJECTIVE: Right wrist stiffness and grip weakness; pain 4/10 with lifting at work simulation.
OBJECTIVE: Wrist extension 42 degrees, flexion 48 degrees. Grip 58 percent of contralateral side.
ASSESSMENT: Progressing; residual capsular stiffness and grip deficit.
PLAN: Continue skilled therapy 2x/week for 6 weeks; re-assess for work conditioning.`);
  // Flag one processed record as low-confidence OCR and add one failed upload —
  // the records-analyst queue needs real extraction issues to triage.
  await prisma.document.update({
    where: { id: case2pt.document.id },
    data: { ocrConfidence: 0.42, flags: "low OCR confidence" },
  });
  await prisma.document.create({
    data: {
      caseId: case2.id, firmId: firm.id, filename: "Demo_Scanned_Billing_Ledger.pdf",
      type: "BILLING_RECORD", status: "FAILED", pageCount: 0,
      flags: "corrupt file — re-upload requested", uploadedById: recordsAnalyst.id,
    },
  });

  // ── CASE 3 — chronology & causation built (planner / records review) ───────
  const case3 = await createDemoCase(ctx, 3, {
    clientName: "Priya Demo-Raghunathan",
    dateOfBirth: new Date("1976-11-02"),
    sex: "FEMALE",
    caseType: "MED_MAL",
    side: "PLAINTIFF",
    status: "CAUSATION",
    injurySpecialty: "SPINE",
    jurisdiction: "CA — Alameda County",
    dateOfInjury: new Date("2025-09-08"),
    mechanism: "Delayed recognition of cauda equina syndrome after presentation with saddle anesthesia (synthetic)",
    diagnosis: "Cauda equina syndrome with residual neurogenic bladder",
    icd10Code: "G83.4",
    createdById: planner.id,
  });
  const case3er = await ingest(ctx, case3.id, recordsAnalyst.id, "Demo_Initial_ER_Visit.pdf", `EMERGENCY DEPARTMENT RECORD
FACILITY: Demo General Hospital, Fictionville, CA.
DATE OF SERVICE: 09/08/2025
ATTENDING: Chris Demolane, MD — Emergency Medicine.
CHIEF COMPLAINT: Severe low back pain with new saddle numbness and difficulty voiding.
EXAM: Diminished perianal sensation, diminished rectal tone. Post-void residual not measured.
DISPOSITION: Discharged with analgesics and outpatient MRI referral.`);
  const case3mri = await ingest(ctx, case3.id, recordsAnalyst.id, "Demo_Lumbar_MRI.pdf", `MRI OF THE LUMBAR SPINE WITHOUT CONTRAST
FACILITY: Demo Imaging Center, Fictionville, CA.
DATE OF EXAM: 09/11/2025
IMPRESSION: Large central L4-L5 disc extrusion with severe canal stenosis and compression of the cauda equina.
RADIOLOGIST: Alex Demoray, MD — Diagnostic Radiology.`);
  const case3op = await ingest(ctx, case3.id, recordsAnalyst.id, "Demo_Decompression_Op_Note.pdf", `OPERATIVE REPORT
FACILITY: Demo University Medical Center, Fictionville, CA.
DATE OF PROCEDURE: 09/12/2025
PREOPERATIVE DIAGNOSIS: Cauda equina syndrome, L4-L5 disc extrusion.
PROCEDURE PERFORMED: Emergent L4-L5 laminectomy and discectomy.
SURGEON: Morgan Demostein, MD — Neurosurgery.
FINDINGS: Large extruded fragment compressing the thecal sac, removed; dura intact.`);
  await prisma.chronologyEvent.createMany({
    data: [
      { caseId: case3.id, eventDate: new Date("2025-09-08"), eventType: "ER_VISIT", provider: "Chris Demolane, MD", specialty: "Emergency Medicine", facility: "Demo General Hospital", summary: "Presentation with low back pain, saddle anesthesia, and voiding difficulty; discharged with outpatient MRI referral.", diagnosis: "Suspected lumbar radiculopathy", treatment: "Analgesics; outpatient MRI referral", relevanceScore: 95, relatedness: "RELATED", sourceDocumentId: case3er.document.id, sourceQuote: "new saddle numbness and difficulty voiding" },
      { caseId: case3.id, eventDate: new Date("2025-09-11"), eventType: "IMAGING", provider: "Alex Demoray, MD", specialty: "Radiology", facility: "Demo Imaging Center", summary: "Lumbar MRI: large central L4-L5 extrusion with severe canal stenosis compressing the cauda equina.", imagingFindings: "Large central L4-L5 disc extrusion; severe canal stenosis", relevanceScore: 98, relatedness: "RELATED", sourceDocumentId: case3mri.document.id, sourceQuote: "compression of the cauda equina" },
      { caseId: case3.id, eventDate: new Date("2025-09-12"), eventType: "SURGERY", provider: "Morgan Demostein, MD", specialty: "Neurosurgery", facility: "Demo University Medical Center", summary: "Emergent L4-L5 laminectomy and discectomy for cauda equina syndrome — 96 hours after initial presentation.", procedure: "L4-L5 laminectomy and discectomy", relevanceScore: 98, relatedness: "RELATED", sourceDocumentId: case3op.document.id },
      { caseId: case3.id, eventDate: new Date("2025-10-20"), eventType: "CLINIC_VISIT", provider: "Morgan Demostein, MD", specialty: "Neurosurgery", facility: "Demo University Medical Center", summary: "Post-operative follow-up: persistent neurogenic bladder requiring intermittent catheterization; referral to urology.", functionalStatus: "Self-catheterization 4x daily", relevanceScore: 90, relatedness: "RELATED" },
      { caseId: case3.id, eventDate: new Date("2025-12-04"), eventType: "CLINIC_VISIT", provider: "Jesse Demourol, MD", specialty: "Urology", facility: "Demo Urology Clinic", summary: "Urodynamics confirm areflexic bladder; long-term intermittent catheterization program established.", relevanceScore: 88, relatedness: "RELATED" },
      { caseId: case3.id, eventDate: new Date("2026-02-16"), eventType: "THERAPY", provider: "Sam Demofield, PT, DPT", specialty: "Physical Therapy", facility: "Demo Rehabilitation Associates", summary: "Ongoing pelvic-floor and gait therapy; mild residual left foot drop managed with an AFO.", relevanceScore: 70, relatedness: "RELATED" },
    ],
  });
  await prisma.condition.createMany({
    data: [
      { caseId: case3.id, name: "Cauda equina syndrome with residual neurogenic bladder", relatedness: "RELATED", confidence: 92, supportingRecords: "ER record 09/08/2025; MRI 09/11/2025; operative note 09/12/2025", objectiveEvidence: "MRI-documented cauda equina compression; urodynamics confirming areflexic bladder", reasoning: "Classic presentation with objectively confirmed compression and post-decompression residual deficits (synthetic demo analysis).", physicianConfirmed: true },
      { caseId: case3.id, name: "Left foot drop, partially resolved", relatedness: "RELATED", confidence: 74, supportingRecords: "Therapy notes 02/2026", objectiveEvidence: "Documented AFO use and gait deficits in therapy records", reasoning: "Residual motor deficit consistent with L5 root involvement of the index event.", physicianConfirmed: false },
      { caseId: case3.id, name: "Degenerative lumbar disc disease", relatedness: "PREEXISTING_UNRELATED", confidence: 66, supportingRecords: "MRI 09/11/2025 (degenerative changes at adjacent levels)", missingInfo: "Prior primary-care records to establish the pre-injury baseline", reasoning: "Age-consistent degenerative findings pre-dating the index presentation.", physicianConfirmed: false },
    ],
  });

  // ── CASE 4 — full pipeline, mixed physician-review states (physician) ──────
  const case4 = await createDemoCase(ctx, 4, {
    clientName: "Marcus Demo-Oyelaran",
    dateOfBirth: new Date("1988-06-30"),
    sex: "MALE",
    caseType: "PERSONAL_INJURY",
    side: "PLAINTIFF",
    status: "FUTURE_CARE",
    injurySpecialty: "SPINE",
    jurisdiction: "CA — Orange County",
    dateOfInjury: new Date("2024-06-05"),
    mechanism: "High-speed motor vehicle collision (synthetic)",
    diagnosis: "L1 burst fracture with incomplete spinal cord injury",
    icd10Code: "S32.019A",
    preparingPhysicianId: physician.id,
    createdById: planner.id,
  });
  for (const doc of SAMPLE_DOCS) {
    await ingest(ctx, case4.id, planner.id, doc.filename, doc.text);
  }
  const plan4 = await generatePlan(case4.id, { userId: planner.id, role: "PLANNER" });
  const items4 = await prisma.futureCareItem.findMany({
    where: { caseId: case4.id, supersededAt: null },
    orderBy: { presentValue: "desc" },
  });
  const setStatus = async (id: string, status: "APPROVED" | "MODIFIED" | "REJECTED", note?: string) => {
    await prisma.futureCareItem.update({
      where: { id },
      data: { physicianStatus: status, physicianNote: note, lifecycleStatus: lifecycleFor(status) as RecStatus },
    });
  };
  // A realistic review-in-progress mix: some approved, one modified, one
  // rejected, the rest pending for the physician workspace queue.
  for (const [i, item] of items4.entries()) {
    if (i < 3) await setStatus(item.id, "APPROVED");
    else if (i === 3) await setStatus(item.id, "MODIFIED", "Frequency reduced to reflect documented plateau in therapy response.");
    else if (i === 4) await setStatus(item.id, "REJECTED", "Not supported by the record; duplicative of the approved surveillance pathway.");
    // remaining items stay PENDING
  }
  await prisma.case.update({ where: { id: case4.id }, data: { status: "PHYSICIAN_REVIEW" } });

  // ── CASE 5 — attorney decision-ready (attorney workspace) ──────────────────
  const case5 = await createDemoCase(ctx, 5, {
    clientName: "Lena Demo-Vargas",
    dateOfBirth: new Date("1996-01-25"),
    sex: "FEMALE",
    caseType: "CATASTROPHIC",
    side: "PLAINTIFF",
    status: "DRAFTING",
    injurySpecialty: "TBI",
    jurisdiction: "CA — San Diego County",
    dateOfInjury: new Date("2025-04-12"),
    mechanism: "Pedestrian struck by delivery vehicle (synthetic)",
    diagnosis: "Moderate-severe traumatic brain injury with executive dysfunction",
    icd10Code: "S06.9X9S",
    lifeExpectancyYears: 48,
    lifeExpectancyBasis: json(physicianBasis(48, "Physiatry evaluation 03/2026 (synthetic)", "Modest reduction for severe TBI per rated-age assessment", null)),
    createdById: planner.id,
  });
  const c5cond = await prisma.condition.create({
    data: { caseId: case5.id, name: "Moderate-severe traumatic brain injury with executive dysfunction", relatedness: "RELATED", confidence: 90, objectiveEvidence: "CT/MRI-documented contusions; neuropsychological testing deficits (synthetic)", physicianConfirmed: true },
  });
  await prisma.futureCareItem.createMany({
    data: [
      { caseId: case5.id, conditionId: c5cond.id, category: "NEUROLOGY" as const, service: "Neurology follow-up evaluation", rationale: "Ongoing management of post-traumatic cognitive and seizure risk.", probability: "PROBABLE" as const, confidence: 85, frequencyPerYear: 2, isLifetime: true, ...costs(320, 2, 48), origin: "PLANNER_ADDED" as const, physicianStatus: "APPROVED" as const, lifecycleStatus: "PHYSICIAN_APPROVED", evidenceStrength: "Guideline-supported" },
      { caseId: case5.id, conditionId: c5cond.id, category: "COGNITIVE_THERAPY" as const, service: "Cognitive rehabilitation therapy", rationale: "Executive-function retraining with documented benefit in the record.", probability: "PROBABLE" as const, confidence: 80, frequencyPerYear: 24, durationYears: 3, ...costs(190, 24, 3), origin: "PLANNER_ADDED" as const, physicianStatus: "APPROVED" as const, lifecycleStatus: "PHYSICIAN_APPROVED", evidenceStrength: "Guideline-supported" },
      { caseId: case5.id, conditionId: c5cond.id, category: "PSYCH" as const, service: "Neuropsychological re-evaluation", rationale: "Serial objective measurement of cognitive trajectory.", probability: "PROBABLE" as const, confidence: 78, frequencyPerYear: 0.5, durationYears: 10, ...costs(2400, 0.5, 10), origin: "PLANNER_ADDED" as const, physicianStatus: "APPROVED" as const, lifecycleStatus: "PHYSICIAN_APPROVED" },
      { caseId: case5.id, conditionId: c5cond.id, category: "ATTENDANT_CARE" as const, service: "Life-skills coaching / attendant support", rationale: "Supervision for safety and community reintegration.", probability: "PROBABLE" as const, confidence: 72, frequencyPerYear: 520, durationYears: 5, ...costs(38, 520, 5), origin: "PLANNER_ADDED" as const, physicianStatus: "APPROVED" as const, lifecycleStatus: "PHYSICIAN_APPROVED" },
      { caseId: case5.id, conditionId: c5cond.id, category: "MEDICATION" as const, service: "Anticonvulsant medication management", rationale: "Post-traumatic seizure prophylaxis continued per neurology.", probability: "PROBABLE" as const, confidence: 82, frequencyPerYear: 12, isLifetime: true, ...costs(45, 12, 48), origin: "PLANNER_ADDED" as const, physicianStatus: "APPROVED" as const, lifecycleStatus: "PHYSICIAN_APPROVED" },
    ],
  });
  const eng5 = await prisma.caseEngagement.create({
    data: {
      firmId: firm.id, caseId: case5.id, requestedById: planner.id, reportType: "LIFE_CARE_PLAN",
      serviceType: "Comprehensive life care plan", status: "RECOMMENDED",
      scope: "Full future-care plan with physician attestation for mediation.",
      feeEstimate: 7500, feeStructure: "Flat fee",
      estimatedCompletionDate: new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000),
      missingRequirements: json(["Attorney authorization"]),
    },
  });

  // ── CASE 6 — QA gate with export-blocking findings (QA workspace) ──────────
  const case6 = await createDemoCase(ctx, 6, {
    clientName: "Samuel Demo-Okonkwo",
    dateOfBirth: new Date("1970-05-09"),
    sex: "MALE",
    caseType: "MED_MAL",
    side: "PLAINTIFF",
    status: "PRICING",
    injurySpecialty: "AMPUTATION",
    jurisdiction: "CA — Sacramento County",
    dateOfInjury: new Date("2025-02-14"),
    mechanism: "Popliteal artery injury with failed revascularization (synthetic)",
    diagnosis: "Left transfemoral amputation",
    icd10Code: "Z89.612",
    createdById: planner.id,
  });
  await ingest(ctx, case6.id, recordsAnalyst.id, "Demo_Discharge_Summary.pdf", `DISCHARGE SUMMARY
FACILITY: Demo Regional Medical Center, Fictionville, CA.
ADMISSION: 02/14/2025  DISCHARGE: 03/06/2025
ATTENDING: Pat Demovas, MD — Vascular Surgery.
HOSPITAL COURSE: Popliteal artery injury; revascularization attempted and failed with progressive ischemia, requiring left transfemoral amputation on 02/18/2025. Post-operative course complicated by wound infection treated with IV antibiotics.
DISCHARGE DISPOSITION: Inpatient rehabilitation facility, prosthetic candidacy evaluation planned.`);
  const c6cond = await prisma.condition.create({
    data: { caseId: case6.id, name: "Left transfemoral amputation", relatedness: "RELATED", confidence: 95, objectiveEvidence: "Operative and discharge records documenting amputation (synthetic)", physicianConfirmed: true },
  });
  await prisma.futureCareItem.createMany({
    data: [
      { caseId: case6.id, conditionId: c6cond.id, category: "ORTHOTICS_PROSTHETICS" as const, service: "Transfemoral prosthesis with microprocessor knee", rationale: "Definitive prosthesis for community ambulation.", probability: "PROBABLE" as const, confidence: 88, frequencyPerYear: 0.2, isLifetime: true, ...costs(65000, 0.2, 25), origin: "PLANNER_ADDED" as const, physicianStatus: "APPROVED" as const, lifecycleStatus: "PHYSICIAN_APPROVED", evidenceStrength: "Limited — citation pending", citation: undefined },
      // Deliberate defect: lifetimeCost does NOT reconcile with annual × years.
      { caseId: case6.id, conditionId: c6cond.id, category: "PHYSICAL_THERAPY" as const, service: "Prosthetic gait training", rationale: "Skilled therapy for prosthetic ambulation.", probability: "PROBABLE" as const, confidence: 80, frequencyPerYear: 24, durationYears: 10, unitCost: 200, annualCost: 4800, lifetimeCost: 91000, presentValue: 76000, lowCost: 40800, highCost: 99000, pricingSource: "Synthetic demo pricing", origin: "PLANNER_ADDED" as const, physicianStatus: "APPROVED" as const, lifecycleStatus: "PHYSICIAN_APPROVED" },
      { caseId: case6.id, conditionId: c6cond.id, category: "PHYSICIAN_VISIT" as const, service: "Physiatry follow-up", rationale: "Residual-limb and prosthetic-fit surveillance.", probability: "PROBABLE" as const, confidence: 84, frequencyPerYear: 2, isLifetime: true, ...costs(280, 2, 25), origin: "PLANNER_ADDED" as const, physicianStatus: "PENDING" as const, lifecycleStatus: "SENT_FOR_PHYSICIAN_REVIEW" },
      { caseId: case6.id, conditionId: c6cond.id, category: "DME" as const, service: "Shower chair and transfer equipment", rationale: "Bathroom safety with single-limb stance.", probability: "PROBABLE" as const, confidence: 75, frequencyPerYear: 0.2, isLifetime: true, ...costs(450, 0.2, 25), origin: "PLANNER_ADDED" as const, physicianStatus: "PENDING" as const, lifecycleStatus: "SENT_FOR_PHYSICIAN_REVIEW" },
    ],
  });
  await prisma.validationFinding.createMany({
    data: [
      { caseId: case6.id, firmId: firm.id, service: "Transfemoral prosthesis with microprocessor knee", result: "Missing citation", issue: "A lifetime prosthetic recommendation totaling over $300,000 carries no supporting literature citation.", severity: "Critical", suggestion: "Attach at least one peer-reviewed source or a physician attestation supporting microprocessor-knee medical necessity.", exportBlocking: true },
      { caseId: case6.id, firmId: firm.id, service: "Prosthetic gait training", result: "Cost inconsistency", issue: "Lifetime cost ($91,000) does not reconcile with annual cost × duration ($4,800 × 10 = $48,000).", severity: "High", suggestion: "Recompute the lifetime figure from unit cost, frequency, and duration, or document the escalation assumption.", exportBlocking: true },
      { caseId: case6.id, firmId: firm.id, service: "Physiatry follow-up", result: "Physician review pending", issue: "Two recommendations have not completed physician review.", severity: "Moderate", suggestion: "Route the pending items to the physician review queue before drafting.", exportBlocking: false },
      { caseId: case6.id, firmId: firm.id, service: "Plan totals", result: "Life-expectancy basis unstated", issue: "Lifetime items are totaled without a recorded life-expectancy basis.", severity: "Moderate", suggestion: "Record the actuarial baseline or physician determination on the case assumptions.", exportBlocking: false },
    ],
  });
  const eng6 = await prisma.caseEngagement.create({
    data: {
      firmId: firm.id, caseId: case6.id, requestedById: attorney.id, authorizedById: attorney.id,
      reportType: "LIFE_CARE_PLAN", serviceType: "Life care plan with QA review", status: "IN_PROGRESS",
      authorizedAt: new Date(now.getTime() - 12 * 24 * 60 * 60 * 1000),
      assignedPlannerId: planner.id, assignedQaReviewerId: qa.id,
      feeEstimate: 8200, feeStructure: "Flat fee",
    },
  });

  // ── CASE 7 — finalized with a released report (attorney / observer) ────────
  const case7 = await createDemoCase(ctx, 7, {
    clientName: "Grace Demo-Lindqvist",
    dateOfBirth: new Date("1968-09-17"),
    sex: "FEMALE",
    caseType: "PERSONAL_INJURY",
    side: "PLAINTIFF",
    status: "FINAL",
    injurySpecialty: "KNEE_ARTHROPLASTY",
    jurisdiction: "NV — Clark County",
    dateOfInjury: new Date("2024-10-03"),
    mechanism: "T-bone intersection collision (synthetic)",
    diagnosis: "Post-traumatic arthritis, right knee, status post total knee arthroplasty",
    icd10Code: "M17.31",
    lifeExpectancyYears: 24,
    lifeExpectancyBasis: json(physicianBasis(24, "Orthopedic IME 04/2026 (synthetic)", "Actuarial figure adopted without adjustment", null)),
    preparingPhysicianId: physician.id,
    createdById: planner.id,
  });
  const case7op = await ingest(ctx, case7.id, recordsAnalyst.id, "Demo_TKA_Operative_Note.pdf", `OPERATIVE REPORT
FACILITY: Demo Orthopedic Institute, Fictionville, NV.
DATE OF PROCEDURE: 05/22/2025
PREOPERATIVE DIAGNOSIS: Post-traumatic arthritis, right knee.
POSTOPERATIVE DIAGNOSIS: Same.
PROCEDURE PERFORMED: Right total knee arthroplasty, cemented components.
SURGEON: Jordan Demoknee, MD — Orthopedic Surgery.
FINDINGS: Advanced tricompartmental degeneration with post-traumatic deformity; components well fixed and stable.`);
  await ingest(ctx, case7.id, recordsAnalyst.id, "Demo_Orthopedic_Followup.pdf", `ORTHOPEDIC CLINIC NOTE
FACILITY: Demo Orthopedic Institute, Fictionville, NV.
DATE OF SERVICE: 03/10/2026
PHYSICIAN: Jordan Demoknee, MD — Orthopedic Surgery.
SUBJECTIVE: Intermittent aching with prolonged standing; overall satisfied with the arthroplasty.
OBJECTIVE: Range of motion 0-118 degrees. Radiographs show well-fixed components without loosening.
ASSESSMENT: Satisfactory result; lifetime surveillance recommended given age and activity level.
PLAN: Annual radiographic surveillance; revision arthroplasty anticipated within the implant survivorship horizon.`);
  const c7cond = await prisma.condition.create({
    data: { caseId: case7.id, name: "Post-traumatic arthritis, right knee, status post total knee arthroplasty", relatedness: "RELATED", confidence: 93, supportingRecords: "Operative note 05/22/2025; orthopedic follow-up 03/10/2026", objectiveEvidence: "Radiographically documented tricompartmental degeneration; operative findings", evidenceSources: json([{ documentId: case7op.document.id, filename: "Demo_TKA_Operative_Note.pdf", page: 1, quote: "Advanced tricompartmental degeneration with post-traumatic deformity" }]), physicianConfirmed: true },
  });
  const demoCitation = (title: string) => json([{ source: "demo", title, authors: "Demo Author Collective", journal: "Journal of Synthetic Orthopaedics", year: "2024", url: "https://example.org/demo-citation" }]);
  await prisma.futureCareItem.createMany({
    data: [
      { caseId: case7.id, conditionId: c7cond.id, category: "REVISION_SURGERY" as const, service: "Revision total knee arthroplasty", rationale: "Implant survivorship makes one revision within the remaining life expectancy medically probable.", probability: "PROBABLE" as const, confidence: 82, frequencyPerYear: 0.05, durationYears: 20, ...costs(52000, 0.05, 20), origin: "PLANNER_ADDED" as const, physicianStatus: "APPROVED" as const, lifecycleStatus: "PHYSICIAN_APPROVED", evidenceStrength: "Guideline-supported", citation: demoCitation("Long-term survivorship of primary total knee arthroplasty") },
      { caseId: case7.id, conditionId: c7cond.id, category: "SPECIALIST_VISIT" as const, service: "Orthopedic surveillance visit with radiographs", rationale: "Annual component surveillance per orthopedic follow-up plan.", probability: "PROBABLE" as const, confidence: 88, frequencyPerYear: 1, isLifetime: true, ...costs(410, 1, 24), origin: "PLANNER_ADDED" as const, physicianStatus: "APPROVED" as const, lifecycleStatus: "PHYSICIAN_APPROVED", evidenceStrength: "Guideline-supported", citation: demoCitation("Surveillance after total knee arthroplasty: consensus recommendations") },
      { caseId: case7.id, conditionId: c7cond.id, category: "PHYSICAL_THERAPY" as const, service: "Post-revision physical therapy course", rationale: "Skilled rehabilitation following the anticipated revision.", probability: "PROBABLE" as const, confidence: 78, frequencyPerYear: 24, durationYears: 1, ...costs(185, 24, 1), origin: "PLANNER_ADDED" as const, physicianStatus: "APPROVED" as const, lifecycleStatus: "PHYSICIAN_APPROVED" },
      { caseId: case7.id, conditionId: c7cond.id, category: "MEDICATION" as const, service: "Analgesic and anti-inflammatory management", rationale: "Symptomatic management of activity-related pain.", probability: "PROBABLE" as const, confidence: 80, frequencyPerYear: 12, isLifetime: true, ...costs(28, 12, 24), origin: "PLANNER_ADDED" as const, physicianStatus: "APPROVED" as const, lifecycleStatus: "PHYSICIAN_APPROVED" },
    ],
  });
  // Generate the real report through the actual pipeline and record it as the
  // released, final (non-draft) export.
  const payload7 = await buildReportDocx(case7.id, "PLAINTIFF", { draft: false });
  const export7 = await storeAndRecord(payload7.buffer, ".docx", {
    caseId: case7.id,
    firmId: firm.id,
    format: "DOCX",
    template: "PLAINTIFF",
    draft: false,
    reportType: "LIFE_CARE_PLAN",
    generatedById: planner.id,
    totalLifetimeCost: payload7.totalLifetime,
    totalPresentValue: payload7.totalPresentValue,
    itemCount: payload7.itemCount,
    lifecycle: "final_expert",
  });
  await prisma.usageRecord.create({
    data: { firmId: firm.id, userId: planner.id, metric: "REPORT_EXPORT", period: period(), caseId: case7.id },
  });
  await prisma.auditLog.create({
    data: { firmId: firm.id, userId: planner.id, action: "export.report", targetType: "report", targetId: export7.id, caseId: case7.id },
  });
  const eng7 = await prisma.caseEngagement.create({
    data: {
      firmId: firm.id, caseId: case7.id, requestedById: attorney.id, authorizedById: attorney.id,
      reportType: "LIFE_CARE_PLAN", serviceType: "Comprehensive life care plan", status: "COMPLETED",
      authorizedAt: new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000),
      completedAt: now,
      assignedPlannerId: planner.id, assignedPhysicianId: physician.id,
      feeEstimate: 6900, feeStructure: "Flat fee",
    },
  });

  // ── CASE 8 — vocational + economic work product (vocational / economist) ───
  const case8 = await createDemoCase(ctx, 8, {
    clientName: "Diego Demo-Marchetti",
    dateOfBirth: new Date("1985-12-08"),
    sex: "MALE",
    caseType: "WORKERS_COMP",
    side: "PLAINTIFF",
    status: "PRICING",
    injurySpecialty: "ORTHOPEDIC_TRAUMA",
    jurisdiction: "CA — Fresno County",
    dateOfInjury: new Date("2025-06-30"),
    mechanism: "Dominant right hand crushed in a hydraulic press (synthetic)",
    diagnosis: "Complex crush injury, dominant right hand, with post-traumatic CRPS",
    icd10Code: "S67.191A",
    currentWorkStatus: "Disabled",
    disabilityReason: "Unable to perform bilateral heavy manipulation required by machinist role",
    createdById: caseManager.id,
  });
  await prisma.vocationalEntry.createMany({
    data: [
      { firmId: firm.id, caseId: case8.id, kind: "employment", title: "CNC machinist — Demo Precision Works LLC (2011-2025)", detail: json({ employer: "Demo Precision Works LLC", role: "CNC machinist", wage: "$32.90/hr", exertion: "Medium-heavy" }), startDate: new Date("2011-04-01"), endDate: new Date("2025-06-30"), source: "Employment records, Demo Precision Works LLC (synthetic)", enteredById: vocational.id, verification: "VERIFIED" },
      { firmId: firm.id, caseId: case8.id, kind: "education", title: "High school diploma; machining certificate program", detail: json({ level: "HS diploma + vocational certificate", year: 2010 }), source: "Client interview 04/2026 and transcript (synthetic)", enteredById: vocational.id, verification: "VERIFIED" },
      { firmId: firm.id, caseId: case8.id, kind: "certification", title: "NIMS Level I machining credential", detail: json({ issuer: "NIMS", status: "Current" }), source: "Certificate on file (synthetic)", enteredById: vocational.id, verification: "VERIFIED" },
      { firmId: firm.id, caseId: case8.id, kind: "functional_capacity", title: "FCE: no forceful gripping or fine manipulation with the right hand", detail: json({ grip: "12 percent of contralateral", lifting: "10 lb occasional", manipulation: "No sustained fine manipulation right hand" }), source: "Functional capacity evaluation 03/2026 (synthetic)", enteredById: vocational.id, verification: "VERIFIED" },
      { firmId: firm.id, caseId: case8.id, kind: "restriction", title: "Permanent restriction from machine-tending and vibration exposure", detail: json({ basis: "Hand surgeon permanent-and-stationary report" }), source: "P&S report, Demo Hand Center 02/2026 (synthetic)", enteredById: vocational.id, verification: "VERIFIED" },
      { firmId: firm.id, caseId: case8.id, kind: "transferable_skill", title: "Blueprint reading, CAM programming exposure, quality inspection", detail: json({ skills: ["blueprint reading", "CAM programming (basic)", "quality inspection"] }), source: "Vocational interview 04/2026 (synthetic)", enteredById: vocational.id },
      { firmId: firm.id, caseId: case8.id, kind: "labor_market", title: "Regional survey: quality-inspection and CNC-programming roles", detail: json({ region: "Fresno MSA", medianWage: "$23.10/hr", openings: 41 }), source: "Demo labor-market survey, Q1 2026 (synthetic)", enteredById: vocational.id },
      { firmId: firm.id, caseId: case8.id, kind: "scenario", title: "Return-to-work scenario: quality inspector after retraining", detail: json({ pathway: "12-month metrology retraining", projectedWage: "$24.50/hr", probability: "probable" }), source: "Vocational analysis (synthetic)", enteredById: vocational.id },
      { firmId: firm.id, caseId: case8.id, kind: "conclusion", title: "Partial permanent vocational loss with residual earning capacity", detail: json({ preInjuryCapacity: "$68,500/yr", postInjuryCapacity: "$50,960/yr", annualLoss: "$17,540/yr" }), source: "Vocational expert analysis 04/2026 (synthetic)", enteredById: vocational.id },
    ],
  });
  await prisma.economicAssumption.createMany({
    data: [
      { firmId: firm.id, caseId: case8.id, key: "baseline_earnings", value: "68500", unit: "USD/year", source: "W-2 wage records 2022-2024 (synthetic)", expertId: economist.id, rationale: "Three-year average of documented earnings." },
      { firmId: firm.id, caseId: case8.id, key: "earnings_growth", value: "2.8", unit: "percent", source: "Demo BLS ECI series (synthetic)", expertId: economist.id },
      { firmId: firm.id, caseId: case8.id, key: "benefits_rate", value: "21", unit: "percent", source: "Demo ECEC employer-cost tables (synthetic)", expertId: economist.id },
      { firmId: firm.id, caseId: case8.id, key: "worklife_expectancy", value: "17.4", unit: "years", source: "Demo worklife tables, male, HS education (synthetic)", expertId: economist.id },
      { firmId: firm.id, caseId: case8.id, key: "loss_start", value: "2025-06-30", unit: "date", source: "Date of injury per employer records", expertId: economist.id },
      { firmId: firm.id, caseId: case8.id, key: "discount_rate", value: "3.0", unit: "percent", source: "Demo Treasury real-yield ladder (synthetic)", expertId: economist.id, rationale: "Net discount consistent with jurisdictional practice." },
      { firmId: firm.id, caseId: case8.id, key: "inflation_rate", value: "3.2", unit: "percent", source: "Demo medical CPI series (synthetic)", expertId: economist.id },
      { firmId: firm.id, caseId: case8.id, key: "household_services_hours", value: "5", unit: "hours/week", source: "Client and spouse interview 04/2026 (synthetic)", expertId: economist.id, rationale: "Reduced yard, maintenance, and repair contributions." },
    ],
  });
  await prisma.economicScenario.createMany({
    data: [
      { firmId: firm.id, caseId: case8.id, name: "base", overrides: json({}), result: json({ pastLoss: 71400, futureLoss: 262300, benefits: 70100, householdServices: 48200, medicalPV: 0, total: 452000, inputsHash: "demo-base" }), computedAt: now },
      { firmId: firm.id, caseId: case8.id, name: "low", overrides: json({ earnings_growth: "2.2", worklife_expectancy: "15.0" }), result: json({ pastLoss: 71400, futureLoss: 214800, benefits: 60100, householdServices: 41500, medicalPV: 0, total: 387800, inputsHash: "demo-low" }), computedAt: now },
      { firmId: firm.id, caseId: case8.id, name: "high", overrides: json({ earnings_growth: "3.4", worklife_expectancy: "19.5" }), result: json({ pastLoss: 71400, futureLoss: 311900, benefits: 80400, householdServices: 55600, medicalPV: 0, total: 519300, inputsHash: "demo-high" }), computedAt: now },
    ],
  });
  const eng8a = await prisma.caseEngagement.create({
    data: {
      firmId: firm.id, caseId: case8.id, requestedById: attorney.id, authorizedById: attorney.id,
      reportType: "VOCATIONAL_ASSESSMENT", serviceType: "Vocational assessment", status: "IN_PROGRESS",
      authorizedAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      assignedVocationalExpertId: vocational.id, feeEstimate: 3400, feeStructure: "Flat fee",
    },
  });
  const eng8b = await prisma.caseEngagement.create({
    data: {
      firmId: firm.id, caseId: case8.id, requestedById: attorney.id, authorizedById: attorney.id,
      reportType: "FORENSIC_ECONOMIST_REPORT", serviceType: "Economic-loss analysis", status: "AUTHORIZED",
      authorizedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      assignedEconomistId: economist.id, feeEstimate: 4100, feeStructure: "Hourly, capped",
    },
  });
  // A cancelled records-review engagement on CASE 2 rounds out the statuses.
  const eng2 = await prisma.caseEngagement.create({
    data: {
      firmId: firm.id, caseId: case2.id, requestedById: caseManager.id,
      reportType: "MEDICAL_RECORD_SUMMARY", serviceType: "Record summary", status: "CANCELLED",
      cancellationStatus: "Withdrawn by carrier before authorization",
      cancelledAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
    },
  });
  void eng5; void eng6; void eng7; void eng8a; void eng8b; void eng2;

  // ── Notifications across the personas ──────────────────────────────────────
  await prisma.notification.createMany({
    data: [
      { firmId: firm.id, userId: attorney.id, kind: "engagement.recommended", title: "Life care plan recommended — Lena Demo-Vargas", body: "The damages posture supports a comprehensive life care plan. Review the recommendation and authorize the engagement.", caseId: case5.id },
      { firmId: firm.id, userId: attorney.id, kind: "report.released", title: "Final report released — Grace Demo-Lindqvist", body: "The finalized Life Care Plan has been released and is available for download.", caseId: case7.id },
      { firmId: firm.id, userId: physician.id, kind: "review.requested", title: "Physician review requested — Marcus Demo-Oyelaran", body: "Future-care recommendations are awaiting your independent medical-necessity review.", caseId: case4.id },
      { firmId: firm.id, userId: qa.id, kind: "qa.blocking", title: "Export-blocking findings — Samuel Demo-Okonkwo", body: "Two export-blocking validation findings (missing citation, cost inconsistency) require resolution before drafting.", caseId: case6.id },
      { firmId: firm.id, userId: vocational.id, kind: "engagement.authorized", title: "Vocational assessment in progress — Diego Demo-Marchetti", body: "Your vocational assessment engagement is active. FCE and employment records are on file.", caseId: case8.id },
      { firmId: firm.id, userId: economist.id, kind: "engagement.authorized", title: "Economic-loss analysis authorized — Diego Demo-Marchetti", body: "The attorney authorized the forensic-economic engagement. Assumptions are staged for your review.", caseId: case8.id },
      { firmId: firm.id, userId: recordsAnalyst.id, kind: "records.issue", title: "Extraction issues — Jordan Demo-Whitfield", body: "One upload failed (corrupt file) and one record has low OCR confidence.", caseId: case2.id },
      { firmId: firm.id, userId: caseManager.id, kind: "case.intake", title: "New matter awaiting intake — Avery Demo-Castellanos", body: "Complete required intake fields and request initial records authorizations.", caseId: case1.id },
      { firmId: firm.id, userId: planner.id, kind: "review.returned", title: "Physician review progressing — Marcus Demo-Oyelaran", body: "One recommendation was modified and one rejected; the remainder are pending.", caseId: case4.id },
      { firmId: firm.id, userId: operations.id, kind: "engagement.completed", title: "Engagement completed — Grace Demo-Lindqvist", body: "The life care plan engagement completed with the final report released.", caseId: case7.id },
    ],
  });

  // A little AI-generation usage so dashboards show non-zero meters.
  await prisma.usageRecord.createMany({
    data: Array.from({ length: 24 }, () => ({
      firmId: firm.id, userId: planner.id, metric: "AI_GENERATION" as const, period: period(),
    })),
  });

  void case1; void plan4;

  // ── Summary + seed audit event ─────────────────────────────────────────────
  const [documents, chronologyEvents, conditions, futureCareItems, validationFindings, vocationalEntries, economicAssumptions, economicScenarios, engagements, notifications, reportExports, roleAssignments, credentials] = await Promise.all([
    prisma.document.count({ where: { firmId: firm.id } }),
    prisma.chronologyEvent.count({ where: { case: { firmId: firm.id } } }),
    prisma.condition.count({ where: { case: { firmId: firm.id } } }),
    prisma.futureCareItem.count({ where: { case: { firmId: firm.id } } }),
    prisma.validationFinding.count({ where: { firmId: firm.id } }),
    prisma.vocationalEntry.count({ where: { firmId: firm.id } }),
    prisma.economicAssumption.count({ where: { firmId: firm.id } }),
    prisma.economicScenario.count({ where: { firmId: firm.id } }),
    prisma.caseEngagement.count({ where: { firmId: firm.id } }),
    prisma.notification.count({ where: { firmId: firm.id } }),
    prisma.reportExport.count({ where: { firmId: firm.id } }),
    prisma.userRoleAssignment.count({ where: { firmId: firm.id } }),
    prisma.userCredential.count({ where: { firmId: firm.id } }),
  ]);

  const summary: DemoSeedSummary = {
    firmId: firm.id,
    users: firm.users.length,
    roleAssignments,
    credentials,
    cases: 8,
    documents,
    chronologyEvents,
    conditions,
    futureCareItems,
    validationFindings,
    vocationalEntries,
    economicAssumptions,
    economicScenarios,
    engagements,
    notifications,
    reportExports,
  };

  await prisma.auditLog.create({
    data: { firmId: firm.id, userId: firmAdmin.id, action: "demo.seed", meta: json({ ...summary }) },
  });

  return summary;
}

/**
 * Full demo reset: delete the demo firm's data (demo-guarded), reseed, and
 * write a "demo.reset" audit event under the recreated firm.
 */
export async function resetDemoFirm(actor?: { userId?: string; email?: string }): Promise<DemoSeedSummary> {
  const summary = await seedDemoFirm();
  // The actor's pre-reset user row was deleted with the old firm; attribute the
  // reset to the recreated persona when the email matches, else to firm.admin.
  const email = actor?.email ?? "firm.admin@demo.lifeplanos.com";
  const user = await prisma.user.findUnique({ where: { email } }).catch(() => null);
  await prisma.auditLog.create({
    data: {
      firmId: summary.firmId,
      userId: user && user.firmId === summary.firmId ? user.id : null,
      action: "demo.reset",
      meta: json({ requestedBy: actor?.email ?? "cli", cases: summary.cases, users: summary.users }),
    },
  });
  return summary;
}
