import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { persistCaseValidation, validateCase } from "@/lib/engine/validation";
import { ok, handleError } from "@/lib/api";

// Life Care Plan integrity findings for the case — the persisted results of the
// deterministic validation layer (diagnosis mapping, coding/pricing, inclusion
// eligibility). GET returns the stored findings; POST recomputes and stores.

export async function GET(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const findings = await prisma.validationFinding.findMany({
      where: { caseId: params.caseId, firmId: ctx.firm.id },
      orderBy: { createdAt: "asc" },
    });
    // Counts are cheap to derive live so the header numbers are always current.
    const { counts, blocking } = await validateCase(params.caseId);
    return ok({ findings, blocking, counts });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const v = await persistCaseValidation(params.caseId, ctx.firm.id);
    await audit(ctx, "validation.run", { type: "case", id: params.caseId, caseId: params.caseId, meta: { findings: v.findings.length, blocking: v.blocking } });
    const findings = await prisma.validationFinding.findMany({ where: { caseId: params.caseId }, orderBy: { createdAt: "asc" } });
    return ok({ findings, blocking: v.blocking, counts: v.counts });
  } catch (err) {
    return handleError(err);
  }
}
