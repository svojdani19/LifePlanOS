# Production-Pilot Hardening — Phase 0 Audit & Implementation Plan

Scope: harden LifePlanOS for a controlled pilot with Life Care Plan
Professionals, aligned to their four service lines. Additive only; the
existing Life Care Plan generator, routes, and clinical logic are preserved.

## PART 1 — AUDIT (current state, verified in-repo)

1. **Report Library UI** — `src/components/case/ReportLibrary.tsx`: dropdown
   grouped by category (Core/Record review/Damages/Clinical analysis/
   Governance/Custom), detail pane with config/preview/export, selection
   drives a report-scoped Plan Integrity Check (`FINDING_RELEVANCE`).
2. **Registry** — `src/lib/reports/registry.ts`: 13 `ReportDefinition`s
   (id/name/description/category/approval/gate/formats/configSchema/compose),
   `gateReport` pure matrix, `SECTION_MENU` for CUSTOM, `FINDING_RELEVANCE`.
3. **Definitions** — LCP + TESTIMONY_PACK are `legacy: true` (metadata only;
   compose throws). 11 composable types over `sections.ts` (19 pure builders)
   and `doc.ts` (Block model → DOCX/HTML/CSV).
4. **Generation routes** — `/api/cases/[caseId]/reports`: GET list+readiness,
   GET `?preview=` (HTML, audited), POST (validation-refresh → gate → compose
   → render → putObject → ReportExport row). Refuses legacy ids.
5. **Legacy LCP route** — `/api/cases/[caseId]/export`: untouched. Blocking
   gate (DOCX/PDF final 422), version = count(all formats)+1, advances case
   to FINAL, creates CaseSnapshot, audits `export.report`.
6. **Testimony route** — `/export/testimony`: untouched; own MEMO version
   series; **no validation gate** (pre-existing).
7. **Gating** — `gateReport`: physician_required final refused while any
   included item is undecided or blocking findings open; standard final
   refused on blocking; disclose always exports but compose appends the
   Unresolved Issues section. CSV on the legacy route is ungated (pre-existing).
8. **Approval logic** — recommendation-level only (`physicianStatus` +
   RecommendationTransition w/ reasonCode + before/after diffs). Attestation
   (EPIC-005) binds to the *scope of items* (lineage+version+material fields),
   NOT to report content. **No report-level approval object exists.** This is
   the spec's key distinction to build.
9. **Snapshots** — CaseSnapshot created only on the legacy LCP export path.
   **New report-library exports create no snapshot** (gap).
10. **Versioning** — both routes use `count(...)+1` → **race condition**
    (spec-confirmed defect). No unique constraint on (caseId, reportType,
    version); legacy rows have null reportType.
11. **Storage sequence** — `putObject` then `prisma.reportExport.create`;
    a DB failure orphans the stored object (no compensation). Filenames are
    opaque UUID keys; human name synthesized at download.
12. **Disclosures** — `doc.ts` renders per-doc `disclosures[]` (italic).
    The legacy LCP contains strong traceability language in its methodology/
    evidence appendices (report.ts Appendix D/E region) — the absolute
    statement the spec quotes must be located and replaced there in Phase 1.
    New-report sections emit honest "Not documented" empties.
13. **Validation freshness** — POST re-runs `persistCaseValidation` before
    gating (fresh). **Preview does not** — it renders persisted findings that
    may be stale; no case-revision/validation-version stamp is shown anywhere.
14. **Config model** — zod per definition; `defaultConfig`; persisted verbatim
    on `ReportExport.config` (Json).
15. **Report-type persistence** — `ReportExport.reportType String?` (null ⇒
    legacy; inferred MEMO→TESTIMONY_PACK else LCP). Format and type are
    already separate concepts (spec requirement already satisfied).
16. **Tests** — 531 green. Reports: registry (21), sections (29), doc (9),
    plus engine suites. **Absent: golden LCP DOCX fixture, route integration
    tests, concurrency tests, storage-failure tests, security-header tests.**
17. **LLM integration** — `src/lib/llm/index.ts`: mock + Anthropic providers;
    consumer is the case-assistant Q&A route only (report pipeline is fully
    deterministic; no LLM in any report path). **UNSAFE (spec-confirmed):**
    `LLM_PROVIDER=anthropic` without a key silently falls back to mock;
    unknown provider names silently fall back to mock; no startup validation;
    provider/model not recorded on outputs.
18. **Production protections** — no startup env validation; no CI workflow in
    repo (`.github/` absent); PDF/OCR fail loudly per-call (good).
19. **Feature flags** — none. Closest mechanism: subscription tiers with
    per-firm negotiated overrides (Json) in `src/lib/subscription/plans.ts`.
20. **Vocational / economic models** — **NONE implemented.** Only:
    DocumentType enum values (VOCATIONAL_ASSESSMENT, EMPLOYMENT_RECORDS,
    WAGE_LOSS_DOCUMENTATION… — classification labels for uploaded records),
    the case-level discount/inflation assumptions driving the medical cost
    engine, and the assumption-change ledger. There is no employment-history,
    earnings, restrictions-matrix, vocational-testing, economist-assumption,
    or expert-review model, and no vocational/economist workflow of any kind.
    Confirmed: the capability does not exist; it must be built additively.

## PART 2 — IMPLEMENTATION PLAN

### Files likely to change
- Registry/taxonomy: `src/lib/reports/registry.ts` (+ new
  `src/lib/reports/lifecycle.ts`, `disclosures.ts`), `sections.ts` additions.
- Routes: `reports/route.ts` (versioning, snapshot, hash, headers, freshness),
  `export/[exportId]/download/route.ts` (headers), new
  `reports/approve|attest` route(s), new vocational/economic API routes.
- UI: `ReportLibrary.tsx` (three-tier taxonomy), new expert workspaces
  (Vocational, Economist) as new components; CaseWorkspace one-line mounts.
- Engines: new `src/lib/engine/economics.ts` (deterministic PV/growth/
  discount/work-life/sensitivity), new `src/lib/vocational/*`.
- Safety: `src/lib/llm/index.ts` (hard-fail rules), new `src/lib/flags.ts`,
  `src/instrumentation.ts` (startup env validation), `.github/workflows/ci.yml`.
- Tests: golden LCP fixture + route integration + concurrency + storage +
  security + calc determinism.

### Schema changes (all additive + reversible; one migration per phase)
- P1: `Firm.features Json?` (tenant feature flags).
- P2: `ReportExport` + `contentSha256 String?`, `templateVersion String?`,
  `engineVersions Json?`, `snapshotId String?`, `lifecycle String?`
  (draft/final/superseded/amended), `supersededById String?`;
  `@@unique([caseId, reportType, version])` — legacy null-reportType rows are
  exempt in Postgres (nulls distinct), preserving existing data; new writes
  always set reportType. New model `ReportApproval` {reportExportId, kind:
  APPROVAL|ATTESTATION, reviewerId, credentials snapshot, statementText,
  contentSha256, caseRevision, status ACTIVE|STALE|INVALIDATED, timestamps}.
- P4: Vocational models (EmploymentHistory, EducationHistory,
  WorkRestriction, FunctionalCapacity, VocationalTest, LaborMarketResearch,
  VocationalFinding, each w/ source/date/enteredBy/verification/notes +
  revision via supersede pattern).
- P5: Economic models (EconomicAssumption {key, value, unit, source,
  effectiveDate, expertId, rationale, version, origin USER|CALC},
  EconomicScenario, EconomicResult w/ input hash).

### Feature flags (per-firm Json + env default; helper `flagEnabled(firm, key)`)
Enabled by default: LCP, testimony, chronology, record summary, provider
matrix, medical cost projection. Pilot (per-firm opt-in): vocational,
economist. Internal/disabled: necessity, causation, rebuttal, custom,
damages summary. Flag keys exactly as specified in the brief.
Disabled-but-visible rule: the four service lines always render with honest
readiness states; beta reports render only for authorized roles.

### Service-focused taxonomy (registry `serviceTier` field + UI)
- CORE (Injury Valuation Services): LIFE_CARE_PLAN,
  MEDICAL_COST_PROJECTION (rename of COST_PROJECTION id — kept as alias for
  stored rows), VOCATIONAL_ASSESSMENT (new), FORENSIC_ECONOMIST_REPORT (new).
- SUPPORTING: chronology, record summary, provider matrix, physician review
  report, testimony pack, evidence appendix (new thin composition), cost CSV.
- BETA: necessity, causation, rebuttal, damages summary, custom.
Page header "Injury Valuation Reports"; core cards first and largest;
supporting compact; beta collapsed + flag/role-gated.

### Expert-approval matrix (extends gateReport; report-level layer added)
| Report | Final requires |
|---|---|
| LCP | unchanged rec-level rules + optional firm-policy report attestation |
| Medical Cost Projection | firm-configurable (default: standard gate + physician-decided included items); provider-documented vs system-generated labeled |
| Vocational Assessment | vocational-expert report approval + attestation; restrictions attributed to clinical source |
| Forensic Economist | economist report approval + attestation; assumptions all sourced; references LCP/MCP snapshot |
| Chronology / Summary / Matrix | none (factual) + prominent unresolved-issues banner when issues exist |
| Necessity / Causation / Rebuttal | qualified physician REPORT-level approval (rec approval ≠ report approval) + attestation bound to contentSha256 |
| Custom | strictest selected section governs; cannot bypass |
New statuses: Intake incomplete / Missing records / Expert input required /
Vocational expert review required / Economist review required / Draft ready /
Ready for final export / Finalized / Internal beta / Not enabled.

### Backward compatibility
- Legacy routes byte-identical until golden test exists (P1 gates all later
  formatting work). Null-reportType rows keep working (inference preserved).
- New ReportExport columns nullable; downloads unchanged; version constraint
  ignores legacy nulls; rollback.sql per migration.

### Regression-test plan
- Golden LCP: build DOCX from a seeded fixture case, unzip, normalize
  document.xml (strip rsid/dates), assert section order, headings, totals,
  banners, attestation, footer — committed as fixture; test fails on drift.
- The brief's 25 architecture tests + 12 route integration tests mapped 1:1
  (vitest + route-handler invocation with mocked ctx; concurrency via
  Promise.all on POST; storage failure via injected prisma error).
- CI: `.github/workflows/ci.yml` → npm ci, prisma validate/generate, vitest,
  next build (migrate deploy only when DATABASE_URL secret present).

### Rollout phases (per brief; stop-and-report after each)
P1 safety/regression → P2 reproducibility/export hardening → P3 service
alignment UI → P4 vocational workflow → P5 economist workflow → P6 pilot
readiness. No phase begins until the prior phase's report is acknowledged.

### Risks & rollback
- Golden test flakiness (DOCX nondeterminism) → normalize aggressively; pin
  a fixed generation date input. Rollback: remove test only.
- Unique-constraint migration on tables with legacy rows → nulls-distinct
  semantics verified on Neon Postgres before deploy; rollback.sql drops it.
- Renaming COST_PROJECTION → MEDICAL_COST_PROJECTION: keep old id accepted
  at the API and mapped in readiness; stored rows never rewritten.
- Report-level approval could be confused with existing item attestation →
  distinct model + distinct UI labels ("recommendation approval" vs "report
  approval" vs "report attestation"); attestation invalidation shown, never
  silently dropped (changes report.ts §22 behavior — behind golden test).
- Neon instability (observed) → CI uses its own ephemeral Postgres; local
  dev fallback documented (docker db:up).
- LLM hard-fail could break the assistant in prod if keys absent →
  startup validation reports it at boot, route returns explicit 503 with
  labeled reason; mock never silently used when NODE_ENV=production.
