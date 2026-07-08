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
});

const ASSUMPTION_KEYS = ["lifeExpectancyYears", "discountRate", "medicalInflation", "geographicFactor"] as const;

export async function PATCH(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.edit");
    await requireCase(ctx, params.caseId);
    const input = patchSchema.parse(await req.json());

    const data: Record<string, unknown> = { ...input };
    if (input.dateOfBirth !== undefined) data.dateOfBirth = input.dateOfBirth ? new Date(input.dateOfBirth) : null;
    if (input.dateOfInjury !== undefined) data.dateOfInjury = input.dateOfInjury ? new Date(input.dateOfInjury) : null;

    const updated = await prisma.case.update({ where: { id: params.caseId }, data });

    // If an economic assumption changed, recompute all cost projections.
    let totals: { totalLifetime: number; totalPresentValue: number } | undefined;
    if (ASSUMPTION_KEYS.some((k) => k in input)) {
      totals = await recomputeCosts(params.caseId);
    }

    await audit(ctx, "case.update", { type: "case", id: params.caseId, caseId: params.caseId, meta: Object.keys(input) });
    return ok({ case: updated, totals });
  } catch (err) {
    return handleError(err);
  }
}
