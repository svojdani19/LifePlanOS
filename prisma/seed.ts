import { PrismaClient } from "../src/generated/prisma";
import { hashPassword } from "../src/lib/auth/password";
import { SAMPLE_PRECEDENTS } from "../src/lib/precedents/samples";
import { SAMPLE_DOCS } from "../src/lib/documents/samples";
import { ingestDocument } from "../src/lib/documents/ingest";
import { generatePlan } from "../src/lib/engine/generate";

const prisma = new PrismaClient();

const DEMO_EMAIL = "demo@lifeplanos.app";
const DEMO_PASSWORD = "password123";

function period(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function main() {
  // Idempotent: wipe the demo firm if it already exists, then rebuild.
  const existing = await prisma.firm.findUnique({ where: { slug: "meridian-life-care" } });
  if (existing) {
    await prisma.firm.delete({ where: { id: existing.id } });
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const now = new Date();
  const inviteExpiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const firm = await prisma.firm.create({
    data: {
      name: "Meridian Life Care Planning",
      slug: "meridian-life-care",
      state: "CA",
      primaryColor: "#0891b2",
      letterhead: "Meridian Life Care Planning, LLC · Certified Life Care Planners · Los Angeles, CA",
      subscription: {
        create: {
          tier: "SMALL_FIRM",
          status: "ACTIVE",
          seats: 10,
          currentPeriodStart: now,
          currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        },
      },
      users: {
        create: [
          { email: DEMO_EMAIL, name: "Dr. Alex Rivera", role: "ADMIN", status: "ACTIVE", passwordHash },
          { email: "planner@lifeplanos.app", name: "Jordan Blake, RN CLCP", role: "PLANNER", status: "ACTIVE", passwordHash },
          { email: "physician@lifeplanos.app", name: "Dr. Sam Okafor, MD", role: "PHYSICIAN_REVIEWER", status: "ACTIVE", passwordHash },
          { email: "para@lifeplanos.app", name: "Casey Nguyen", role: "PARALEGAL", status: "ACTIVE", passwordHash },
          { email: "invited@lifeplanos.app", name: "Taylor Reed", role: "PLANNER", status: "INVITED", inviteToken: "demo-invite-token", inviteExpiresAt },
        ],
      },
    },
    include: { users: true },
  });

  const admin = firm.users.find((u) => u.email === DEMO_EMAIL)!;
  const planner = firm.users.find((u) => u.role === "PLANNER" && u.status === "ACTIVE")!;

  const seedCases = [
    { clientName: "Maria Gonzalez", caseType: "MED_MAL", side: "PLAINTIFF", status: "RECORDS", injurySpecialty: "ORTHOPEDIC_TRAUMA", dateOfBirth: new Date("1986-04-12"), jurisdiction: "CA — Los Angeles County", mechanism: "Delayed diagnosis of compartment syndrome", diagnosis: "Left lower extremity Volkmann's contracture", createdById: planner.id },
    { clientName: "David Chen", caseType: "PERSONAL_INJURY", side: "PLAINTIFF", status: "RECORDS", injurySpecialty: "SPINE", dateOfBirth: new Date("1979-09-30"), jurisdiction: "CA — Orange County", mechanism: "Motor vehicle collision", diagnosis: "L1 burst fracture with incomplete SCI", createdById: planner.id },
    { clientName: "Patricia Ellis", caseType: "WORKERS_COMP", side: "NEUTRAL", status: "RECORDS", injurySpecialty: "KNEE_ARTHROPLASTY", dateOfBirth: new Date("1972-01-18"), jurisdiction: "CA — WCAB", mechanism: "Fall from height", diagnosis: "Right total knee arthroplasty, post-traumatic arthritis", createdById: admin.id },
    { clientName: "Robert Ford", caseType: "PRODUCT_LIABILITY", side: "DEFENSE", status: "INTAKE", injurySpecialty: "AMPUTATION", dateOfBirth: new Date("1990-11-05"), jurisdiction: "NV — Clark County", mechanism: "Industrial machinery", diagnosis: "Transtibial amputation", createdById: admin.id },
    { clientName: "Angela White", caseType: "CATASTROPHIC", side: "PLAINTIFF", status: "RECORDS", injurySpecialty: "TBI", dateOfBirth: new Date("1995-06-22"), jurisdiction: "CA — San Diego County", mechanism: "Anoxic brain injury", diagnosis: "Severe TBI with spastic quadriparesis", createdById: planner.id },
  ] as const;

  let i = 0;
  let davidId: string | null = null;
  for (const c of seedCases) {
    i++;
    const created = await prisma.case.create({
      data: {
        firmId: firm.id,
        caseNumber: `LCP-2026-${String(i).padStart(4, "0")}`,
        ...c,
      },
    });
    if (c.clientName === "David Chen") davidId = created.id;
    await prisma.usageRecord.create({
      data: { firmId: firm.id, userId: c.createdById, metric: "CASE_CREATED", period: period(), caseId: created.id },
    });
    await prisma.auditLog.create({
      data: { firmId: firm.id, userId: c.createdById, action: "case.create", targetType: "case", targetId: created.id, caseId: created.id },
    });
  }

  // Fully populate the showcase case: ingest the sample record set (which also
  // extracts date/provider/location metadata) and run the deterministic AI
  // pipeline (chronology, causation, future care, cost projection, reviews).
  if (davidId) {
    for (const doc of SAMPLE_DOCS) {
      await ingestDocument({ caseId: davidId, firmId: firm.id, uploadedById: planner.id, filename: doc.filename, text: doc.text });
    }
    const plan = await generatePlan(davidId);
    await prisma.case.update({ where: { id: davidId }, data: { status: "PHYSICIAN_REVIEW" } });
    console.log(`  Populated David Chen: ${SAMPLE_DOCS.length} records, ${plan.futureCare} future-care items, ${plan.chronology} chronology events`);
  }

  // A little AI-generation usage so the dashboard shows a non-zero meter.
  await prisma.usageRecord.createMany({
    data: Array.from({ length: 37 }, () => ({
      firmId: firm.id,
      userId: planner.id,
      metric: "AI_GENERATION" as const,
      period: period(),
    })),
  });

  await prisma.auditLog.create({ data: { firmId: firm.id, userId: admin.id, action: "auth.login" } });

  // Firm LCP precedent library (drives the case "Precedents" likeness match).
  await prisma.precedentPlan.createMany({
    data: SAMPLE_PRECEDENTS.map((s) => ({
      firmId: firm.id, createdById: planner.id, source: "upload",
      title: s.title, clientRef: s.clientRef, diagnosis: s.diagnosis, icd10Code: s.icd10Code,
      injurySpecialty: s.injurySpecialty, jurisdiction: s.jurisdiction, mechanism: s.mechanism,
      age: s.age, sex: s.sex, lifeExpectancyYears: s.lifeExpectancyYears, lifetimeCost: s.lifetimeCost, presentValue: s.presentValue,
      careCategories: s.careCategories as unknown as object, outcome: s.outcome, filename: s.filename, extractedText: s.text,
    })),
  });

  console.log("✔ Seeded firm:", firm.name);
  console.log("  Login →", DEMO_EMAIL, "/", DEMO_PASSWORD);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
