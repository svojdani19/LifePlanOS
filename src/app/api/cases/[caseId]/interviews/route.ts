import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCanonicalPermission, requireCase, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";

// Interview findings (EPIC-011) — patient or treating-provider, categorized or
// free-text, optionally linked to a diagnosis/recommendation. User-authored;
// never fabricated. Physician reviewers may add provider findings.
export async function GET(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const subject = new URL(req.url).searchParams.get("subject");
    const findings = await prisma.interviewFinding.findMany({
      where: { caseId: params.caseId, firmId: ctx.firm.id, ...(subject === "PATIENT" || subject === "PROVIDER" ? { subject } : {}) },
      orderBy: { createdAt: "asc" },
    });
    return ok({ findings });
  } catch (err) {
    return handleError(err);
  }
}

const schema = z.object({
  subject: z.enum(["PATIENT", "PROVIDER"]),
  providerId: z.string().optional(),
  category: z.string().max(60).optional(),
  text: z.string().min(1),
  quote: z.string().optional(),
  interviewDate: z.string().optional(),
  conditionId: z.string().optional(),
  futureCareItemId: z.string().optional(),
});
export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    // Planners/paralegals capture; physician reviewers may add provider
    // opinions. A reviewer whose physician grant is case-scoped (assignment or
    // engagement) is authorized through the resource-aware canonical check —
    // the same evaluator the review routes use, so recording a finding and
    // deciding a recommendation share one authorization boundary.
    const canCapture = (() => { try { requirePermission(ctx, "case.edit"); return true; } catch { return false; } })();
    if (!canCapture) {
      try {
        requirePermission(ctx, "physician.review");
      } catch {
        requireCanonicalPermission(ctx, "physician.review", { caseId: params.caseId });
      }
    }
    await requireCase(ctx, params.caseId);
    const input = schema.parse(await req.json());
    const finding = await prisma.interviewFinding.create({
      data: {
        caseId: params.caseId, firmId: ctx.firm.id,
        subject: input.subject, providerId: input.providerId,
        category: input.category, text: input.text, quote: input.quote,
        interviewDate: input.interviewDate ? new Date(input.interviewDate) : undefined,
        interviewedById: ctx.user.id, conditionId: input.conditionId, futureCareItemId: input.futureCareItemId,
        createdById: ctx.user.id,
      },
    });
    await audit(ctx, "interview.add", { type: "interviewFinding", id: finding.id, caseId: params.caseId, meta: { subject: input.subject } });
    return ok({ finding });
  } catch (err) {
    return handleError(err);
  }
}
