import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit, recordUsage } from "@/lib/tenant";
import { buildReportDocx, buildCostCsv } from "@/lib/export/report";
import { persistCaseValidation } from "@/lib/engine/validation";
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
});

export async function POST(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "report.export");
    await requireCase(ctx, params.caseId);
    const { format, template } = schema.parse(await req.json());

    const priorCount = await prisma.reportExport.count({ where: { caseId: params.caseId } });

    let key: string;
    let totalLifetime = 0;
    let totalPresentValue = 0;
    let itemCount = 0;

    if (format === "DOCX") {
      const r = await buildReportDocx(params.caseId, template);
      key = await putObject(r.buffer, ".docx");
      totalLifetime = r.totalLifetime;
      totalPresentValue = r.totalPresentValue;
      itemCount = r.itemCount;
    } else {
      const csv = await buildCostCsv(params.caseId);
      key = await putObject(Buffer.from(csv, "utf8"), ".csv");
      const agg = await prisma.futureCareItem.aggregate({ where: { caseId: params.caseId }, _sum: { lifetimeCost: true, presentValue: true }, _count: true });
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
        version: priorCount + 1,
        storageKey: key,
        generatedById: ctx.user.id,
        totalLifetimeCost: totalLifetime,
        totalPresentValue,
        itemCount,
      },
    });

    // Advance the case toward FINAL once a report has been produced.
    await prisma.case.updateMany({
      where: { id: params.caseId, status: { in: ["FUTURE_CARE", "PRICING", "PHYSICIAN_REVIEW", "DRAFTING"] } },
      data: { status: "FINAL" },
    });

    await recordUsage(ctx, "REPORT_EXPORT", { caseId: params.caseId, meta: { format, template } });
    await audit(ctx, "export.report", { type: "reportExport", id: record.id, caseId: params.caseId, meta: { format, template, version: record.version } });

    // Refresh the persisted integrity findings to match what this export
    // reflected (the report ran the same deterministic check for its totals).
    await persistCaseValidation(params.caseId, ctx.firm.id).catch(() => {});

    return ok({ export: record });
  } catch (err) {
    return handleError(err);
  }
}
