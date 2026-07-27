import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { getReport } from "@/lib/reports/registry";
import { approvalStale } from "@/lib/reports/persist";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Report-level approval & attestation (docs/23 Phase 2).
//
// Distinct from recommendation-level approval (FutureCareItem.physicianStatus)
// and from item-scope Attestation (EPIC-005): a ReportApproval binds an
// expert's signature to the EXACT exported bytes via contentSha256. A draft is
// never signable; an export without a content hash is never signable; a
// re-signing supersedes the prior signature of the same kind (recorded, never
// silently dropped). If the export's content later differs from the signed
// hash, the listing reports the signature STALE — it is disclosed, not hidden.
// ─────────────────────────────────────────────────────────────────────────────

const postSchema = z.object({
  kind: z.enum(["APPROVAL", "ATTESTATION"]),
  statementText: z.string().min(1),
  confirm: z.literal(true),
});

type Params = { params: { caseId: string; exportId: string } };

async function loadExport(caseId: string, exportId: string, firmId: string) {
  return prisma.reportExport.findFirst({ where: { id: exportId, caseId, firmId } });
}

export async function POST(req: Request, { params }: Params) {
  try {
    const ctx = await requireApiContext();
    await requireCase(ctx, params.caseId);
    const input = postSchema.parse(await req.json());

    const record = await loadExport(params.caseId, params.exportId, ctx.firm.id);
    if (!record) return ok({ error: "Export not found" }, 404);

    // The report definition names the expert whose signature finalizes it.
    const def = getReport(record.reportType ?? "");
    const expertRole = def?.requiredExpert ?? "physician";
    if (expertRole !== "physician") {
      return ok({ error: `This report requires the ${expertRole} expert workflow, which is not yet available.` }, 409);
    }
    requirePermission(ctx, "physician.review");

    if (record.draft) return ok({ error: "Draft exports cannot be approved or attested — only final exports carry a signature." }, 409);
    if (!record.contentSha256) {
      return ok({ error: "This export has no content hash to bind the signature to; regenerate it first." }, 409);
    }

    // A newer signature of the same kind supersedes any prior ACTIVE one —
    // recorded with its reason, never silently dropped.
    await prisma.reportApproval.updateMany({
      where: { reportExportId: record.id, kind: input.kind, status: "ACTIVE" },
      data: { status: "INVALIDATED", invalidReason: "superseded by newer signature" },
    });

    // Case revision at signing, when the export carries a snapshot (best-effort).
    let caseRevision: number | null = null;
    if (record.snapshotId) {
      const snap = await prisma.caseSnapshot.findFirst({ where: { id: record.snapshotId }, select: { version: true } }).catch(() => null);
      caseRevision = snap?.version ?? null;
    }

    const approval = await prisma.reportApproval.create({
      data: {
        firmId: ctx.firm.id,
        caseId: params.caseId,
        reportExportId: record.id,
        kind: input.kind,
        expertRole,
        reviewerId: ctx.user.id,
        reviewerName: ctx.user.name,
        credentials: ctx.user.credentialSummary ?? null,
        statementText: input.statementText,
        contentSha256: record.contentSha256,
        caseRevision,
        status: "ACTIVE",
      },
    });

    await audit(ctx, input.kind === "APPROVAL" ? "report.approve" : "report.attest", {
      type: "reportApproval",
      id: approval.id,
      caseId: params.caseId,
      meta: { reportExportId: record.id, reportType: record.reportType, kind: input.kind, contentSha256: record.contentSha256 },
    });
    return ok({ approval });
  } catch (err) {
    return handleError(err);
  }
}

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const record = await loadExport(params.caseId, params.exportId, ctx.firm.id);
    if (!record) return ok({ error: "Export not found" }, 404);
    const approvals = await prisma.reportApproval.findMany({
      where: { reportExportId: record.id },
      orderBy: { createdAt: "desc" },
    });
    // Staleness is computed, never stored stale-silently: a signature whose
    // hash no longer matches the export's content is flagged on read.
    return ok({ approvals: approvals.map((a) => ({ ...a, stale: approvalStale(a, record) })) });
  } catch (err) {
    return handleError(err);
  }
}
