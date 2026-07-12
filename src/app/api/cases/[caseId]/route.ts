import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { recomputeCosts } from "@/lib/engine/generate";
import { ok, handleError } from "@/lib/api";

const patchSchema = z.object({
  clientName: z.string().min(1).optional(),
  dateOfBirth: z.string().nullable().optional(),
  sex: z.enum(["MALE", "FEMALE", "OTHER", "UNKNOWN"]).optional(),
  caseType: z.enum(["PERSONAL_INJURY", "MED_MAL", "WORKERS_COMP", "PRODUCT_LIABILITY", "CATASTROPHIC"]).optional(),
  side: z.enum(["PLAINTIFF", "DEFENSE", "NEUTRAL"]).optional(),
  jurisdiction: z.string().nullable().optional(),
  dateOfInjury: z.string().nullable().optional(),
  mechanism: z.string().nullable().optional(),
  diagnosis: z.string().nullable().optional(),
  icd10Code: z.string().max(12).nullable().optional(),
  additionalDiagnoses: z.array(z.object({ diagnosis: z.string(), icd10Code: z.string() })).optional(),
  injurySpecialty: z
    .enum(["GENERAL", "ORTHOPEDIC_TRAUMA", "HIP_ARTHROPLASTY", "KNEE_ARTHROPLASTY", "SPINE", "AMPUTATION", "TBI", "SPINAL_CORD_INJURY", "CHRONIC_PAIN", "CRPS", "BURNS", "BIRTH_INJURY", "NEUROLOGIC", "PSYCHIATRIC", "POLYTRAUMA"])
    .optional(),
  preExistingConditions: z.string().nullable().optional(),
  preExistingReviewed: z.boolean().optional(),
  specialty: z.string().nullable().optional(),
  additionalSpecialties: z.array(z.string()).optional(),
  currentWorkStatus: z.string().nullable().optional(),
  disabilityReason: z.string().nullable().optional(),
  functionalLimitations: z.string().nullable().optional(),
  status: z.enum(["INTAKE", "RECORDS", "CHRONOLOGY", "CAUSATION", "FUTURE_CARE", "PRICING", "DRAFTING", "PHYSICIAN_REVIEW", "FINAL", "CLOSED", "ARCHIVED"]).optional(),
  // Economic assumptions.
  lifeExpectancyYears: z.number().positive().nullable().optional(),
  discountRate: z.number().min(0).max(0.2).optional(),
  medicalInflation: z.number().min(0).max(0.2).optional(),
  geographicFactor: z.number().min(0.1).max(3).optional(),
  assumptionReason: z.string().max(400).optional(),
  preparingPhysicianId: z.string().nullable().optional(),
});

const ASSUMPTION_KEYS = ["lifeExpectancyYears", "discountRate", "medicalInflation", "geographicFactor"] as const;

export async function PATCH(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.edit");
    const prior = await requireCase(ctx, params.caseId);
    const input = patchSchema.parse(await req.json());

    const { assumptionReason: _reason, ...rest } = input;
    if (rest.preparingPhysicianId) {
      const member = await prisma.user.findFirst({ where: { id: rest.preparingPhysicianId, firmId: ctx.firm.id } });
      if (!member) return ok({ error: "Preparing physician must be a member of your firm." }, 400);
    }
    const data: Record<string, unknown> = { ...rest };
    if (input.dateOfBirth !== undefined) data.dateOfBirth = input.dateOfBirth ? new Date(input.dateOfBirth) : null;
    if (input.dateOfInjury !== undefined) data.dateOfInjury = input.dateOfInjury ? new Date(input.dateOfInjury) : null;

    const updated = await prisma.case.update({ where: { id: params.caseId }, data });

    // If an economic assumption changed, recompute all cost projections and
    // ledger the change (P3): original vs revised, who, when, why — so every
    // report version's numbers stay explainable.
    let totals: { totalLifetime: number; totalPresentValue: number } | undefined;
    const changedAssumptions = ASSUMPTION_KEYS.filter((k) => k in input && (input as Record<string, unknown>)[k] !== undefined && (input as Record<string, unknown>)[k] !== (prior as Record<string, unknown>)[k]);
    if (changedAssumptions.length) {
      await prisma.assumptionChange.createMany({
        data: changedAssumptions.map((k) => ({
          caseId: params.caseId,
          firmId: ctx.firm.id,
          field: k,
          originalValue: (prior as Record<string, unknown>)[k] as number | null,
          revisedValue: (input as Record<string, unknown>)[k] as number | null,
          reason: (input as { assumptionReason?: string }).assumptionReason ?? null,
          userId: ctx.user.id,
        })),
      });
      totals = await recomputeCosts(params.caseId);
    } else if (ASSUMPTION_KEYS.some((k) => k in input)) {
      totals = await recomputeCosts(params.caseId);
    }

    await audit(ctx, "case.update", { type: "case", id: params.caseId, caseId: params.caseId, meta: Object.keys(input) });
    return ok({ case: updated, totals });
  } catch (err) {
    return handleError(err);
  }
}
