import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit, recordUsage } from "@/lib/tenant";
import { buildTestimonyPackDocx } from "@/lib/export/testimonyPack";
import { persistCaseReasoning } from "@/lib/engine/clinicalReasoningPersist";
import { putObject } from "@/lib/storage";
import { ok, handleError } from "@/lib/api";

// Testimony Preparation Pack — a DOCX projection of the persisted assessments
// (self-critique, weakening evidence, unknowns, sufficiency) and the defense-
// vulnerability review into deposition-prep material. Versioned in the export
// history as a MEMO so it is never confused with the Life Care Plan itself.
export async function POST(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "report.export");
    await requireCase(ctx, params.caseId);

    // The pack projects persisted reasoning — refresh it first so the prep
    // material reflects the current plan, not a stale assessment.
    await persistCaseReasoning(params.caseId, ctx.firm.id, { actorUserId: ctx.user.id }).catch(() => null);

    const pack = await buildTestimonyPackDocx(params.caseId);
    const key = await putObject(pack.buffer, ".docx");
    const priorCount = await prisma.reportExport.count({ where: { caseId: params.caseId, format: "MEMO" } });
    const record = await prisma.reportExport.create({
      data: {
        caseId: params.caseId,
        firmId: ctx.firm.id,
        format: "MEMO",
        template: "NEUTRAL",
        version: priorCount + 1,
        storageKey: key,
        generatedById: ctx.user.id,
        itemCount: pack.entryCount,
      },
    });

    await recordUsage(ctx, "REPORT_EXPORT", { caseId: params.caseId, meta: { format: "MEMO", kind: "testimony_pack" } });
    await audit(ctx, "export.testimony_pack", {
      type: "reportExport",
      id: record.id,
      caseId: params.caseId,
      meta: { entries: pack.entryCount, crossLines: pack.crossLineCount, version: record.version },
    });
    return ok({ export: record, crossLines: pack.crossLineCount });
  } catch (err) {
    return handleError(err);
  }
}
