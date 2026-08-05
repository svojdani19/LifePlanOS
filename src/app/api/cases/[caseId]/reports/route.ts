import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit, recordUsage } from "@/lib/tenant";
import { persistCaseValidation } from "@/lib/engine/validation";
import { buildSnapshotPayload } from "@/lib/engine/snapshot";
import { assumptionsFor } from "@/lib/engine/generate";
import { REPORTS, getReport, gateReport, findingRelevance, REPORT_TEMPLATE_VERSION, type ReportDefinition } from "@/lib/reports/registry";
import {
  evaluateProfessionalReportAuthority,
  DEFAULT_PHYSICIAN_SCOPES,
  type OpinionScope,
  type VerifiedExpertAuthority,
} from "@/lib/reports/professionalAuthority";
import { loadReportData } from "@/lib/reports/data";
import { storeAndRecord, approvalStale, ExportRecordError } from "@/lib/reports/persist";
import { renderDocx, renderHtml, renderCsv } from "@/lib/reports/doc";
import { convertDocxToPdf } from "@/lib/export/pdf";
import { ok, handleError } from "@/lib/api";
import { reportEnabled } from "@/lib/flags";
import { composeVocational, vocationalReadiness, type VocEntry } from "@/lib/reports/vocational";
import { factualReviewState } from "@/lib/records/structuredRecord";
import { composeEconomist, economistReadiness, computeScenarioStaleness, type AssumptionRow, type ScenarioRow } from "@/lib/reports/economist";
import { changesSection, isMaterialDiff } from "@/lib/reports/versionDiff";
import { diffSnapshots, type SnapshotPayload } from "@/lib/engine/snapshot";
import type { RDValidationFinding } from "@/lib/reports/sections";
import type { Case, ReportExport } from "@/generated/prisma";

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

// PHI-bearing responses: never cached, never sniffed, never leak a referrer.
const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
} as const;

async function persistedFindings(caseId: string): Promise<RDValidationFinding[]> {
  // Dispositioned findings (resolved-as-is / ignored) no longer gate or appear
  // in generated documents' unresolved lists.
  const rows = await prisma.validationFinding.findMany({ where: { caseId, status: "OPEN" } });
  return rows.map((f) => ({ service: f.service, result: f.result, issue: f.issue, severity: f.severity, suggestion: f.suggestion, exportBlocking: f.exportBlocking }));
}

// The snapshot captured with the most recent snapshot-bearing export of this
// report type (finals only carry snapshots). Legacy LCP rows have null
// reportType — treated as LIFE_CARE_PLAN for comparison purposes.
async function priorSnapshotFor(caseId: string, reportType: string) {
  const exports_ = await prisma.reportExport.findMany({
    where: {
      caseId,
      snapshotId: { not: null },
      ...(reportType === "LIFE_CARE_PLAN" ? { OR: [{ reportType: "LIFE_CARE_PLAN" }, { reportType: null, format: { in: ["DOCX", "PDF"] } }] } : { reportType }),
    },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  const prior = exports_[0];
  if (!prior?.snapshotId) {
    // Legacy exports link snapshots by reportExportId instead.
    const legacySnap = await prisma.caseSnapshot.findFirst({
      where: { caseId, reportExportId: { not: null } },
      orderBy: { createdAt: "desc" },
    });
    if (!legacySnap) return null;
    const exp = await prisma.reportExport.findUnique({ where: { id: legacySnap.reportExportId! } });
    return { payload: legacySnap.payload as unknown as SnapshotPayload, version: exp?.version ?? 0, draft: exp?.draft ?? false, createdAt: legacySnap.createdAt };
  }
  const snap = await prisma.caseSnapshot.findUnique({ where: { id: prior.snapshotId } });
  if (!snap) return null;
  return { payload: snap.payload as unknown as SnapshotPayload, version: prior.version, draft: prior.draft, createdAt: prior.createdAt };
}

async function vocationalState(caseId: string) {
  const [entries, approval] = await Promise.all([
    prisma.vocationalEntry.findMany({ where: { caseId, supersededById: null }, orderBy: { createdAt: "asc" } }),
    prisma.reportApproval.findFirst({ where: { caseId, expertRole: "vocational", kind: "APPROVAL", status: "ACTIVE" }, orderBy: { createdAt: "desc" } }),
  ]);
  const readiness = vocationalReadiness(entries as unknown as VocEntry[], { approved: !!approval });
  return { entries: entries as unknown as VocEntry[], approved: !!approval, readiness };
}

async function economistState(caseId: string) {
  const [assumptions, scenarios, approval, medicalExport] = await Promise.all([
    prisma.economicAssumption.findMany({ where: { caseId, supersededById: null }, orderBy: { createdAt: "asc" } }),
    // Current (non-superseded) scenario runs only — history stays recoverable
    // but never composes into a report.
    prisma.economicScenario.findMany({ where: { caseId, supersededById: null }, orderBy: { createdAt: "asc" } }),
    prisma.reportApproval.findFirst({ where: { caseId, expertRole: "economist", kind: "APPROVAL", status: "ACTIVE" }, orderBy: { createdAt: "desc" } }),
    // The export currently eligible to supply the medical component — must
    // match the criteria the economics API uses when computing.
    prisma.reportExport.findFirst({
      where: { caseId, draft: false, supersededById: null, contentSha256: { not: null }, reportType: { in: ["LIFE_CARE_PLAN", "MEDICAL_COST_PROJECTION"] } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  // Fail-closed currency: a stored result whose input hash no longer matches
  // the current assumptions (or whose medical-cost source export is no longer
  // the eligible one) is STALE — it can never make the case final-ready, and
  // an ACTIVE approval over a stale substrate does not approve current work.
  const rows = scenarios as unknown as ScenarioRow[];
  const staleness = computeScenarioStaleness(
    assumptions as unknown as AssumptionRow[],
    rows,
    medicalExport ? { exportId: medicalExport.id, presentValue: medicalExport.totalPresentValue } : null,
  );
  const baseStale = staleness.get("base") === true;
  const approvedCurrent = !!approval && !baseStale;
  // The economist's approval statement doubles as the entered conclusion text —
  // conclusions never exist without the responsible expert's signature.
  const readiness = economistReadiness(assumptions as unknown as AssumptionRow[], rows, approvedCurrent, approvedCurrent, { baseStale });
  return { assumptions: assumptions as unknown as AssumptionRow[], scenarios: rows, approval: approvedCurrent ? approval : null, readiness };
}

// Opinion scopes each physician-required report renders. A causation report
// requires an attestation that EXPLICITLY covers causation conclusions — a
// future-care attestation never doubles as a causation opinion.
const REPORT_REQUIRED_SCOPES: Record<string, OpinionScope[]> = {
  MEDICAL_NECESSITY: DEFAULT_PHYSICIAN_SCOPES,
  DEFENSE_REBUTTAL: DEFAULT_PHYSICIAN_SCOPES,
  PHYSICIAN_REVIEW_REPORT: DEFAULT_PHYSICIAN_SCOPES,
  CAUSATION_ANALYSIS: [...DEFAULT_PHYSICIAN_SCOPES, "CAUSATION"],
};

function effectiveApproval(def: ReportDefinition, config: unknown) {
  return def.deriveApproval ? def.deriveApproval(config) : def.approval;
}

export async function GET(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const url = new URL(req.url);
    const previewId = url.searchParams.get("preview");
    const changesId = url.searchParams.get("changes");

    if (changesId) {
      const def = getReport(changesId);
      if (!def) return ok({ error: "Unknown report type" }, 400);
      const prior = await priorSnapshotFor(params.caseId, def.id);
      if (!prior) return ok({ changes: null });
      const data = await loadReportData(params.caseId);
      const included = data.case.futureCareItems.filter((i) => data.includedIds.has(i.id));
      const current = buildSnapshotPayload(
        data.case as never,
        assumptionsFor(data.case as unknown as Case),
        {
          lifetime: included.reduce((sum, i) => sum + (i.lifetimeCost ?? 0), 0),
          presentValue: included.reduce((sum, i) => sum + (i.presentValue ?? 0), 0),
        },
      );
      const diff = diffSnapshots(prior.payload, current);
      return ok({ changes: { diff, material: isMaterialDiff(diff), prior: { version: prior.version, draft: prior.draft, createdAt: prior.createdAt } } });
    }

    if (previewId) {
      // Preview renders full clinical content — same grant as export.
      requirePermission(ctx, "report.export");
      const def = getReport(previewId);
      if (!def || def.legacy) return ok({ error: "Unknown or legacy report type" }, 400);
      if (!reportEnabled(ctx.firm.features, def.id)) return ok({ error: `${def.name} is not enabled for this firm.` }, 403);
      if (def.requiredExpert && def.formats.length === 0) return ok({ error: `${def.name} requires the ${def.requiredExpert} expert workflow (not yet available).` }, 409);
      const rawConfig = url.searchParams.get("config");
      const config = def.configSchema.parse(rawConfig ? JSON.parse(rawConfig) : def.defaultConfig);
      const [data, findings, vAgg] = await Promise.all([
        loadReportData(params.caseId),
        persistedFindings(params.caseId),
        prisma.validationFinding.aggregate({ where: { caseId: params.caseId }, _max: { createdAt: true } }),
      ]);
      let doc;
      if (def.id === "VOCATIONAL_ASSESSMENT") {
        const voc = await vocationalState(params.caseId);
        doc = composeVocational(`${data.case.clientName} · File ${data.case.caseNumber}`, voc.entries, { draft: true, expertApproved: voc.approved });
      } else if (def.id === "FORENSIC_ECONOMIST_REPORT") {
        const econ = await economistState(params.caseId);
        doc = composeEconomist(`${data.case.clientName} · File ${data.case.caseNumber}`, econ.assumptions, econ.scenarios, { draft: true, expertApproved: !!econ.approval, conclusionText: econ.approval?.statementText });
      } else {
        doc = def.compose(data, config, findings, { draft: true });
      }
      await audit(ctx, "report.preview", { type: "case", id: params.caseId, caseId: params.caseId, meta: { reportType: def.id } });
      // Validation freshness: a preview renders PERSISTED findings, which may
      // predate the latest case edit. Stale means "the case changed after the
      // last validation run (or validation never ran)" — disclosed, never hidden.
      const validationAt = vAgg._max.createdAt ?? null;
      const caseUpdatedAt = data.case.updatedAt ?? null;
      const stale = caseUpdatedAt != null && (validationAt == null || validationAt < caseUpdatedAt);
      return ok(
        {
          html: renderHtml(doc),
          freshness: {
            validationAt,
            assessedWith: data.assessments[0]?.generatedByModel ?? null,
            caseUpdatedAt,
            stale,
          },
        },
        { headers: SEC_HEADERS },
      );
    }

    // Library listing with per-report readiness.
    const [findings, items, exports, approvals] = await Promise.all([
      prisma.validationFinding.findMany({ where: { caseId: params.caseId, status: "OPEN" }, select: { exportBlocking: true } }),
      prisma.futureCareItem.findMany({ where: { caseId: params.caseId, supersededAt: null }, select: { physicianStatus: true, contingencyOnly: true } }),
      prisma.reportExport.findMany({ where: { caseId: params.caseId }, orderBy: { createdAt: "desc" } }),
      prisma.reportApproval.findMany({ where: { caseId: params.caseId, status: "ACTIVE" }, orderBy: { createdAt: "desc" } }),
    ]);
    const blocking = findings.filter((f) => f.exportBlocking).length;
    const decided = items.filter((i) => i.physicianStatus !== "PENDING").length;
    const pendingIncluded = items.filter((i) => i.physicianStatus === "PENDING" && !i.contingencyOnly).length;
    const lastExportByType = new Map<string, (typeof exports)[number]>();
    for (const e of exports) {
      const t = e.reportType ?? (e.format === "MEMO" ? "TESTIMONY_PACK" : "LIFE_CARE_PLAN");
      if (!lastExportByType.has(t)) lastExportByType.set(t, e);
    }
    const vocStatus = await vocationalState(params.caseId).then((v) => v.readiness.status).catch(() => "Intake incomplete");
    const econStatus = await economistState(params.caseId).then((e) => e.readiness.status).catch(() => "Intake incomplete");
    const reports = REPORTS.filter((def) => def.serviceTier === "core" || reportEnabled(ctx.firm.features, def.id)).map((def) => {
      const enabled = reportEnabled(ctx.firm.features, def.id);
      const approval = effectiveApproval(def, def.defaultConfig);
      const gate = gateReport({ ...def, approval }, { mode: "final", blocking: blocking > 0, decidedCount: decided, includedUndecided: pendingIncluded });
      const status = !enabled
        ? "Not enabled"
        : def.id === "VOCATIONAL_ASSESSMENT"
        ? vocStatus
        : def.id === "FORENSIC_ECONOMIST_REPORT"
        ? econStatus
        : def.requiredExpert && def.formats.length === 0
        ? "Expert input required"
        : def.requiresDecided && decided === 0
        ? "Not enough information"
        : !gate.ok
          ? approval === "physician_required" && pendingIncluded > 0
            ? "Physician review required"
            : "Blocked"
          : lastExportByType.has(def.id)
            ? "Previously exported"
            : "Ready";
      // Report-level approval state for the latest export of this type: the
      // newest ACTIVE approval/attestation, marked STALE when the export's
      // content hash no longer matches what was signed (disclosed, never hidden).
      const lastExport = lastExportByType.get(def.id);
      const latestApproval = lastExport ? approvals.find((a) => a.reportExportId === lastExport.id) : undefined;
      const approvalState =
        lastExport && latestApproval
          ? {
              kind: latestApproval.kind,
              expertRole: latestApproval.expertRole,
              reviewerName: latestApproval.reviewerName,
              createdAt: latestApproval.createdAt,
              status: approvalStale(latestApproval, lastExport) ? "STALE" : latestApproval.status,
            }
          : null;
      return {
        id: def.id,
        name: def.name,
        description: def.description,
        category: def.category,
        serviceTier: def.serviceTier,
        gate: def.gate,
        requiredExpert: def.requiredExpert ?? null,
        legacy: !!def.legacy,
        approval,
        formats: def.formats,
        defaultConfig: def.defaultConfig,
        status,
        gateReason: gate.ok ? null : gate.reason,
        blockingCount: blocking,
        findingRelevance: findingRelevance(def.id),
        lastGenerated: lastExport?.createdAt ?? null,
        approvalState,
      };
    });
    return ok({ reports, decided, blocking });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "report.export");
    await requireCase(ctx, params.caseId);
    const input = postSchema.parse(await req.json());
    const def = getReport(input.reportId);
    if (!def) return ok({ error: "Unknown report type" }, 400);
    if (def.legacy) return ok({ error: "This report type uses its original endpoint (/export or /export/testimony)." }, 400);
    if (!reportEnabled(ctx.firm.features, def.id)) return ok({ error: `${def.name} is not enabled for this firm.` }, 403);
    if (def.requiredExpert && def.formats.length === 0)
      return ok({ error: `${def.name} requires the ${def.requiredExpert} expert workflow, which is not yet available. No document can be generated — an incomplete support package is never exported as an expert report.` }, 409);
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
    // Expert-workflow reports (vocational/economist) carry their own report-level
    // gates below — the item-level physician gate does not apply to them.
    const hasExpertBranch = def.id === "VOCATIONAL_ASSESSMENT" || def.id === "FORENSIC_ECONOMIST_REPORT";
    let physAuthority: VerifiedExpertAuthority | null = null;
    if (!hasExpertBranch) {
      const approval = effectiveApproval(def, config);
      const gate = gateReport({ ...def, approval }, { mode: input.mode, blocking: validation.blocking, decidedCount, includedUndecided });
      if (!gate.ok) {
        return ok({ error: gate.reason ?? "Export refused by the report gate.", blocking: validation.blocking, hint: "Resolve blocking findings or export as draft where permitted." }, 422);
      }
      // Central professional authority for physician-required FINALS — the
      // same fail-closed contract as the legacy expert report. Item-level
      // decision counts (the gate above) are necessary but never sufficient:
      // final release requires an ACTIVE, clinically-bound attestation whose
      // opinion scopes cover this report and whose signer is currently
      // authorized. CUSTOM reports inherit this through effectiveApproval.
      if (input.mode === "final" && approval === "physician_required") {
        const authority = await evaluateProfessionalReportAuthority({
          firmId: ctx.firm.id,
          caseId: params.caseId,
          requiredScopes: REPORT_REQUIRED_SCOPES[def.id] ?? DEFAULT_PHYSICIAN_SCOPES,
          reportKind: def.id,
        });
        if (!authority.authorized) {
          await audit(ctx, "export.final_denied", {
            type: "case",
            id: params.caseId,
            caseId: params.caseId,
            meta: { reportType: def.id, format: input.format, reasons: authority.reasons },
          });
          return ok(
            {
              error: "Final release of this report requires current professional approval.",
              reasons: authority.reasons,
              hint: 'A draft export (mode: "draft") remains available with worksheet disclosures.',
            },
            422,
          );
        }
        physAuthority = authority;
      }
    }

    // Shared finish: render → hash+store (compensating) → snapshot for finals
    // → audit. Used by the standard compose path and the expert branches.
    const finish = async (doc: import("@/lib/reports/doc").ReportDoc, extras: { itemCount: number; totalLifetimeCost: number; totalPresentValue: number }) => {
      // Version transparency: when a prior version of this report exists, the
      // new version documents what changed since it (docs/23 addendum).
      try {
        const prior = await priorSnapshotFor(params.caseId, def.id);
        if (prior) {
          const current = buildSnapshotPayload(
            data.case as never,
            assumptionsFor(data.case as unknown as Case),
            { lifetime: extras.totalLifetimeCost, presentValue: extras.totalPresentValue },
          );
          const diff = diffSnapshots(prior.payload, current);
          const label = `v${prior.version}${prior.draft ? " (draft)" : " (final)"}, exported ${prior.createdAt.toISOString().slice(0, 10)}`;
          doc.blocks.push(...changesSection(diff, label));
        }
      } catch {
        /* change section is best-effort — never blocks an export */
      }
      let buffer: Buffer;
      if (input.format === "DOCX") buffer = await renderDocx(doc);
      else if (input.format === "PDF") buffer = await convertDocxToPdf(await renderDocx(doc));
      else if (input.format === "CSV") buffer = Buffer.from(renderCsv(doc), "utf8");
      else buffer = Buffer.from(renderHtml(doc), "utf8");

      // Time-of-check/time-of-use: for physician-required finals, re-evaluate
      // the authority immediately before recording and require the identical
      // authorized snapshot (attestation + report fingerprint). Drift during
      // rendering fails safely: no file recorded, no status change.
      if (physAuthority) {
        const recheck = await evaluateProfessionalReportAuthority({
          firmId: ctx.firm.id,
          caseId: params.caseId,
          requiredScopes: REPORT_REQUIRED_SCOPES[def.id] ?? DEFAULT_PHYSICIAN_SCOPES,
          reportKind: def.id,
        });
        if (
          !recheck.authorized ||
          recheck.attestationId !== physAuthority.attestationId ||
          recheck.reportFingerprint !== physAuthority.reportFingerprint
        ) {
          await audit(ctx, "export.final_denied", {
            type: "case",
            id: params.caseId,
            caseId: params.caseId,
            meta: { reportType: def.id, format: input.format, reasons: ["PLAN_CHANGED_DURING_GENERATION"] },
          });
          return ok(
            {
              error: "The plan changed while the report was being generated. Regenerate; if recommendations changed materially, the physician must re-attest.",
              reasons: ["PLAN_CHANGED_DURING_GENERATION"],
            },
            409,
          );
        }
      }

      let record: ReportExport;
      try {
        record = await storeAndRecord(buffer, EXT[input.format], {
          caseId: params.caseId,
          firmId: ctx.firm.id,
          format: input.format,
          template: "NEUTRAL",
          draft: input.mode === "draft",
          generatedById: ctx.user.id,
          reportType: def.id,
          config: config as never,
          itemCount: extras.itemCount,
          totalLifetimeCost: extras.totalLifetimeCost,
          totalPresentValue: extras.totalPresentValue,
          templateVersion: REPORT_TEMPLATE_VERSION,
          engineVersions: {
            reasoning: data.assessments[0]?.generatedByModel ?? "unknown",
            validation: "v1",
            template: REPORT_TEMPLATE_VERSION,
          },
          lifecycle: input.mode === "draft" ? "draft_expert" : def.serviceTier === "supporting" ? "supporting" : "final_expert",
        });
      } catch (err) {
        if (err instanceof ExportRecordError) return ok({ error: err.message }, 500);
        throw err;
      }

      if (input.mode === "final") {
        try {
          const maxSnap = await prisma.caseSnapshot.aggregate({ where: { caseId: params.caseId }, _max: { version: true } });
          const payload = buildSnapshotPayload(
            data.case as never,
            assumptionsFor(data.case as unknown as Case),
            { lifetime: extras.totalLifetimeCost, presentValue: extras.totalPresentValue },
          );
          const snapshot = await prisma.caseSnapshot.create({
            data: {
              caseId: params.caseId,
              firmId: ctx.firm.id,
              version: (maxSnap._max.version ?? 0) + 1,
              reportExportId: record.id,
              payload: payload as never,
              createdById: ctx.user.id,
            },
          });
          record = await prisma.reportExport.update({ where: { id: record.id }, data: { snapshotId: snapshot.id } });
        } catch {
          /* snapshot is best-effort */
        }
      }

      await recordUsage(ctx, "REPORT_EXPORT", { meta: { format: input.format, reportType: def.id } });
      await audit(ctx, "export.report", { type: "reportExport", id: record.id, caseId: params.caseId, meta: { reportType: def.id, format: input.format, version: record.version, mode: input.mode } });
      return ok({ export: record });
    };

    // FINAL factual record reports require completion of factual record
    // review: no unreviewed AI drafts, no stale content, no failed
    // extractions, no pending OCR. This is a FACTUAL gate — it requires the
    // review to have happened, never a physician credential (these reports
    // contain record facts, not medical opinions). Drafts remain available.
    if ((def.id === "MEDICAL_RECORD_SUMMARY" || def.id === "MEDICAL_CHRONOLOGY") && input.mode === "final") {
      const review = await factualReviewState(params.caseId, ctx.firm.id);
      if (!review.complete) {
        return ok(
          {
            error: "Final export requires completion of factual record review. Draft exports remain available.",
            blockers: review.blockers,
          },
          422,
        );
      }
    }

    // Vocational Assessment: composed from the structured vocational intake,
    // gated on expert completeness — never the medical-report compose path.
    if (def.id === "VOCATIONAL_ASSESSMENT") {
      const voc = await vocationalState(params.caseId);
      if (input.mode === "final" && voc.readiness.status !== "Ready for final export") {
        return ok({ error: `Final export requires a complete, expert-approved vocational assessment. Current state: ${voc.readiness.status}.`, missing: voc.readiness.missing }, 422);
      }
      const doc = composeVocational(`${data.case.clientName} · File ${data.case.caseNumber}`, voc.entries, { draft: input.mode === "draft", expertApproved: voc.approved });
      return await finish(doc, { itemCount: 0, totalLifetimeCost: 0, totalPresentValue: 0 });
    }

    // Forensic Economist Report: composed from explicit assumptions + stored
    // deterministic results; final requires the economist's report approval.
    if (def.id === "FORENSIC_ECONOMIST_REPORT") {
      const econ = await economistState(params.caseId);
      if (input.mode === "final" && econ.readiness.status !== "Ready for final export") {
        return ok({ error: `Final export requires computed scenarios and economist approval. Current state: ${econ.readiness.status}.`, missing: econ.readiness.missing }, 422);
      }
      const doc = composeEconomist(`${data.case.clientName} · File ${data.case.caseNumber}`, econ.assumptions, econ.scenarios, {
        draft: input.mode === "draft",
        expertApproved: !!econ.approval,
        conclusionText: econ.approval?.statementText,
      });
      return await finish(doc, { itemCount: 0, totalLifetimeCost: 0, totalPresentValue: 0 });
    }

    const findings = await persistedFindings(params.caseId);
    const doc = def.compose(data, config, findings, { draft: input.mode === "draft" });
    const included = items.filter((i) => includedIds.has(i.id));
    return await finish(doc, {
      itemCount: included.length,
      totalLifetimeCost: included.reduce((sum, i) => sum + (i.lifetimeCost ?? 0), 0),
      totalPresentValue: included.reduce((sum, i) => sum + (i.presentValue ?? 0), 0),
    });
  } catch (err) {
    return handleError(err);
  }
}
