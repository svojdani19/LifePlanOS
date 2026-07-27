import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit, recordUsage } from "@/lib/tenant";
import { persistCaseValidation } from "@/lib/engine/validation";
import { REPORTS, getReport, gateReport, findingRelevance, type ReportDefinition } from "@/lib/reports/registry";
import { loadReportData } from "@/lib/reports/data";
import { renderDocx, renderHtml, renderCsv } from "@/lib/reports/doc";
import { convertDocxToPdf } from "@/lib/export/pdf";
import { putObject } from "@/lib/storage";
import { ok, handleError } from "@/lib/api";
import type { RDValidationFinding } from "@/lib/reports/sections";

// Report Library (docs/22): list, preview, and generate the non-legacy report
// types. The existing Life Care Plan and Testimony Pack keep their original
// routes (/export, /export/testimony) untouched — this route refuses them.

const postSchema = z.object({
  reportId: z.string(),
  format: z.enum(["DOCX", "PDF", "CSV", "HTML"]),
  config: z.unknown().optional(),
  mode: z.enum(["final", "draft"]).default("final"),
});

const EXT: Record<string, string> = { DOCX: ".docx", PDF: ".pdf", CSV: ".csv", HTML: ".html" };

async function persistedFindings(caseId: string): Promise<RDValidationFinding[]> {
  const rows = await prisma.validationFinding.findMany({ where: { caseId } });
  return rows.map((f) => ({ service: f.service, result: f.result, issue: f.issue, severity: f.severity, suggestion: f.suggestion, exportBlocking: f.exportBlocking }));
}

function effectiveApproval(def: ReportDefinition, config: unknown) {
  return def.deriveApproval ? def.deriveApproval(config) : def.approval;
}

export async function GET(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const url = new URL(req.url);
    const previewId = url.searchParams.get("preview");

    if (previewId) {
      // Preview renders full clinical content — same grant as export.
      requirePermission(ctx, "report.export");
      const def = getReport(previewId);
      if (!def || def.legacy) return ok({ error: "Unknown or legacy report type" }, 400);
      const rawConfig = url.searchParams.get("config");
      const config = def.configSchema.parse(rawConfig ? JSON.parse(rawConfig) : def.defaultConfig);
      const [data, findings] = await Promise.all([loadReportData(params.caseId), persistedFindings(params.caseId)]);
      const doc = def.compose(data, config, findings, { draft: true });
      await audit(ctx, "report.preview", { type: "case", id: params.caseId, caseId: params.caseId, meta: { reportType: def.id } });
      return ok({ html: renderHtml(doc) });
    }

    // Library listing with per-report readiness.
    const [findings, items, exports] = await Promise.all([
      prisma.validationFinding.findMany({ where: { caseId: params.caseId }, select: { exportBlocking: true } }),
      prisma.futureCareItem.findMany({ where: { caseId: params.caseId, supersededAt: null }, select: { physicianStatus: true, contingencyOnly: true } }),
      prisma.reportExport.findMany({ where: { caseId: params.caseId }, orderBy: { createdAt: "desc" } }),
    ]);
    const blocking = findings.filter((f) => f.exportBlocking).length;
    const decided = items.filter((i) => i.physicianStatus !== "PENDING").length;
    const pendingIncluded = items.filter((i) => i.physicianStatus === "PENDING" && !i.contingencyOnly).length;
    const lastByType = new Map<string, Date>();
    for (const e of exports) {
      const t = e.reportType ?? (e.format === "MEMO" ? "TESTIMONY_PACK" : "LIFE_CARE_PLAN");
      if (!lastByType.has(t)) lastByType.set(t, e.createdAt);
    }
    const reports = REPORTS.map((def) => {
      const approval = effectiveApproval(def, def.defaultConfig);
      const gate = gateReport({ ...def, approval }, { mode: "final", blocking: blocking > 0, decidedCount: decided, includedUndecided: pendingIncluded });
      const status = def.requiresDecided && decided === 0
        ? "Not enough information"
        : !gate.ok
          ? approval === "physician_required" && pendingIncluded > 0
            ? "Physician review required"
            : "Blocked"
          : lastByType.has(def.id)
            ? "Previously exported"
            : "Ready";
      return {
        id: def.id,
        name: def.name,
        description: def.description,
        category: def.category,
        legacy: !!def.legacy,
        approval,
        formats: def.formats,
        defaultConfig: def.defaultConfig,
        status,
        gateReason: gate.ok ? null : gate.reason,
        blockingCount: blocking,
        findingRelevance: findingRelevance(def.id),
        lastGenerated: lastByType.get(def.id) ?? null,
      };
    });
    return ok({ reports, decided, blocking });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "report.export");
    await requireCase(ctx, params.caseId);
    const input = postSchema.parse(await req.json());
    const def = getReport(input.reportId);
    if (!def) return ok({ error: "Unknown report type" }, 400);
    if (def.legacy) return ok({ error: "This report type uses its original endpoint (/export or /export/testimony)." }, 400);
    if (!def.formats.includes(input.format)) return ok({ error: `Format ${input.format} is not available for ${def.name}.` }, 400);
    const config = def.configSchema.parse(input.config ?? def.defaultConfig);

    // Same reason-first discipline as the legacy export: refresh validation,
    // then gate on the persisted truth. No report type bypasses blockers.
    const validation = await persistCaseValidation(params.caseId, ctx.firm.id);
    const data = await loadReportData(params.caseId);
    const items = data.case.futureCareItems;
    const includedIds = data.includedIds;
    const decidedCount = items.filter((i) => i.physicianStatus !== "PENDING").length;
    const includedUndecided = items.filter((i) => includedIds.has(i.id) && i.physicianStatus === "PENDING").length;
    const approval = effectiveApproval(def, config);
    const gate = gateReport({ ...def, approval }, { mode: input.mode, blocking: validation.blocking, decidedCount, includedUndecided });
    if (!gate.ok) {
      return ok({ error: gate.reason ?? "Export refused by the report gate.", blocking: validation.blocking, hint: "Resolve blocking findings or export as draft where permitted." }, 422);
    }

    const findings = await persistedFindings(params.caseId);
    const doc = def.compose(data, config, findings, { draft: input.mode === "draft" });
    let buffer: Buffer;
    if (input.format === "DOCX") buffer = await renderDocx(doc);
    else if (input.format === "PDF") buffer = await convertDocxToPdf(await renderDocx(doc));
    else if (input.format === "CSV") buffer = Buffer.from(renderCsv(doc), "utf8");
    else buffer = Buffer.from(renderHtml(doc), "utf8");

    const storageKey = await putObject(buffer, EXT[input.format]);
    // Per-type version series — legacy LCP/testimony counters stay untouched.
    const version = (await prisma.reportExport.count({ where: { caseId: params.caseId, reportType: def.id } })) + 1;
    const included = items.filter((i) => includedIds.has(i.id));
    const record = await prisma.reportExport.create({
      data: {
        caseId: params.caseId,
        firmId: ctx.firm.id,
        format: input.format,
        template: "NEUTRAL",
        draft: input.mode === "draft",
        version,
        storageKey,
        generatedById: ctx.user.id,
        reportType: def.id,
        config: config as never,
        itemCount: included.length,
        totalLifetimeCost: included.reduce((s, i) => s + (i.lifetimeCost ?? 0), 0),
        totalPresentValue: included.reduce((s, i) => s + (i.presentValue ?? 0), 0),
      },
    });
    await recordUsage(ctx, "REPORT_EXPORT", { meta: { format: input.format, reportType: def.id } });
    await audit(ctx, "export.report", { type: "reportExport", id: record.id, caseId: params.caseId, meta: { reportType: def.id, format: input.format, version, mode: input.mode } });
    return ok({ export: record });
  } catch (err) {
    return handleError(err);
  }
}
