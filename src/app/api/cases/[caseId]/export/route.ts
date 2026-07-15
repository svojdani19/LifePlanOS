import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit, recordUsage } from "@/lib/tenant";
import { buildReportDocx, buildCostCsv } from "@/lib/export/report";
import { persistCaseValidation } from "@/lib/engine/validation";
import { persistCaseReasoning } from "@/lib/engine/clinicalReasoningPersist";
import { buildSnapshotPayload } from "@/lib/engine/snapshot";
import { assumptionsFor } from "@/lib/engine/generate";
import { putObject } from "@/lib/storage";
import { ok, handleError } from "@/lib/api";

export async function GET(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const exports = await prisma.reportExport.findMany({ where: { caseId: params.caseId }, orderBy: { createdAt: "desc" } });
    return ok({ exports });
  } catch (err) {
    return handleError(err);
  }
}

const schema = z.object({
  format: z.enum(["DOCX", "CSV"]),
  template: z.enum(["PLAINTIFF", "DEFENSE", "NEUTRAL"]).default("PLAINTIFF"),
  // CRE v1 §18 — FINAL export is blocked while any totaled recommendation
  // carries an unresolved export-blocking finding; DRAFT is always available
  // with a visible watermark and an unresolved-issues appendix.
  mode: z.enum(["final", "draft"]).default("final"),
});

export async function POST(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "report.export");
    await requireCase(ctx, params.caseId);
    const { format, template, mode } = schema.parse(await req.json());

    // Reason first, write second: assessments and validation findings are
    // recomputed and PERSISTED before any narrative is generated, and the
    // final-export gate is evaluated against those persisted results.
    const [, validation] = await Promise.all([
      persistCaseReasoning(params.caseId, ctx.firm.id, { actorUserId: ctx.user.id }).catch(() => null),
      persistCaseValidation(params.caseId, ctx.firm.id),
    ]);
    if (format === "DOCX" && mode === "final" && validation.blocking) {
      const defects = validation.findings.filter((f) => f.exportBlocking).slice(0, 10);
      return ok(
        {
          error: "Final export blocked by unresolved critical findings.",
          blocking: true,
          defects: defects.map((f) => ({ service: f.service, result: f.result, issue: f.issue, suggestion: f.suggestion })),
          hint: 'Resolve the findings, or export a draft (mode: "draft") with the DRAFT watermark and unresolved-issues appendix.',
        },
        422,
      );
    }

    const priorCount = await prisma.reportExport.count({ where: { caseId: params.caseId } });

    let key: string;
    let totalLifetime = 0;
    let totalPresentValue = 0;
    let itemCount = 0;

    if (format === "DOCX") {
      const r = await buildReportDocx(params.caseId, template, { draft: mode === "draft" });
      key = await putObject(r.buffer, ".docx");
      totalLifetime = r.totalLifetime;
      totalPresentValue = r.totalPresentValue;
      itemCount = r.itemCount;
    } else {
      const csv = await buildCostCsv(params.caseId);
      key = await putObject(Buffer.from(csv, "utf8"), ".csv");
      const agg = await prisma.futureCareItem.aggregate({ where: { caseId: params.caseId, supersededAt: null }, _sum: { lifetimeCost: true, presentValue: true }, _count: true });
      totalLifetime = Math.round(agg._sum.lifetimeCost ?? 0);
      totalPresentValue = Math.round(agg._sum.presentValue ?? 0);
      itemCount = agg._count;
    }

    const record = await prisma.reportExport.create({
      data: {
        caseId: params.caseId,
        firmId: ctx.firm.id,
        format,
        template,
        draft: mode === "draft",
        version: priorCount + 1,
        storageKey: key,
        generatedById: ctx.user.id,
        totalLifetimeCost: totalLifetime,
        totalPresentValue,
        itemCount,
      },
    });

    // Advance the case toward FINAL once a FINAL report has been produced.
    // A draft export leaves the case status untouched (§18).
    if (mode === "final") {
      await prisma.case.updateMany({
        where: { id: params.caseId, status: { in: ["FUTURE_CARE", "PRICING", "PHYSICIAN_REVIEW", "DRAFTING"] } },
        data: { status: "FINAL" },
      });
    }

    await recordUsage(ctx, "REPORT_EXPORT", { caseId: params.caseId, meta: { format, template } });
    await audit(ctx, "export.report", { type: "reportExport", id: record.id, caseId: params.caseId, meta: { format, template, version: record.version } });

    // Refresh the persisted integrity findings to match what this export
    // reflected (the report ran the same deterministic check for its totals).
    await persistCaseValidation(params.caseId, ctx.firm.id).catch(() => {});

    // P3 — capture a point-in-time digest so any two report versions can be
    // compared (records, chronology, diagnoses, items, review status, totals,
    // assumptions). Best-effort; never blocks the export.
    try {
      const full = await prisma.case.findUniqueOrThrow({
        where: { id: params.caseId },
        include: {
          documents: { select: { id: true, filename: true, type: true } },
          chronologyEvents: { select: { eventDate: true, provider: true, summary: true } },
          conditions: { select: { name: true, relatedness: true } },
          futureCareItems: { where: { supersededAt: null } },
        },
      });
      const a = assumptionsFor(full);
      const payload = buildSnapshotPayload(full as never, a, { lifetime: totalLifetime, presentValue: totalPresentValue });
      await prisma.caseSnapshot.create({
        data: { caseId: params.caseId, firmId: ctx.firm.id, version: record.version, reportExportId: record.id, payload: payload as never, createdById: ctx.user.id },
      });
    } catch {
      /* snapshot is best-effort */
    }

    return ok({ export: record });
  } catch (err) {
    return handleError(err);
  }
}
