# LifePlanOS — Master Product Specification

> **This is the controlling specification for all future development work**
> (human or AI-assisted). When a task conflicts with this document, stop and
> resolve the conflict explicitly before writing code. Companion documents:
> [ARCHITECTURE.md](ARCHITECTURE.md) · [DATA_MODEL.md](DATA_MODEL.md) ·
> [AI_PIPELINE.md](AI_PIPELINE.md) · [REPORT_ENGINE.md](REPORT_ENGINE.md) ·
> [SECURITY_AND_PHI.md](SECURITY_AND_PHI.md) · [ROADMAP.md](ROADMAP.md) ·
> [CHANGELOG.md](CHANGELOG.md)

---

## 1. Product Vision

LifePlanOS is the operating system for life care planning: a multi-tenant SaaS
that helps certified life care planners, physician reviewers, and attorneys
produce **evidence-supported, litigation-grade life care plans** faster and more
defensibly than manual workflows.

The product maximizes:

- clinical defensibility
- source traceability
- expert control
- workflow efficiency
- report consistency
- recurring firm usage and retention

It does **not** maximize projected damages. Every number in a finished plan must
be supportable at deposition. The final human expert remains responsible for all
medical opinions, recommendations, approvals, and testimony — the software
prepares, organizes, validates, and formats; it never renders a medical opinion
of its own.

## 2. Intended Customers

- **Life-care-planning practices** (solo CLCPs to multi-planner firms)
- **Physician expert-witness practices** producing LCPs and medical cost
  projections
- **Law firms** (plaintiff and defense) with in-house planning staff
- **IME / peer-review organizations** (neutral evaluations)

Plans: `SOLO`, `SMALL_FIRM`, `ENTERPRISE` (seat and active-case limits per plan;
Stripe billing with a mock mode for development).

## 3. User Roles

| Role | Purpose | Key permissions |
|---|---|---|
| `ADMIN` | Firm owner | everything, incl. billing, team, settings, audit |
| `PLANNER` | Life care planner | case authoring end-to-end, export, precedents |
| `PHYSICIAN_REVIEWER` | Medical sign-off | view, physician.review, export |
| `ATTORNEY_REVIEWER` | Counsel review | view, export |
| `PARALEGAL` | Intake/records | case create/edit, uploads, chronology |
| `BILLING_USER` | Billing only | billing.manage |

The permission matrix lives in `src/lib/rbac.ts` and is enforced server-side by
the tenant guard on every route. UI hides what a role cannot do, but the server
check is authoritative.

## 4. Core Workflows

1. **Intake** — demographics, incident, diagnoses (ICD-10 search), pre-existing
   conditions, specialties, jurisdiction, economic assumptions.
2. **Records** — upload PDFs; OCR when needed; auto-classification; per-record
   provider/date/facility metadata; consolidated charts split by encounter.
3. **Generate** — deterministic pipeline builds chronology, causation map
   (conditions with page-cited evidence), future-care items, costs, review
   findings, standard-of-care guidance, literature citations, and persisted
   validation findings.
4. **Review** — planner curates; physician approves/rejects/modifies each item
   (medical-necessity note, probability/frequency adjustments); reviewer inputs
   feed back into the analysis.
5. **Export** — physician-voice DOCX Life Care Plan + CSV cost schedule;
   versioned export history; integrity check gates finalization (critical
   findings ⇒ DRAFT watermark).

Case stages: `INTAKE → RECORDS → CHRONOLOGY → CAUSATION → FUTURE_CARE →
PRICING → DRAFTING → PHYSICIAN_REVIEW → FINAL → CLOSED/ARCHIVED`.

## 5. Functional Modules

| Module | Code |
|---|---|
| Firm/subscription/seats | `src/lib/subscription/`, `src/app/api/billing/` |
| Auth + MFA + invites | `src/lib/auth/` |
| Tenant guard + audit | `src/lib/tenant.ts` |
| Document ingestion + OCR | `src/lib/documents/` |
| Chronology | `src/lib/engine/chronology.ts` |
| Causation / evidence locator | `src/lib/engine/evidence.ts` |
| Future care templates | `src/lib/engine/careLibrary.ts`, `specialty.ts` |
| Cost projection | `src/lib/engine/cost.ts` |
| Standard-of-care guidance | `src/lib/engine/standardOfCare.ts` |
| Literature retrieval | `src/lib/literature/` |
| Integrity validation | `src/lib/engine/integrity.ts`, `validation.ts` |
| Report generation | `src/lib/export/report.ts` |
| Precedent library | `src/lib/precedents/` |
| Case workspace UI | `src/components/case/CaseWorkspace.tsx` |

## 6. Current Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md). Summary: single Next.js 14 App Router
app; API route handlers under `src/app/api/**`; deterministic engines in
`src/lib/engine/**`; Prisma → PostgreSQL in an isolated `lifeplanos` schema;
object storage S3 (SSE-KMS) or local dev fallback; Vitest unit suites.

## 7. Data Model

See [DATA_MODEL.md](DATA_MODEL.md). The **Case** is the root aggregate; every
clinical artifact (documents, chronology events, conditions, future-care items,
review findings, SoC inputs, validation findings, report exports) is a child of
exactly one Case, and every tenant-owned row carries `firmId`.

## 8. Tenant Isolation Rules

- All identity resolution goes through `requireApiContext()` /
  `requireContext()` (`src/lib/tenant.ts`). **Never trust a client-sent firmId.**
- Every case access goes through `requireCase(ctx, caseId)`, which scopes by
  `ctx.firm.id`. Cross-tenant ids are indistinguishable from missing (404).
- Every new API route under `/api/cases/[caseId]/` **must** call
  `requireApiContext()` and `requireCase()` — enforced by the conformance test
  in `src/lib/security/tenantIsolation.test.ts`.
- PHI files are streamed through authenticated routes; never served statically.

## 9. PHI / Security Requirements

See [SECURITY_AND_PHI.md](SECURITY_AND_PHI.md). Non-negotiables: hashed session
tokens, TOTP MFA support, firm-scoped queries, audited mutations, S3 server-side
encryption, no PHI/secrets in logs or documentation, uploads dir gitignored.

## 10. AI Responsibilities

The "AI" pipeline is **deterministic**: rules + retrieval, no generative model
in the clinical path (an LLM abstraction exists at `src/lib/llm/` with a
deterministic mock; any future provider must go through it). The pipeline may:

- extract, organize, classify, and cite what is **in the records**
- locate **real** literature and quote it verbatim
- propose template-derived future-care items mapped to documented diagnoses
- compute costs from stated assumptions
- validate its own output and disclose weaknesses

It may never: fabricate citations, quotes, codes, or findings; render a medical
opinion; mark anything physician-approved; or hide a limitation.

## 11. Human-Review Requirements

- Every future-care item is reviewable by a `PHYSICIAN_REVIEWER`
  (approve / reject / modify with probability & frequency adjustments + note).
- Review actions are audited (`physician.review`) and refresh the persisted
  validation findings.
- The report never states physician approval without a recorded approval
  action; pending items are labeled "awaiting physician review."

## 12. Recommendation Lifecycle

Current statuses (`PhysicianStatus`): `PENDING → APPROVED | MODIFIED | REJECTED`.
Presentation labels derive honestly from state (`reviewLabel()` in
`integrity.ts`). A richer 12-state lifecycle (AI Draft → … → Locked for Export →
Superseded) with a transition ledger is planned — see Phase 6 in
[ROADMAP.md](ROADMAP.md). Regeneration must not destroy review history
(approved design decision: reviewed items are superseded, not deleted).

## 13. Evidence Requirements

- Conditions carry `evidenceSources` — document, page, verbatim quote — located
  deterministically (`engine/evidence.ts`).
- Chronology events carry source document + page and labeled clinical sections.
- Future-care items link to a region-matched condition (never blindly the
  primary diagnosis) and carry real literature citations or an honest
  "direct literature support is limited."
- The report's Appendix D traces every recommendation to diagnosis, records,
  literature, and cost basis.

## 14. Physician-Approval Rules

- Only `PHYSICIAN_REVIEWER` (or ADMIN) may perform review actions
  (`physician.review` permission).
- "Physician approved" / "approved with modification" labels require a recorded
  action; "Supported in treating record; awaiting physician review" is the
  strongest label an unreviewed item may carry.
- Once review has begun, only APPROVED/MODIFIED items (that also pass
  integrity) enter final totals.

## 15. Cost-Engine Rules

- `project()` (`engine/cost.ts`): unit × geographic factor → annual → year-by-
  year medical inflation → present-value discount; fractional final year
  prorated; low/expected/high bands (0.85 / 1.0 / 1.25).
- Assumptions (life expectancy, discount, inflation, geographic factor) are
  case-level, disclosed in the report, and sensitivity-analyzed.
- Determinism is tested (`cost.test.ts`), including hand-computed regression
  values.
- Bundled (non-code-specific) categories must disclose "bundled estimate" in
  the pricing source.

## 16. Literature-Validation Rules

- Sources: Europe PMC + Crossref (+ Semantic Scholar with key), merged and
  de-duplicated; **only real, resolvable records**.
- Report-time relevance gate (`evaluateCitation`): diagnosis/region match
  required; population mismatch (pediatric/congenital vs. adult injury)
  rejected; case reports demoted unless the condition is rare; threshold ≥ 50.
- Evidence hierarchy: guideline > systematic review/meta-analysis >
  cohort/registry > RCT > specialty review > case series > case report.
- When nothing survives the gate, the report says literature support is
  limited — it never pads with weak citations.

## 17. Report-Generation Rules

See [REPORT_ENGINE.md](REPORT_ENGINE.md). Locked design: Garamond serif, navy
`#1F3864` headers, running header/footer, classic medicolegal section flow,
first-person physician voice. Content rules: integrity-gated totals; honest
review counts; "Clinical Basis and Future-Care Relevance" (no standard-of-care
negligence language in the ordinary LCP); qualitative apportionment unless a
quantitative method is shown; DRAFT watermark whenever a critical validation
finding is unresolved; no AI/score/internal-metric language ever.

## 18. Audit & Version-Control Rules

- Every mutating route writes an `AuditLog` row (actor, action, target, ip/UA).
- Report exports are versioned (`ReportExport.version`) with totals and the
  stored artifact.
- Validation findings are persisted per case and refreshed on generate, review,
  and export.
- Planned: case snapshots + version diff (Roadmap P3).

## 19. Error-Handling Standards

- API: `handleError()` maps `TenantError` to its status; zod validation errors
  → 400; unknown errors → 500 without leaking internals.
- Engines are best-effort and never fabricate on failure (e.g. literature
  offline ⇒ honest "lookup unavailable" state, never invented citations).
- Long-running work (OCR) reports progress and tolerates partial failure.

## 20. UX Principles

- One case workspace with tabbed panels (overview → report) mirroring the
  workflow; no separate navigation paradigms.
- Show provenance next to every claim (page citations, quoted evidence).
- Surface weaknesses honestly (validation findings, missing records, gaps).
- Keep physician/attorney views scoped to what their role needs.

## 21. Testing Requirements

- Pure engines get unit tests (no DB/network) — Vitest, `src/**/*.test.ts`.
- Clinical-integrity invariants (region mapping, coding, pricing, literature
  relevance, inclusion gating, honest labels) are pinned in
  `engine/integrity.test.ts`.
- Financial reproducibility pinned in `engine/cost.test.ts`.
- Tenant isolation pinned in `security/tenantIsolation.test.ts` (behavioral +
  route conformance).
- A change is not done until `npx tsc --noEmit` is clean and `npm test` passes.

## 22. Definition of Done

1. Typecheck clean, all tests green (including new tests for the change).
2. No design/branding/report-style drift unless explicitly approved.
3. Tenant guard + audit on any new route; no PHI in logs.
4. Deterministic engines stay deterministic (no clock/randomness in logic).
5. CHANGELOG.md updated; schema changes documented in DATA_MODEL.md with a
   migration in `prisma/migrations/`.
6. Verified against seeded demo data end-to-end where observable.

## 23. Feature Roadmap

See [ROADMAP.md](ROADMAP.md) (priorities P1–P4 with status).

## 24. Known Limitations

- Care recommendations are template-driven (`careLibrary.ts`); diagnoses
  outside the library fall back to specialty packs (generic). Frequency/duration
  plausibility is not yet validated.
- The CPT reference in `integrity.ts` is intentionally compact (~70 codes);
  codes outside it get a non-blocking "Requires review."
- `PhysicianStatus` is 4-state; the full 12-state lifecycle is roadmap work.
- Regeneration recreates conditions/items (review history on items is lost
  today; fix approved for lifecycle work).
- No case snapshots/diff yet; version history is export-level.
- No PDF export (DOCX + CSV only); converter decision pending.
- Evidence relationships live partly in JSON columns; the join-table evidence
  graph is roadmap P2.
- Record-support fallback uses `confidence ≥ 60 && no missing-support` when a
  condition lacks explicit evidence; a stricter evidence-only rule is desirable.
- OCR quality on poor scans caps at ~80–90% confidence; low-confidence pages are
  flagged, not silently trusted.

## 25. Explicit Non-Goals

- **No damages maximization.** The product optimizes defensibility, not totals.
- **No autonomous medical opinions** or auto-approval of recommendations.
- **No fabricated literature, codes, quotes, or providers** — ever, including
  "plausible" placeholders.
- **No hidden chain-of-thought** in user-facing output; explanations are
  source-backed.
- **No standard-of-care negligence opinions** in the ordinary LCP (reserved for
  a separate, explicitly enabled malpractice module).
- **No cross-tenant anything** — data, search, analytics, or precedents.
- **No EHR write-back**; LifePlanOS consumes records, it does not author them.
