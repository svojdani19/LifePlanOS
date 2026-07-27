# Report Library — Implementation Plan (EPIC: multi-report selection)

Additive feature: a report-type selector inside the existing Report tab. The
existing Life Care Plan (DOCX/PDF/CSV via `POST /api/cases/[caseId]/export`)
and Testimony Pack (`/export/testimony`) remain untouched and remain the
default paths. All new reports draw from the same canonical case data.

## 1. Current architecture (audited 2026-07)

- UI: "Report" tab → ReportPanel (CaseWorkspace.tsx:3147) → Generate Report
  card (Export DOCX/PDF/CSV + Testimony Pack) + ValidationCard + Export History.
- API: `POST /api/cases/[caseId]/export` — gate: DOCX/PDF + mode=final +
  validation.blocking → 422. `mode:"draft"` never blocked, banners + Appendix G.
  CSV/testimony ungated. `report.export` permission (rbac.ts:19).
- Builder: `buildReportDocx(caseId, template, {draft})` in src/lib/export/report.ts
  (30 sections, private design kit h1/h2/p/labeled/table/specGrid/factTable,
  Garamond/NAVY). `buildCostCsv` same file. Storage: putObject → ReportExport row
  (format/template/draft/version/storageKey/totals) → download route synthesizes
  filename. Audit: "export.report", "export.download", "export.testimony_pack".
- Data selectors available: buildRecommendationDossier, runIntegrityCheck
  (perItem.includedInTotal), persisted ClinicalReasoningAssessment (v6),
  chronologyEvents, treatingProviders + interviewFindings, RecommendationTransition
  ledger (reasonCode + {field,from,to} diffs), Attestation + verifyAttestation,
  evidenceSources (quotes + offsets), FutureCareItem.origin/templateRuleId,
  snapshot payload/diff, validationFinding (exportBlocking).

## 2. Architecture of the addition

New module tree (all new files; report.ts gains only an exported `reportKit`):

- `src/lib/reports/doc.ts` — neutral block model:
  `Block = h1|h2|p|labeled|bullet|source|table|pagebreak` + `ReportDoc {title, blocks}`.
  Renderers: `renderDocx(doc, {draft})` (uses reportKit), `renderHtml(doc)`
  (preview, existing Tailwind classes), `renderCsv(doc)` (first table block →
  RFC-4180; only for matrix/chronology/cost reports).
- `src/lib/export/report.ts` — ADDITIVE export `reportKit` (existing private
  helpers + design constants). No behavior change.
- `src/lib/reports/data.ts` — `loadReportData(caseId)`: one query mirroring
  buildReportDocx's include + persisted assessments + transitions + attestations
  + learned context. Single source of truth; no recomputation of stored facts.
- `src/lib/reports/sections.ts` — pure builders (ReportData, config) → Block[]:
  caseHeader, executiveSummary, chronology, diagnoses, imaging, procedures,
  treatmentHistory, functionalLimitations, providerRecommendations, futureCare,
  medicalNecessity, costProjection, evidence, contradictoryEvidence,
  missingEvidence, literature, physicianReview, citations, unresolvedIssues.
  Every factual line comes from structured rows; origin labels from
  RecommendationOrigin + provider/interview provenance; no invented citations.
- `src/lib/reports/registry.ts` — `ReportDefinition { id, name, description,
  category, permission: "report.export", approval: "none"|"recommended"|"required",
  formats: ("DOCX"|"PDF"|"CSV"|"HTML")[], gate: "standard"|"disclose",
  configSchema (zod), compose(data, config) → ReportDoc }` + REPORTS list.
  LIFE_CARE_PLAN + TESTIMONY_PACK registered as `legacy: true` (metadata only;
  their existing routes/builders untouched).
- API `src/app/api/cases/[caseId]/reports/route.ts`:
  - GET → registry + per-report readiness {status, approvalRequired, blocking
    count, lastGenerated} (reads persisted findings + ReportExport rows).
  - GET `?preview=<id>&config=` → HTML preview (no storage; audit "report.preview").
  - POST {reportId, format, config, mode} → gate per matrix → build → putObject
    → ReportExport row {reportType, config} → audit "export.report" meta.reportType.
- UI: ReportPanel gains a "Report Library" card grid ABOVE the existing
  Generate Report card (which stays byte-identical). Card: name, description,
  approval badge, readiness badge, Configure/Preview/Export. Modal preview via
  rendered HTML. Existing design classes (card, badge, btn-*).

## 3. Schema (additive + reversible)

`ReportExport`: + `reportType String?` (null ⇒ legacy: infer LCP from
DOCX/PDF/CSV, TESTIMONY_PACK from MEMO), + `config Json?`. Migration
20260727150000_report_library (+rollback.sql). ExportFormat enum: + `HTML`.

## 4. Approval & gating matrix

| Report | Approval for FINAL | Export gate |
|---|---|---|
| Life Care Plan (existing) | unchanged | unchanged (blocking→422) |
| Medical Chronology | none (facts) | disclose: unresolved-issues section required; never bypasses facts |
| Medical Record Summary | none | disclose |
| Provider Recommendation Matrix | none | disclose |
| Cost Projection | standard | standard blocking gate (same as LCP final); draft allowed w/ banner |
| Future Care Summary | standard | standard |
| Damages Executive Summary | standard | standard |
| Medical Necessity | REQUIRED: every included item APPROVED/MODIFIED + no blocking | final blocked otherwise; draft allowed w/ banner |
| Causation Analysis | REQUIRED (same) | same |
| Defense Rebuttal / Audit | REQUIRED to label as expert opinion; draft = "ANALYST WORKSHEET" banner | standard |
| Physician Review Report | ≥1 decided item required | disclose |
| Custom | max(rule of included sections) | derived |

Rules: mode=final + gate=standard + validation.blocking → 422 (same shape as
existing). approval=required + final + not satisfied → 422 with reason. Draft
output always carries the existing draft banner conventions. No report type
can bypass exportBlocking findings for totals-bearing content.

## 5. Origin labels

Wherever a recommendation appears: TEMPLATE_* → "System generated (care
library)", PHYSICIAN_ADDED → "Physician reviewer", provider interview rows →
"Treating provider", patient interview → "Patient reported", GOLD_IMPORT →
"Imported source". Physician decisions labeled from RecommendationTransition.

## 6. Testing plan

- registry.test.ts: 12 definitions resolve, formats subset, approval matrix,
  config schemas parse/reject, custom composition contains selected sections.
- sections.test.ts: fixture ReportData → each section emits only from data
  (no invented text), origin labels correct, citations carried through,
  chronology filters (type/date-range) work, CSV render shape.
- gating.test.ts: pure gate function — blocking+final+standard → refused;
  draft allowed; necessity final w/ pending items refused; chronology with
  blocking findings must include unresolvedIssues section.
- Regression: existing suites untouched; buildReportDocx signature unchanged
  (compile-time); new API route not touching /export.

## 7. Phases

P2 registry+doc+data+sections+builders+tests (agent) → P3 LCP/testimony
registered as legacy defaults → P4-6 all types in registry (same wave) →
P7 custom (config-driven compose) → P8 UI+API+migration+audit+regression.
Caching: preview computed on demand from stored rows only (no LLM anywhere);
ReportExport rows are the immutable snapshots (unchanged model).

## 8. Risks

- CaseWorkspace.tsx is 3200+ lines — UI edit must be surgical (new component
  file `src/components/case/ReportLibrary.tsx`, one render line added).
- HTML preview must not leak across roles: same permission as export list.
- Filename convention: extend download route mapping by reportType — additive
  only (`kind` fallback preserved for legacy rows).
