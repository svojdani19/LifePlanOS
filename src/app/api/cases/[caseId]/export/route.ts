import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit, recordUsage } from "@/lib/tenant";
import { buildReportDocx, buildCostCsv } from "@/lib/export/report";
import { convertDocxToPdf } from "@/lib/export/pdf";
import { persistCaseValidation, openBlockingCount } from "@/lib/engine/validation";
import { persistCaseReasoning } from "@/lib/engine/clinicalReasoningPersist";
import { buildSnapshotPayload } from "@/lib/engine/snapshot";
import { assumptionsFor } from "@/lib/engine/generate";
import { putObject } from "@/lib/storage";
import { evaluatePhysicianReportAuthority } from "@/lib/reports/professionalAuthority";
import { ok, handleError } from "@/lib/api";

export async function GET(_req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
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
  // PDF is the canonical DOCX converted through LibreOffice (ATD-7) — same
  // content, same gates; a missing converter fails loudly, never re-typesets.
  format: z.enum(["DOCX", "PDF", "CSV"]),
  template: z.enum(["PLAINTIFF", "DEFENSE", "NEUTRAL"]).default("PLAINTIFF"),
  // CRE v1 §18 — FINAL export is blocked while any totaled recommendation
  // carries an unresolved export-blocking finding; DRAFT is always available
  // with a visible watermark and an unresolved-issues appendix.
  mode: z.enum(["final", "draft"]).default("final"),
});

export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
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
    // The gate honors reviewer dispositions: a finding a clinician explicitly
    // resolved-as-is or ignored (persisted, attributed, and survived the
    // re-run above) no longer blocks — only OPEN blocking findings gate the
    // final. The raw engine flag would re-block dispositioned findings forever.
    const stillOpenBlocking = validation.blocking ? await openBlockingCount(params.caseId) : 0;
    if ((format === "DOCX" || format === "PDF") && mode === "final" && stillOpenBlocking > 0) {
      const openRows = await prisma.validationFinding.findMany({
        where: { caseId: params.caseId, exportBlocking: true, status: "OPEN" },
        take: 10,
        select: { service: true, result: true },
      });
      const openKeys = new Set(openRows.map((r) => `${r.service}::${r.result}`));
      const defects = validation.findings.filter((f) => f.exportBlocking && openKeys.has(`${f.service}::${f.result}`)).slice(0, 10);
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

    // ── CSV is a SUPPORTING export only ──────────────────────────────────────
    // CSV never provides a path around clinical validation, professional
    // review, totals inclusion, or case finalization: a final-mode CSV is
    // rejected outright (never silently reinterpreted), a CSV export never
    // advances the case, and its stored totals cover only the deterministic
    // included set with every row carrying disclosure columns.
    if (format === "CSV" && mode === "final") {
      return ok(
        {
          error: "CSV is a supporting worksheet, not a final release format.",
          reasons: ["CSV_FINAL_NOT_OFFERED"],
          hint: 'Request the final DOCX/PDF expert report, or export the CSV as a supporting worksheet (mode: "draft").',
        },
        422,
      );
    }

    // ── Professional-authority gate (final expert release) ───────────────────
    // A FINAL DOCX/PDF is an expert report: first-person medical opinions and
    // a signature block. It may only be released under a current, verified
    // professional attestation covering every recommendation in the totals.
    // The decision is server-side and fail-closed; a denial creates no file,
    // no artifact record, and no case-status change, and is audited with
    // structural, PHI-free metadata only.
    let preAuthority: Awaited<ReturnType<typeof evaluatePhysicianReportAuthority>> | null = null;
    if ((format === "DOCX" || format === "PDF") && mode === "final") {
      preAuthority = await evaluatePhysicianReportAuthority({ firmId: ctx.firm.id, caseId: params.caseId });
      if (!preAuthority.authorized) {
        await audit(ctx, "export.final_denied", {
          type: "case",
          id: params.caseId,
          caseId: params.caseId,
          meta: { format, template, reasons: preAuthority.reasons },
        });
        return ok(
          {
            error: "Final expert release requires current professional approval.",
            reasons: preAuthority.reasons,
            hint: 'A draft export (mode: "draft") remains available; it carries neutral language, a DRAFT watermark, and no signature block.',
          },
          422,
        );
      }
    }

    const priorCount = await prisma.reportExport.count({ where: { caseId: params.caseId } });

    let key: string;
    let totalLifetime = 0;
    let totalPresentValue = 0;
    let itemCount = 0;

    if (format === "DOCX" || format === "PDF") {
      // The renderer receives the EXACT route-verified authority snapshot — it
      // never independently selects a different attestation.
      const r = await buildReportDocx(params.caseId, template, {
        draft: mode === "draft",
        authority: mode === "final" ? (preAuthority?.authorized ? preAuthority : null) : undefined,
      });
      if (mode === "final" && preAuthority?.authorized) {
        // Time-of-check/time-of-use: the authorized snapshot must be identical
        // at the moment the artifact is recorded — same attestation, same
        // clinical/financial/report fingerprints, same included ids and count,
        // and the builder's totals must equal the verified totals under the
        // single rounding policy (Math.round at the edge). Any drift during
        // generation fails safely — regenerate and, if the plan materially
        // changed, re-attest.
        const recheck = await evaluatePhysicianReportAuthority({ firmId: ctx.firm.id, caseId: params.caseId });
        const sameIds =
          recheck.authorized &&
          recheck.includedItemIds.length === preAuthority.includedItemIds.length &&
          recheck.includedItemIds.every((id, i) => id === preAuthority!.includedItemIds[i]);
        const stable =
          recheck.authorized &&
          sameIds &&
          recheck.includedFingerprint === preAuthority.includedFingerprint &&
          recheck.clinicalFingerprint === preAuthority.clinicalFingerprint &&
          recheck.financialFingerprint === preAuthority.financialFingerprint &&
          recheck.reportFingerprint === preAuthority.reportFingerprint &&
          recheck.attestationId === preAuthority.attestationId &&
          recheck.includedCount === preAuthority.includedCount &&
          recheck.includedPresentValue === preAuthority.includedPresentValue &&
          recheck.includedLifetimeCost === preAuthority.includedLifetimeCost &&
          r.itemCount === recheck.includedCount &&
          Math.round(r.totalPresentValue) === recheck.includedPresentValue &&
          Math.round(r.totalLifetime) === recheck.includedLifetimeCost;
        if (!stable) {
          await audit(ctx, "export.final_denied", {
            type: "case",
            id: params.caseId,
            caseId: params.caseId,
            meta: { format, template, reasons: ["PLAN_CHANGED_DURING_GENERATION"] },
          });
          return ok(
            {
              error: "The plan changed while the report was being generated. Regenerate the report; if recommendations changed materially, the physician must re-attest.",
              reasons: ["PLAN_CHANGED_DURING_GENERATION"],
            },
            409,
          );
        }
      }
      key = format === "PDF" ? await putObject(await convertDocxToPdf(r.buffer), ".pdf") : await putObject(r.buffer, ".docx");
      totalLifetime = r.totalLifetime;
      totalPresentValue = r.totalPresentValue;
      itemCount = r.itemCount;
    } else {
      const worksheet = await buildCostCsv(params.caseId);
      key = await putObject(Buffer.from(worksheet.csv, "utf8"), ".csv");
      // Stored totals and count come from the actual exported INCLUDED set —
      // never an aggregate over every active item.
      totalLifetime = worksheet.totalLifetime;
      totalPresentValue = worksheet.totalPresentValue;
      itemCount = worksheet.itemCount;
    }

    const record = await prisma.reportExport.create({
      data: {
        caseId: params.caseId,
        firmId: ctx.firm.id,
        format,
        template,
        // A CSV is always a supporting/draft artifact — never a final release.
        draft: mode === "draft" || format === "CSV",
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
    if (mode === "final" && (format === "DOCX" || format === "PDF")) {
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
