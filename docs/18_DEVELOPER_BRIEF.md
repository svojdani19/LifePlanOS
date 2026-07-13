# LifePlanOS — Developer Brief

A descriptive orientation for engineers joining the project to assist with refinement and
development. It describes what the program is, how it is built, how data flows through it,
and the conventions the codebase follows. Deeper detail lives in the numbered docs in this
folder (architecture `05`, database `06`, AI engine `07`, report engine `10`, standards `13`,
testing `14`, changelog `17`).

---

## 1. What the program is

LifePlanOS is a **multi-tenant SaaS for medical-legal life care planning**. Law firms and
life-care-planning practices upload a client's medical records; the system reads them,
builds a medical chronology, analyzes causation, projects the client's future medical needs
with costs, routes everything through physician review, and produces a formal, litigation-grade
**Life Care Plan** as a DOCX report. The plan states — to a reasonable degree of medical
probability — what care an injured person will need for the rest of their life and what it
will cost, with every assertion traceable to a page-cited medical record, a clinical
guideline, or published literature.

The defining engineering principle: **nothing clinical is fabricated**. Every narrative
sentence in the report renders from deterministic, unit-tested engines operating on evidence
actually present in the record. Where support is missing, the system says so explicitly
(unknowns, missing-evidence requests, contingencies excluded from totals) rather than
papering over it.

## 2. The domain workflow (what a user does)

1. **Intake** — create a case: client demographics, diagnosis (ICD-10 linked), case type
   (personal injury / med-mal / workers' comp), side (plaintiff / defense / neutral).
2. **Records** — upload medical charts (PDF, images). The ingest pipeline OCRs scanned
   pages, strips per-chart boilerplate ("chart furniture"), and segments large combined
   charts into sub-documents.
3. **AI pipeline** (one button: "Re-run AI Pipeline") — builds the chronology from records,
   extracts encounter data points, analyzes each condition's relatedness to the incident,
   generates future-care recommendations with CPT codes / frequencies / durations / costs,
   attaches literature citations, and computes cost projections (present value, inflation,
   discounting, geographic factor).
4. **Review** — the user works through the **Case Review Assistant** (a one-finding-at-a-time
   triage drawer), fixes findings in place via deep links, adjusts recommendations, and
   routes items to a physician reviewer for approve / modify / reject.
5. **Export** — generate the Life Care Plan DOCX (plaintiff / defense / neutral templates).
   Export-blocking findings (e.g., double-counted costs, incompatible citations) must be
   resolved first.

## 3. Technology stack

| Layer | Choice |
|---|---|
| Framework | Next.js 14, App Router, TypeScript strict |
| UI | React 18 client components, Tailwind CSS (brand/ink palette), lucide-react icons |
| Database | PostgreSQL (Neon), Prisma ORM — client generated to `src/generated/prisma` |
| Tests | Vitest (`npm test`) — currently 31 files / 307 tests, all pure-function unit tests |
| Auth | Custom session auth (httpOnly cookie), bcrypt, optional TOTP MFA, login rate limiting |
| Billing | Stripe (subscription tiers, webhook) |
| Reports | `docx` library — serif, navy-header litigation format |
| Dev | `npm run dev` on **port 3100**; seed via `npm run db:seed` (demo login `demo@lifeplanos.app` / `password123`) |

~85k lines of TypeScript. No external AI API is required at runtime today: the "engines" are
deterministic TypeScript. Provider seams exist (see §7) for cloud OCR and pricing APIs but
stay dormant until credentialed.

## 4. Architecture in one pass

```
Upload → src/lib/documents (OCR, furniture stripping, segmentation, encounter extraction)
      → src/lib/engine/chronology.ts        (records → dated, page-cited chronology events)
      → src/lib/engine/generate.ts          (pipeline orchestrator: conditions, future care,
                                             citations via src/lib/literature, costs)
      → src/lib/engine/* pure engines       (see §6 — necessity, integrity, reasoning, …)
      → persisted derived data              (ValidationFinding, AttentionItem,
                                             ClinicalReasoningAssessment, EvidenceLink)
      → UI (CaseWorkspace tabs + CaseAssistant drawer)
      → src/lib/export/report.ts            (DOCX renders FROM the engines' output)
```

- **`src/app/(app)/…`** — authenticated pages: dashboard, cases list, case detail, team,
  billing, firm settings, audit, account. The case detail page is one large client component,
  `src/components/case/CaseWorkspace.tsx` (tabs: Intake, Records, Chronology, Causation,
  Treating Providers, Evidence, Future Care, Costs), plus `CaseAssistant.tsx` (review drawer).
- **`src/app/api/…`** — REST route handlers. Everything case-scoped lives under
  `/api/cases/[caseId]/…`: `generate`, `chronology`, `future-care`, `evidence`, `validation`,
  `reasoning`, `attention`, `assistant/ask`, `interviews`, `providers`, `documents`,
  `snapshots`, `export`.
- **`src/lib/engine/…`** — the heart of the product (§6).
- **`src/lib/tenant.ts`** — the tenant guard every API route uses (§8).

## 5. Data model (Prisma, isolated `lifeplanos` schema)

Tenancy: `Firm` → `User` (roles: ADMIN, PLANNER, PHYSICIAN_REVIEWER, PARALEGAL, VIEWER) →
`Case`. Every case-scoped row carries `firmId` + `caseId` and cascades with the case.

Core clinical chain:

- **`Document`** — uploaded record, OCR status, storage key.
- **`ChronologyEvent`** — one dated encounter: provider, diagnosis, procedure, imaging
  findings, functional status, source document + page.
- **`Condition`** — a diagnosis with relatedness (RELATED / AGGRAVATION / PREEXISTING_UNRELATED /
  SUBSEQUENT_UNRELATED / UNCLEAR), confidence, supporting/opposing records, evidence sources.
- **`FutureCareItem`** — one recommendation: service, category, CPT, frequency/duration/
  lifetime, unit + lifetime + present-value costs, probability, physician status, staged /
  conditional metadata (`startTrigger`, `replacesService`, `contingencyOnly`), citations
  (JSON), supersession (`supersededAt` — only null rows are current).
- **`ClinicalReasoningAssessment`** — the structured "reason first, write second" object,
  one per current recommendation (§6, Clinical Reasoning Engine).
- Derived/workflow: `EvidenceLink` (evidence graph), `ValidationFinding` (integrity results),
  `AttentionItem` (assistant queue), `CaseSnapshot` (version compare), `AssumptionChange`
  (economic-assumption ledger), `ReportExport`, `AuditLog`, `TreatingProvider`,
  `InterviewFinding`, `UserCredential` (physician CV/licenses).

**Migration discipline** (no `prisma migrate dev` against the shared DB):
`npx prisma db push --skip-generate` → `npx prisma generate` → hand-author
`prisma/migrations/<timestamp>_<name>/migration.sql` (no schema prefix) →
`npx prisma migrate resolve --applied <name>`.

## 6. The deterministic engines (`src/lib/engine/`)

All pure (no I/O) unless noted; each has a matching `.test.ts`. This is where nearly all
domain logic lives, and where refinement work usually lands.

| Engine | Responsibility |
|---|---|
| `chronology.ts` | Build chronology from OCR'd records; extract encounter data points (vitals, findings, meds); reject metadata-lead noise. |
| `generate.ts` | Pipeline orchestrator (server): conditions → future care → citations → costs; supersede-on-regenerate preserves reviewed items. |
| `specialty.ts`, `careLibrary.ts`, `cost.ts` | Specialty inference, care-item templates, cost math (inflation, discounting, PV, geographic factor). |
| `integrity.ts` | Deterministic validation: map each recommendation to the right diagnosis by body region, validate CPT/pricing, decide inclusion in totals, per-item review labels. |
| `medicalNecessity.ts` | `buildRecommendationDossier` — the complete per-recommendation dossier: necessity narrative, structured probability, organized page-cited evidence buckets, literature, contradictory evidence, unknowns, structured confidence. |
| `citationQuality.ts` | 10-tier evidence hierarchy, citation-compatibility checks (region/procedure/population), structured confidence scoring, evidence-quality validation. |
| `recommendationConsistency.ts` | Cross-recommendation conflicts (mutually exclusive, sequential, duplicates) and how they were resolved. |
| `specialtyReasoning.ts` | Specialty "lens" so narratives read in the responsible specialty's voice. |
| `clinicalReasoning.ts` | **Clinical Reasoning Engine** — reason first, write second. Builds one structured `ClinicalReasoningAssessment` per recommendation: probability classification (PROBABLE_INCLUDED … REJECTED_BY_REVIEWER), clinical pathway, cross-item conflict flags, inclusion rationale, frequency-supported flag, duration class + rationale, literature synthesis, weakening evidence, missing-evidence requests, evidence strength (about the literature) kept distinct from recommendation confidence (about this patient), residual uncertainty, material-change hash. The report and workspace render FROM this object. `clinicalReasoningPersist.ts` is its DB wrapper (upsert by material hash, supersession). |
| `validation.ts` (server) | Aggregates integrity + evidence-quality + completeness + reasoning findings into persisted `ValidationFinding` rows; anything `exportBlocking` gates export. |
| `attention.ts` | Projects validation results into the Case Assistant queue (pipeline-ordered stages), reconciles with prior decisions, computes case readiness, answers grounded Q&A ("what blocks final export?"). |
| `evidence.ts` / `evidenceGraph.ts`, `lifecycle.ts`, `snapshot.ts`, `standardOfCare.ts`, `providerRoster.ts`, `confidence.ts` | Evidence graph population, recommendation lifecycle transitions, snapshot/version compare, guideline mapping, provider roster from records, confidence math. |

Supporting libraries: `src/lib/documents` (OCR via tesseract + image prep, furniture
stripping, chart segmentation), `src/lib/literature` (citation registry + relevance policy),
`src/lib/references` (professional source registry: ODG, FAIR Health, GoodRx, guidelines…),
`src/lib/icd10`, `src/lib/intake` (diagnosis suggestion, pre-existing detection),
`src/lib/export/report.ts` (~1,100-line DOCX builder).

## 7. Provider seams (dormant integrations)

Two pluggable seams exist for capabilities that require third-party credentials and a BAA
(medical data cannot be sent to a third party without one):

- **OCR** — `src/lib/documents/ocrProvider.ts`: local tesseract by default; a cloud
  medical-grade OCR activates only when `OCR_PROVIDER` + `OCR_BAA_ACK` env vars are set.
- **Pricing** — `src/lib/references/pricingProvider.ts`: benchmark tables by default; a
  live pricing API (e.g., FAIR Health) activates via `PRICING_PROVIDER` + credentials.

OCR quality on large scanned charts is the main ceiling on chronology quality today; the
seam is the intended upgrade path.

## 8. Cross-cutting conventions (follow these)

- **Tenant guard**: every API route starts with `requireApiContext()` →
  `requirePermission(ctx, "…")` → `requireCase(ctx, caseId)`, responds with
  `ok(data)` / `handleError(err)` from `src/lib/api.ts`, and writes `audit(ctx, action, …)`
  for meaningful mutations. RBAC lives in `src/lib/rbac.ts`.
- **Engines stay pure**: no `prisma` imports in a pure engine (client components import
  them directly — e.g., the workspace computes dossiers/assessments client-side). Server
  wrappers (`validation.ts`, `clinicalReasoningPersist.ts`) do the I/O.
- **Derived data is replaceable**: validation findings, attention items, and reasoning
  assessments are recomputed and upserted/replaced; never hand-edit them.
- **Deterministic narrative variation**: report prose varies phrasing per recommendation via
  an FNV-1a hash seed (`hashStr` + `variant(…)`) — reproducible for the same item, varied
  across items. No randomness anywhere (`Math.random`/`Date.now` avoided in engines).
- **Never fabricate clinical content**: if the record lacks support, the correct behavior
  is an explicit unknown / missing-evidence request / exclusion from totals.
- **Testing**: every engine change ships with unit tests; run `npm test` and
  `npx tsc --noEmit` before committing. The suite must stay green.
- **Git**: work on `main`, push after every commit (standing instruction), commit messages
  via `git commit -F <file>`.
- **Dev-server gotcha**: after schema or large component changes, the running `next dev`
  can hold a stale Prisma client / HMR bundle and throw misleading errors — restart the dev
  server (and occasionally `rm -rf .next && npx prisma generate`). Dev-only; never affects
  builds.

## 9. Current state and active surface

Shipped and green as of 2026-07-13 (see `17_CHANGELOG.md` for the full history): document
ingest with segmentation and furniture stripping, chronology + encounter extraction,
causation analysis, future-care generation with lifecycle + physician review, evidence
graph + Evidence Explorer, cost engine with assumption ledger and snapshots, professional
source registry, integrity/validation layer with export gating, Case Review Assistant
(single-finding triage with precise deep-links and section highlighting), the complete
Clinical Reasoning Engine (Phases A–E: structured per-recommendation assessments backing
the report narrative), and the physician-grade DOCX report with plaintiff/defense/neutral
templates.

Likely near-term refinement areas: OCR quality (activate the cloud seam), chronology
extraction coverage on messy charts, report narrative polish against exemplar plans,
pricing-source activation, and continued Case Assistant UX iteration.

## 10. Getting productive quickly

1. `npm install`, set `DATABASE_URL` (Neon Postgres), `npm run setup` (migrations + seed),
   `npm run dev` → http://localhost:3100, log in with the demo user.
2. Read `prisma/schema.prisma` top to bottom — the data model is the domain.
3. Read `src/lib/engine/medicalNecessity.ts` and `clinicalReasoning.ts` with their tests —
   they exemplify the house style: pure functions, evidence-first, honest about gaps.
4. Open a seeded case, run the pipeline, open the Case Review drawer, export the report —
   then trace one recommendation from chronology → condition → dossier → assessment →
   report paragraph. That single trace explains 80% of the system.
