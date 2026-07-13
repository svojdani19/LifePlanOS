# LifePlanOS — Changelog

Newest first. Entries reference commits on `main`.

## 2026-07-12 — Staged/conditional persistence + functional-domain link (sprint close)

Report Quality Sprint, part 3 (§10, §12) — completes the sprint. Additive only.

- **Staged/conditional metadata (§10)**: `FutureCareItem` gains `prerequisite`,
  `earliestTiming`, `replacesService`, `contingencyOnly` (migration
  `20260712180000`). A `contingencyOnly` item is **excluded from totals** in
  `classifyRecommendation`; an explicit `replacesService` marks the pair
  **sequential** in the consistency engine (so a staged replacement is never
  totaled twice); the report states trigger / prerequisite / earliest timing /
  what-it-replaces; a conditional item with no earliest timing raises a
  (non-blocking) validation finding.
- **Functional-domain link (§12)**: the dossier now carries a `functionalLink`
  (domain · documented limitation · source · quantified · relationship), derived
  only from a **documented** functional finding in the recommendation's region —
  it is `null` when none is documented (never invents a deficit). The report
  renders a *Functional basis* line per recommendation.
- Tests: functional link present-with-quantified / absent-when-undocumented, and
  explicit-replacement sequencing. 242 → 245.

## 2026-07-12 — Physician-narrative variation + recommendation-specific literature

Report Quality Sprint, part 2 (§1, §4, §5, §15). No structure/styling change.

- **Narrative de-repetition** (`engine/medicalNecessity.ts`): each sentence role
  (opening pathology, prior treatment, functional impact, the necessity opinion,
  guideline anchoring), the probability statement, and each article's
  applicability now draw from several phrasings chosen by a **stable hash of the
  recommendation** — so different recommendations read differently while the same
  recommendation is byte-for-byte reproducible across regenerations. No clinical
  content changes; only sentence structure/wording.
- **Length modulation** (§15): simple, low-cost, non-disputed items get a concise
  necessity (pathology + opinion); the full multi-sentence synthesis (prior
  treatment, functional, guideline) is reserved for complex, high-cost, lifetime,
  contingent, or disputed recommendations.
- **Recommendation-specific literature** (§4/§5): each cited article now uses its
  own stored claim (`supports`) and a varied applicability line instead of one
  template. Confirmed the existing hard gate already rejects off-target evidence
  — a pain-management *office-visit* recommendation does not draw on a knee-
  arthroplasty or lumbar-fusion study (procedure-family + management-scope gate).
- Tests: opening/probability variation across recommendations, reproducibility,
  concise-vs-full length, and the §4 scope rejection. 238 → 242.

## 2026-07-12 — Recommendation consistency & conflict resolution

Report Quality Sprint, part 1 — the biggest gap: every engine analyzed one
recommendation in isolation, so nothing stopped two from contradicting each
other. New cross-recommendation pass (additive; no UI/styling/cost-engine
redesign, no Standard-of-Care module, no physician-consistency audit feature).

- **`engine/recommendationConsistency.ts`** (pure, tested): classifies each
  relevant pair as **mutually_exclusive** (competing pathways for the same
  problem/period), **sequential** (conservative→surgery, primary→revision,
  walker→wheelchair), **duplicate** (same/overlapping service), or **concurrent**
  (complementary — no action). Resolves genuine conflicts by a fixed priority —
  **medical probability → record support → cost only as a last tiebreak** (cost
  never overrides probability; a cost tiebreak is flagged). It never edits or
  deletes a recommendation — it annotates and flags.
- **Wired into `runIntegrityCheck`** (the single point that already feeds
  validation and the report): mutually-exclusive or duplicate pathways that are
  BOTH totaled now emit **export-blocking** findings; a revision with no
  survivorship/failure trigger emits a non-blocking finding. Findings persist via
  `validateCase` and flip the existing DRAFT watermark.
- **Report** (`export/report.ts`): each recommendation now shows a
  *Recommendation consistency* line — what it conflicts with and how the conflict
  was resolved — within the existing structure/styling.
- Tests: 10 cases covering all 7 sprint scenarios (conservative-vs-fusion,
  injections-vs-surgery, arthroplasty→revision, walker-vs-wheelchair, PT overlap,
  two surgical alternatives, two non-conflicting probable services) plus
  cost-never-overrides-probability and cost-tiebreak-only-when-equal. 228 → 238.

## 2026-07-12 — OCR: evidence-based DPI bump + cloud-provider seam

Improves the local OCR that reads scanned charts, and lays in a ready-to-switch
seam for medical-grade cloud OCR (the remaining big lever, gated on a customer
BAA + credentials).

- **Local pipeline** (`ocr.ts`): render DPI 200 → **300**. An A/B over Trice's
  scanned pages showed 300 DPI *without* preprocessing consistently equals or
  beats 200 (higher Tesseract confidence, less garbage, more text), while hard
  binarization tanked confidence (82→61) and a contrast-stretch destroyed faint
  text (one page 1634→357 chars) — so preprocessing stays **off by default**.
  `OCR_DPI` (150–400) and `OCR_PREP` (`none`/`enhance`/`binarize`) are env knobs.
- **`documents/imagePrep.ts`** (pure, tested): grayscale, Otsu threshold
  (plateau-midpoint), contrast-stretch, and hard binarize — available for
  document types where they're proven to help, but not enabled.
- **`documents/ocrProvider.ts`** — provider seam. Default **local** Tesseract
  (no PHI leaves the device). A cloud provider runs only when `OCR_PROVIDER` +
  `OCR_BAA_ACK=true` + credentials + an implemented adapter are all present;
  otherwise it throws a clear setup error and **sends no PHI** (no silent
  fallback, no silent ship). `ocrQueue` now routes through it.
- Config documented in `12_DEPLOYMENT.md`. Tests 223 → 228; tsc clean.

## 2026-07-12 — Chart-structure preprocessing: learn & strip page furniture

Large scanned charts (Trice's 1,026-page PSMC record) are dominated by repeated
page furniture — patient/facility banners, audit/acknowledgement lines, and
medication-administration / intake-&-output flowsheet grids — that OCR turns
into noise and that date-anchoring mistakes for encounters.

- **`documents/chartStructure.ts`** (pure, tested): `stripChartFurniture` learns
  the furniture from the chart itself — a line recurring above a page-scaled
  threshold is furniture, since a real finding rarely repeats verbatim — and
  drops it, while **preserving `Page N of M` markers** (page citations) and
  **never dropping a clinically-worded line** even when repeated. High-frequency
  banners that OCR merges onto a real line are scrubbed as substrings; flowsheet/
  MAR/audit rows are dropped by shape. Vendor-agnostic (adapts per chart); a
  no-op on records < 4 KB.
- Wired in **ahead of** both segmentation (`segment.ts`) and the chronology
  builder (`chronology.ts`).
- On the Trice PSMC chart: total segments **357 → 137**, administrative noise
  roughly halved, and new real findings surfaced (pneumonia dx, additional
  imaging, line/tube placement) — clinical set stays ~26 clean, page-cited
  encounters. Clean records unaffected (sample 4/4, PPG 6). Tests 219 → 223.

  Note: this is the first, deterministic step of the "scanned-chart quality"
  program. The remaining big levers — medical-grade OCR (Textract / Google
  Document AI; needs a BAA) and gated LLM field extraction — are still to come
  and require customer credentials; PDF-bookmark and header/note-boundary
  splitting are queued deterministic follow-ups.

## 2026-07-12 — Full LCP data points per medical-record event

Each timeline event was essentially a one-line summary (on David Chen's case,
`objectiveFindings`/`disposition` 0/8, `subjective`/`diagnosis`/`treatment`
1–2/8). Now every medical-record event carries its complete LCP data-point set.

- **One canonical extractor** — `extractEncounterData(body, {isImaging})` in
  `engine/chronology.ts` (pure, unit-tested): Subjective · Past medical history ·
  Exam · Diagnostic studies (imaging **and** labs) · Assessment · Plan ·
  Procedure (with anesthesia + EBL) · Medications (drug/dose/SIG/supply/refills) ·
  Functional status · Work status · Restrictions · Impairment/MMI · Disposition.
- **Fixes**: an MRI now yields both the *findings* line and the *impression*
  (assessment); a post-op "Same." resolves to the pre-op diagnosis; a section
  value that ends at a line break before its next label no longer drops (added
  pre-/post-op-diagnosis terminators).
- **Coverage**: single `PHARMACY_RECORD` / `LAB_REPORT` / `IME_REPORT` /
  `NEUROPSYCHOLOGICAL_EVALUATION` / `FUNCTIONAL_CAPACITY_EVALUATION` / `EMG_NCS`
  records are included on the timeline so their unique data points (current meds,
  labs, impairment/MMI, cognitive testing) reach the plan.
- **Surfaces**: the timeline UI and the DOCX report render the new fields (PMH,
  Medications, Functional status, Work/Restrictions, Impairment/MMI).
- Schema: `ChronologyEvent.pastMedicalHistory`, `impairmentRating` (migration
  `20260712170000`). On Chen's case: ~5 → 13 populated data points across 11
  events. Tests 214 → 219; tsc clean.

## 2026-07-12 — Chart segmentation: consolidated records split into typed sub-documents

Fixes the Records panel showing "See the cited source page for this encounter"
on many dates of a large chart (Jennifer Trice's 1,026-page Phoebe Sumter PDF):
those dates were landing on administrative pages the date-splitter surfaced as
empty encounters.

- **Deeper lever — segment at ingest** (`documents/segment.ts`, new pure module):
  a consolidated chart is parsed into persisted sub-documents (`Document.segments`),
  one per dated section, each typed and classified **clinical** (with an extracted
  finding) vs. **administrative** (consent, facesheet, rights/privacy notice,
  signature). Computed in `ingestDocument` and recomputed after OCR; the Records
  panel reads the persisted segments (falls back to on-the-fly splitting for
  legacy rows).
- **Administrative category, not dropped**: administrative pages that bear on the
  diagnosis / future-care plan (surgical consent, advance directive, DME &
  discharge planning, work status, financial responsibility) are kept in an
  **"Administrative & consent bearing on care"** group; pure boilerplate collapses
  to a single count. No empty placeholder rows.
- **Higher-quality clinical extraction**: findings are gated on a clinical
  signal and rejected as non-clinical when patient-facing (consent/education/
  rights address "you/your" or "I agree"), report boilerplate (transcription
  footers, routing/`cc:` lines, accession headers), medication-administration /
  order-sheet grids, or garbled OCR — and near-duplicate encounters on a date are
  de-duplicated. A labeled op-note / H&P section outranks a consent page that
  merely names the procedure; a real DME instruction keeps its specifics; a
  patient-education leaflet page routes to the administrative group even when it
  mentions "home health." On the Trice chart this replaced 12-of-23 blank
  "encounters" with ~27 clean, physician-usable one-liners (op-note changes,
  radiology impressions, vitals, sepsis/respiratory-failure complications,
  consult, DME needs, hospital course, discharge — each page-cited) plus a
  categorized administrative group. Zero placeholders. Precision is high on clean
  records and this large scan; unfamiliar EHR/vendor boilerplate may need its
  patterns extended (all centralized in `segment.ts`).
- **Full-chart indexing**: OCR `MAX_TEXT` raised 1.5M → 4M chars so charts beyond
  ~750 pages are no longer truncated; the scanned PSMC record is re-OCR'd end to
  end and re-segmented.
- Schema: `Document.segments` JSON (migration `20260712160000`). Tests 205 → 214
  (`segment.test.ts`); tsc clean.

## 2026-07-12 — Preparing physician: report credentials come only from the signer

Refines EPIC-011 P3. The report's authorship — Qualifications paragraph,
credential documents list, and signature — now derives from a **per-case
designated "preparing physician,"** not from the case creator (usually a
planner). Only that physician's credentials appear; no other seat's do.

- **Schema**: `Case.preparingPhysician` → `User` (`@relation("CasePreparingPhysician")`,
  `ON DELETE SET NULL`); migration `20260712150000`.
- **Report** (`export/report.ts`): Qualifications, referenced-documents list, and
  signature read `preparingPhysician`; when none is designated it falls back to
  the creator's name with the generic "under separate cover" text and renders
  **no** credentials.
- **API**: `PATCH /api/cases/:id` accepts `preparingPhysicianId`, validated to be
  an active member of the firm.
- **UI**: a "Preparing Physician" selector on the Report panel (populated with
  the firm's admin/planner/physician seats).
- E2E-verified on David Chen's case: with Dr. Sam Okafor, MD designated, the
  Qualifications section and signature show **his** name + board certification +
  CV, and the planner-creator's RN CLCP credentials do not appear anywhere.

## 2026-07-12 — EPIC-011: clinical interviews & reviewer credentials

Closes the physician-authorship / patient-voice gap found benchmarking against
a signed physician LCP. All user-authored; nothing fabricated.

- **Treating Providers tab**: auto-lists providers parsed from the records
  (`providerRoster.ts` — people only, facilities/metadata rejected, appearances
  merged), with confirm/edit/dismiss/add; the roster is curated and survives
  regeneration.
- **Interviews**: patient and treating-provider findings — categorized or
  free-text, with verbatim quotes and dates, optionally linked to a diagnosis or
  a specific recommendation. Item-specific links appear only on that item;
  diagnosis-level links apply across that diagnosis's items.
- **Report incorporation**: a Glazer-style **Current Complaints** section under
  Current Medical Status; interview findings woven into each recommendation's
  medical-necessity narrative and evidence buckets (patient→functional,
  provider→physician documentation); a Methodology note of the interviews
  relied upon.
- **Seat credentials**: any medical-personnel seat (ADMIN/PLANNER/
  PHYSICIAN_REVIEWER) can upload board certification / CV / license documents
  (stored via S3/local, streamed through an authed route, GC'd on delete) and
  set a credential summary; the report **Qualifications** section renders a real
  credentials paragraph + referenced-documents list in place of the generic
  "CV under separate cover."
- New APIs (all tenant-guarded + audited): `/api/cases/:id/providers[/:id]`,
  `/api/cases/:id/interviews[/:id]`, `/api/team/:userId/credentials[/:id[/view]]`,
  and `credentialSummary` on the team PATCH.
- Schema: `TreatingProvider`, `InterviewFinding`, `UserCredential` + enums,
  `User.credentialSummary` (migration `20260712140000`).
- Tests 187 → 205 (providerRoster 7, interview weaving 4, +…); tsc clean.
  E2E-verified: providers extracted from David Chen's records, patient/provider
  interviews rendered in Current Complaints and woven into the pain-management
  recommendation.

## 2026-07-12 — Refactor: Medical Necessity engine replaces the SoC module

- **Retired the Standard-of-Care module as a user-facing workflow**: removed the
  SoC tab/nav, its report section, and its export path. The guideline-retrieval
  backend (`standardOfCare.ts`) is RETAINED as an internal service that
  populates `Condition.socAnalysis`; the `/soc` reviewer-input APIs and data are
  preserved. No standard-of-care/negligence opinions are generated anywhere.
- **New `engine/medicalNecessity.ts`** (pure, 11 tests): `buildRecommendationDossier`
  synthesizes, per recommendation, a complete physician-quality dossier —
  medical-necessity narrative (physician voice, never a diagnosis restatement),
  structured probability with a percentage, potential challenges, organized and
  source-traceable supporting evidence (diagnoses / objective findings / imaging
  / examination / functional / physician documentation / prior treatment /
  guidelines), gated literature (each stating exactly what it supports + its
  applicability + limitations), actively-searched contradictory evidence,
  honest unknowns, and a structured clinical-confidence score.
  `validateRecommendationCompleteness` rejects incomplete recommendations.
- **Future Care is now the clinical centerpiece**: the case panel's per-item
  detail renders the full dossier (existing design system); the DOCX report
  renders each recommendation as a standalone dossier and no longer carries a
  separate SoC/Clinical-Basis section — the Diagnoses section keeps only
  objective basis + relatedness.
- **Recommendation-centric literature** (`citationQuality.ts`): a management /
  office-visit recommendation can no longer cite a specific surgical or
  interventional trial (`isManagementService` + scope gate); the query chain
  now targets follow-up/frequency/necessity for such items, and
  neuromodulation/nerve-stimulation is captured as an interventional family.
  The sprint's flagship case is fixed: "pain management office visits" no longer
  retrieves lumbar fusion or peripheral-nerve-stimulation studies.
- Tests 176 → 187; tsc clean. Verified on seed data (report has zero
  "Standard of Care"/"Clinical Basis" sections; every recommendation renders a
  full dossier).

## 2026-07-12 — Clinical Evidence Sprint: citation quality

- **New `engine/citationQuality.ts`** (pure, 19 tests): hard compatibility gate
  (region/procedure-family-intersection/population), explicit relevance score
  (diagnosis, procedure, region, population, clinical question, outcome,
  evidence level, publication quality, recency) with stored reason/claim/
  limitations, 10-tier `EVIDENCE_HIERARCHY` + `selectPrimary` (strongest is
  always primary), `structuredConfidence` (High/Moderate/Low/Indeterminate),
  and `validateEvidenceQuality` (incompatible citation = Critical/blocking;
  weak-primary and cross-region reuse = High).
- **Enforced at selection time**: `enrichCitations` and the SoC guideline
  selector now gate every candidate and store the relevance record; keyword-
  only matches are rejected before storage, so no article is reused across
  incompatible diagnoses.
- **Honest SoC posture**: every conclusion carries strength / limitations /
  unknowns / clinical confidence and states its own evidentiary weight —
  weak evidence is called weak.
- **Claim-based Evidence Explorer**: literature shown as "supports the claim …"
  with why-relevant, evidence level, and limitations; new supporting sections
  (objective findings, physician documentation, cost & coding) and a structured
  confidence badge. SoC panel shows per-guideline relevance + evidence posture.
- **Validation service** now also runs the evidence-quality checks.
- Surfaced & fixed real seed-data mismatches (medication regex false-positives
  on "non-pharmacological" / "medication-overuse headache"; combined
  decompression/fusion service); added occipital-nerve/Botox CPTs. No schema
  change (relevance rides in existing JSON). Tests 157 → 176.

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
