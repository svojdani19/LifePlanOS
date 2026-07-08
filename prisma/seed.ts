import { PrismaClient } from "../src/generated/prisma";
import { hashPassword } from "../src/lib/auth/password";

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
  const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  const firm = await prisma.firm.create({
    data: {
      name: "Meridian Life Care Planning",
      slug: "meridian-life-care",
      state: "CA",
      primaryColor: "#0891b2",
      letterhead: "Meridian Life Care Planning, LLC · Certified Life Care Planners · Los Angeles, CA",
      subscription: {
        create: { tier: "SMALL_FIRM", status: "TRIALING", seats: 10, trialEndsAt },
      },
      users: {
        create: [
          { email: DEMO_EMAIL, name: "Dr. Alex Rivera", role: "ADMIN", status: "ACTIVE", passwordHash },
          { email: "planner@lifeplanos.app", name: "Jordan Blake, RN CLCP", role: "PLANNER", status: "ACTIVE", passwordHash },
          { email: "physician@lifeplanos.app", name: "Dr. Sam Okafor, MD", role: "PHYSICIAN_REVIEWER", status: "ACTIVE", passwordHash },
          { email: "para@lifeplanos.app", name: "Casey Nguyen", role: "PARALEGAL", status: "ACTIVE", passwordHash },
          { email: "invited@lifeplanos.app", name: "Taylor Reed", role: "PLANNER", status: "INVITED", inviteToken: "demo-invite-token", inviteExpiresAt: trialEndsAt },
        ],
      },
    },
    include: { users: true },
  });

  const admin = firm.users.find((u) => u.email === DEMO_EMAIL)!;
  const planner = firm.users.find((u) => u.role === "PLANNER" && u.status === "ACTIVE")!;

  const seedCases = [
    { clientName: "Maria Gonzalez", caseType: "MED_MAL", side: "PLAINTIFF", status: "FUTURE_CARE", jurisdiction: "CA — Los Angeles County", mechanism: "Delayed diagnosis of compartment syndrome", diagnosis: "Left lower extremity Volkmann's contracture", createdById: planner.id },
    { clientName: "David Chen", caseType: "PERSONAL_INJURY", side: "PLAINTIFF", status: "CHRONOLOGY", jurisdiction: "CA — Orange County", mechanism: "Motor vehicle collision", diagnosis: "L1 burst fracture with incomplete SCI", createdById: planner.id },
    { clientName: "Patricia Ellis", caseType: "WORKERS_COMP", side: "NEUTRAL", status: "PRICING", jurisdiction: "CA — WCAB", mechanism: "Fall from height", diagnosis: "Right total knee arthroplasty, post-traumatic arthritis", createdById: admin.id },
    { clientName: "Robert Ford", caseType: "PRODUCT_LIABILITY", side: "DEFENSE", status: "INTAKE", jurisdiction: "NV — Clark County", mechanism: "Industrial machinery", diagnosis: "Transtibial amputation", createdById: admin.id },
    { clientName: "Angela White", caseType: "CATASTROPHIC", side: "PLAINTIFF", status: "PHYSICIAN_REVIEW", jurisdiction: "CA — San Diego County", mechanism: "Anoxic brain injury", diagnosis: "Severe TBI with spastic quadriparesis", createdById: planner.id },
  ] as const;

  let i = 0;
  for (const c of seedCases) {
    i++;
    const created = await prisma.case.create({
      data: {
        firmId: firm.id,
        caseNumber: `LCP-2026-${String(i).padStart(4, "0")}`,
        ...c,
      },
    });
    await prisma.usageRecord.create({
      data: { firmId: firm.id, userId: c.createdById, metric: "CASE_CREATED", period: period(), caseId: created.id },
    });
    await prisma.auditLog.create({
      data: { firmId: firm.id, userId: c.createdById, action: "case.create", targetType: "case", targetId: created.id, caseId: created.id },
    });
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
