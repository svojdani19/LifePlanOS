# 14 — Testing

## Philosophy

Tests exist to make the product's promises falsifiable: clinical coherence,
financial reproducibility, tenant isolation, and honest labeling are all pinned
by automated tests, not asserted. A change without tests for its promises is
not done ([13_DEVELOPER_STANDARDS.md](13_DEVELOPER_STANDARDS.md)).

## Framework & layout

- **Vitest**, colocated `src/**/*.test.ts`, node environment, **no DB or
  network** (vitest.config.ts enforces the pure-logic boundary; Prisma is
  mocked where a guard must be exercised).
- Run: `npm test` (all), `npx vitest run <file>` (one suite).
- Current baseline: 21 suites / 187 tests, all green, plus `npx tsc --noEmit`.

## What is pinned where

| Domain | Suite | Invariants |
|---|---|---|
| Medical necessity | `engine/medicalNecessity.test.ts` | per-recommendation dossier: necessity narrative (not a diagnosis restatement), organized traceable evidence, structured probability +%, contradictory evidence surfaced, unknowns, strongest-first literature, confidence; completeness validation |
| Citation quality | `engine/citationQuality.test.ts` | region/procedure/population gate (knee≠lumbar, rotator-cuff≠THA, pediatric≠adult); recommendation-centric scope (office visits ≠ fusion/nerve-stimulation trials); explicit relevance scoring; 10-tier hierarchy + strongest-as-primary; evidence-quality validation (incompatible/weak-primary/cross-region reuse); structured confidence |
| Clinical integrity | `engine/integrity.test.ts` | TKA→knee (never lumbar); spine revision ≠ 27487; EMG ≠ MRI pricing; transforaminal ≠ interlaminar codes; pediatric/congenital literature rejected for adult injury; case reports rejected for non-rare conditions; unsupported items excluded from totals; no "physician approved" without an approval event; rolling walker carried into the functional assessment; critical findings block export |
| Financial | `engine/cost.test.ts` | determinism (identical inputs ⇒ identical output); hand-computed inflation/discount regression; fractional final year; zero-duration edge; low/high bands |
| Tenancy | `security/tenantIsolation.test.ts` | cross-firm `requireCase` denial (mocked prisma); conformance scan — every `/api/cases/[caseId]/**` route must call `requireApiContext` + `requireCase` (PHI view/download included) |
| Records | `documents/recordSummary.test.ts`, `classify.test.ts`, `meta.test.ts` | consolidated-chart splitting, provider extraction (prose never becomes a provider), classification, metadata |
| Chronology / care | `engine/chronology.test.ts`, `careLibrary.test.ts`, `evidence.test.ts` | segmentation, template resolution, page-cited evidence |
| SoC | `engine/standardOfCare.test.ts` | verbatim-quote extraction, concept-vocabulary matching, rationale assembly |
| Auth / RBAC | `auth/totp.test.ts`, `rbac.test.ts` | TOTP, permission matrix |
| Intake / precedents | `intake/*.test.ts`, `precedents/match.test.ts` | parsing, suggestion, likeness match |

## Report (DOCX) verification pattern

Not unit-tested directly; verified by generation against seed data: unzip the
DOCX → strip XML to text → assert section flow, forbidden terms absent
(AI/score/vulnerability language), DRAFT watermark logic, and totals
consistency. See [10_REPORT_ENGINE.md](10_REPORT_ENGINE.md).

## Required additions per roadmap phase

- ~~P2.R1~~ shipped: `engine/lifecycle.test.ts` (12) pins supersede-not-delete,
  material vs nonmaterial invalidation, lineage integrity; plus a DB E2E.
- ~~P3~~ shipped: `engine/snapshot.test.ts` (5) pins the version differ.
- ~~Pilot gate~~ shipped: `auth/rateLimit.test.ts` (4); storage GC is
  best-effort I/O (verified manually, not unit-tested).

## Rules

1. New engine logic ⇒ new unit tests in the same commit.
2. A bug fix ⇒ a regression test that fails without the fix.
3. Tests never contain PHI, secrets, or live-network calls.
4. Deterministic fixtures only (no wall-clock/randomness).
