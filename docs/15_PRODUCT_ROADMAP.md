# LifePlanOS — Roadmap

Implementation proceeds in priorities. After each priority: run tests,
summarize changes, document schema changes, update 17_CHANGELOG.md, list
unresolved issues, and **stop for approval**.

## Priority 1 — Correctness & source of truth ✅ (2026-07-12)

- [x] Deterministic integrity layer: diagnosis/region mapping, CPT/HCPCS &
      pricing validation, literature relevance gate, honest physician labels,
      inclusion gating, export blocking + DRAFT (2026-07-11, `482ede8`)
- [x] Documentation set (`docs/`) as the controlling spec
- [x] Persisted `ValidationFinding` + validation service + API
      (`/api/cases/:id/validation`) + Plan Integrity Check card in the Report
      tab
- [x] Tenant-isolation tests (behavioral + route conformance)
- [x] Financial reproducibility tests (deterministic PV, hand-computed
      inflation/discount regression, fractional years)

## Priority 2 — Evidence graph & lifecycle ✅ (2026-07-12)

- [x] `EvidenceLink` join model populated at generation from existing
      evidenceSources/citations/mappings (no new extraction)
- [x] Evidence Explorer panel inside the existing case workspace (existing
      design system; source-backed explanations only — why the item exists,
      supporting/weakening evidence, unknowns, approvals still required)
- [x] Recommendation lifecycle: additive `lifecycleStatus` (12 states) +
      `RecommendationTransition` ledger (user, role, timestamps, prior/new,
      comment, modified fields, case version)
- [x] **P2.R1 Recommendation versioning** — implemented per the formal
      requirement below (supersede-not-delete, lineage, material-change
      invalidation, audit events, preservation tests)
- [~] Functional-evidence refinements (baseline shipped in P1; further
      refinement folds into EPIC-005)

### P2.R1 — Recommendation versioning (FORMAL REQUIREMENT, binding)

Accepted 2026-07-12 (decision ATD-5). Governs all Priority-2 lifecycle work.

1. **No destruction of reviewed work.** Plan regeneration must never delete a
   recommendation that has review history (any planner, physician, or attorney
   action). Such recommendations are **superseded**, never overwritten or
   deleted; all recorded review actions are preserved verbatim.
2. **Stable lineage.** A regenerated or edited recommendation is a **new
   version** linked to its predecessor by a stable lineage identifier
   (`lineageId` constant across versions; `supersededById` pointing forward).
   Any version can answer: what came before me, what replaced me, and why.
3. **Material vs. nonmaterial changes.**
   - *Material* changes — service identity, category, supporting diagnosis
     mapping, CPT/HCPCS, probability, frequency, duration/lifetime, unit cost
     or pricing basis — **invalidate prior approval**: the new version returns
     to the review queue, and the invalidation is recorded (who/what/when, the
     prior approval preserved on the superseded version).
   - *Nonmaterial* changes — wording/formatting of rationale or summary,
     display-only edits — **must not** invalidate an existing approval; the
     approval carries to the new version with a transition note.
   - The material-field list is code-defined and unit-tested, not ad-hoc.
4. **Audit events.** `recommendation.supersede` and
   `recommendation.approval_invalidated` audit events are written with actor,
   caseId, lineageId, prior/new version ids, and the changed-field list.
5. **Tests.** Automated tests must cover: regeneration preserving review
   history (superseded, not deleted); approval carrying across a nonmaterial
   change; a material change invalidating approval and recording the
   transition; lineage integrity (no orphaned or cyclic supersession).
6. **Totals.** Only the current (non-superseded) version of a lineage is
   eligible for totals, subject to the existing inclusion rules
   ([09_CLINICAL_RULES.md §5](09_CLINICAL_RULES.md)).

Proposed schema for this requirement lives in
[06_DATABASE_SPEC.md](06_DATABASE_SPEC.md) § "Proposed schema — recommendation
lineage (P2.R1)".

## Priority 3 — Explanation & comparison ✅ (2026-07-12)

- [x] Cost Explorer (per-item assumption breakdown; `AssumptionChange` ledger
      with original/revised/user/timestamp/reason)
- [x] `CaseSnapshot` on export + version-comparison view (records, chronology,
      diagnoses, recommendations, codes, pricing, literature, review status,
      totals, assumptions)
- [x] Physician review view (dashboard queue + existing Physician tab; full
      workspace = EPIC-005)
- [x] Attorney review view (dashboard damages posture; full workspace =
      EPIC-006)

## Priority 4 — Firm operations ✅ core items (2026-07-12)

- [x] Firm-admin analytics (cases by stage, seats, usage, pending approvals,
      audit — dashboard; productivity/turnaround metrics = EPIC-010)
- [ ] Performance work (large-case pagination, OCR throughput) — deferred
      until profiling shows need (ATD-2 spirit)
- [ ] Enterprise integrations — deferred (EPIC-007, needs full PRD)
- [x] PDF export decision recorded (ATD-7: DOCX remains canonical; PDF via
      converter when a customer requires it)
- [x] Object-storage GC on document deletion; auth rate limiting (per-IP +
      per-email)
- [ ] Retention policies (per-firm) — open

## Standing constraints

No branding/design/report-style changes; no navigation changes; smallest safe
additive diffs; every phase gated by tests and the Definition of Done in
[00_MASTER_PRODUCT_SPEC.md](00_MASTER_PRODUCT_SPEC.md).
