# LifePlanOS — Changelog

Newest first. Entries reference commits on `main`.

## 2026-07-12 — Priorities 2–4: lifecycle, evidence graph, explorers, ops

- **P2.R1 Recommendation versioning implemented** (`b92c7b7`): regeneration
  supersedes (never deletes) recommendations with review history — stable
  lineage (`lineageId`, version, forward pointer), review actions preserved
  verbatim; material changes (code-defined field list) invalidate approval and
  return the item to review with the approved version frozen; nonmaterial
  wording edits carry approval; every action ledgered in
  `RecommendationTransition`; `recommendation.supersede` /
  `recommendation.approval_invalidated` audit events; 12-state
  `lifecycleStatus` alongside the legacy physicianStatus. E2E-verified.
- **Evidence graph + Evidence Explorer** (`b92c7b7`): `EvidenceLink` rows
  lifted strictly from structured engine output (diagnosis→record evidence
  with page+quote, diagnosis→guideline, recommendation→diagnosis/literature,
  contradictions); Evidence tab renders the five-part source-backed
  explanation for any diagnosis or recommendation.
- **P3 explorers** (`a9eb969`): Cost Explorer drill-down (code, pricing basis,
  frequency/duration, review status, assumptions) with a reason-captured
  `AssumptionChange` ledger; `CaseSnapshot` digest on every export with a
  structured version diff (records/diagnoses/items/codes/pricing/review/
  literature/assumptions/totals) and a Compare Versions card; role-scoped
  dashboard queues (physician review queue, integrity findings, attorney
  damages posture).
- **P4 operations**: per-email login throttling added to the per-IP limiter
  (tested); document deletion now garbage-collects the stored object (PHI
  hygiene); PDF decision recorded (ATD-7 — DOCX canonical). Firm analytics
  live on the dashboard.
- Tests 128 → 157 across 19 suites; tsc clean throughout.

## 2026-07-12 — Documentation consolidation + P2.R1 formal requirement

- **Consolidated documentation into the canonical numbered structure**
  (`docs/00_…17_*.md` + `docs/epics/`, the skeleton created on the remote as
  source of truth). Filled documents migrated with all content preserved:
  MASTER_PRODUCT_SPEC→00, ARCHITECTURE→05, DATA_MODEL→06, AI_PIPELINE→07,
  REPORT_ENGINE→10, SECURITY_AND_PHI→11, ROADMAP→15_PRODUCT_ROADMAP,
  CHANGELOG→17_CHANGELOG; duplicates removed; all cross-references rewritten.
  Previously empty stubs authored: 01 Product Vision, 02 Market Analysis
  (qualitative, no invented statistics), 03 User Personas, 04 Product
  Principles, 08 Evidence Graph, 09 Clinical Rules, 12 Deployment, 13 Developer
  Standards, 14 Testing, 16 Decision Log (ATD log moved here from 13).
  Epic PRD scaffolds: EPIC-001 (Recommendation Integrity — partially shipped)
  written in full; EPIC-002…010 given status + scope pointers pending full PRDs.
  Two stray empty `blueprints` files (root and docs/) removed as accidental
  web-UI artifacts. `docs/README.md` now carries the canonical reading order.
- **P2.R1 Recommendation versioning** recorded as a formal, binding Priority-2
  requirement (15_PRODUCT_ROADMAP): supersede-not-delete for reviewed recommendations,
  stable lineage (`lineageId`/`supersededById`), material changes invalidate
  approval and require re-review, nonmaterial formatting changes do not,
  supersession/invalidation audit events, and required review-history
  preservation tests. Proposed lineage schema documented in 06_DATABASE_SPEC.
- **Accepted Technical Decisions logged** (16_DECISION_LOG ATD log):
  ValidationFinding rows persisted source of truth (ATD-1); live GET summary
  counts until profiling says otherwise (ATD-2); storage GC + auth rate
  limiting gate any paid production pilot (ATD-3); frequency/duration
  plausibility starts as narrow deterministic rules (ATD-4); supersede-not-
  delete (ATD-5).
- Documentation-only change: no application behavior altered.

## 2026-07-12 — Priority 1: validation persistence, security tests, docs

- **Persisted integrity findings.** New `ValidationFinding` model (+ migration
  `20260712090000_add_validation_findings`); `engine/validation.ts` service
  runs the deterministic integrity check and atomically replaces the case's
  findings. Refreshed on plan generation, physician review, and report export;
  on-demand via new `GET|POST /api/cases/:id/validation` (audited).
- **Plan Integrity Check card** in the Report tab: severity-badged findings,
  inclusion counts, re-run button — existing design system, no navigation
  changes. Shared record-support logic extracted to
  `integrity.hasPatientRecordSupport` so report and service can never disagree.
- **Tenant-isolation tests** (`src/lib/security/tenantIsolation.test.ts`):
  behavioral cross-firm denial for `requireCase` + a conformance scan requiring
  `requireApiContext`/`requireCase` in every `/api/cases/[caseId]/**` route.
- **Financial reproducibility tests** in `engine/cost.test.ts`: determinism,
  hand-computed inflation/discount regression, fractional final year, zero-
  duration edge.
- **Documentation set** created: MASTER_PRODUCT_SPEC, ARCHITECTURE, DATA_MODEL,
  AI_PIPELINE, REPORT_ENGINE, SECURITY_AND_PHI, ROADMAP, CHANGELOG.

## 2026-07-11

- `482ede8` **Clinical-data integrity / correction layer** (additive):
  body-region diagnosis mapping (no primary-diagnosis defaulting), CPT/HCPCS ↔
  service ↔ region ↔ pricing validation, literature relevance gate
  (population/evidence-level aware), honest physician-review labels, inclusion
  gating for totals, integrity findings with severities, DRAFT watermark on
  critical errors. Fixed seed-library defects the validator surfaced
  (transforaminal injection miscoded 62323→64483; EMG priced from an MRI
  label). 29 new tests.
- `eea7c4f` **Report rewritten as a physician-authored medicolegal document**:
  Garamond/navy design, running header/footer, classic section flow,
  first-person physician voice, per-item necessity narratives, all AI/score
  language removed from the document.
- `84c1a80` **Deposition-style expert rationale** for each standard-of-care
  verdict (guideline-grounded, record-cited; determination reserved to the
  physician).
- `0c46468` **Guideline coverage for ICD-phrased diagnoses**: concept
  vocabulary in the on-topic gate; spine-fracture and spasticity concepts;
  coverage 10/15 → 15/15 seeded conditions.
- `40b2f61` / `5b677e8` **Records panel**: consolidated charts split per dated
  encounter (own provider/facility/finding); de-duplicated meta; record-summary
  logic extracted to a pure, tested module.
- `c4382ee` / `6584500` **Chronology on OCR charts**: per-encounter provider
  and record-type attribution, OCR-soup headline guard, provider-name
  extraction, 200-DPI OCR with PSM retry, transactional rebuilds.
- `3604740` **LCP-format chronology entries** (labeled clinical sections +
  source citations; new ChronologyEvent fields).
- `a132785` **SoC reviewer inputs** (notes/sources/articles) incorporated into
  the analysis; `SocUserInput` model; recompute-in-place.
- Earlier same-day: multi-source literature (Europe PMC + Crossref + Semantic
  Scholar), abstract-aware citation relevance, OCR pipeline (tesseract),
  document metadata extraction, ICD-10 search intake, precedent library,
  physician review workflow, billing/subscription, MFA, audit trail.

## 2026-07-08 — Initial build

- `6c51857` … `84bf36c` Standalone multi-tenant SaaS scaffold: firm/
  subscription/seats, auth + sessions, tenant guard + RBAC + audit, case
  intake, document upload/classification, clinical modules
  (intake → records → chronology → causation → future care → costs → reviews →
  physician → report), DOCX/CSV export, dashboard, landing.
