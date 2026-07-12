# LifePlanOS — Roadmap

Implementation proceeds in priorities. After each priority: run tests,
summarize changes, document schema changes, update CHANGELOG.md, list
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

## Priority 2 — Evidence graph & lifecycle (approved design notes)

- [ ] `EvidenceLink` join model populated at generation from existing
      evidenceSources/citations/mappings (no new extraction)
- [ ] Evidence Explorer panel inside the existing case workspace (existing
      design system; source-backed explanations only — why the item exists,
      supporting/weakening evidence, unknowns, approvals still required)
- [ ] Recommendation lifecycle: additive `lifecycleStatus` (12 states) +
      `RecommendationTransition` ledger (user, role, timestamps, prior/new,
      comment, modified fields, case version)
- [ ] **Regeneration must supersede, not delete, reviewed items** (approved)
- [ ] Functional-evidence refinements

## Priority 3 — Explanation & comparison

- [ ] Cost Explorer (per-item assumption breakdown; `AssumptionChange` ledger
      with original/revised/user/timestamp/reason)
- [ ] `CaseSnapshot` on export + version-comparison view (records, chronology,
      diagnoses, recommendations, codes, pricing, literature, review status,
      totals, assumptions)
- [ ] Physician review view (queue, evidence, attestation)
- [ ] Attorney review view (damages, drivers, approved vs pending, weaknesses,
      version changes)

## Priority 4 — Firm operations

- [ ] Firm-admin analytics (cases by stage, productivity, turnaround, seats,
      usage, pending approvals, audit)
- [ ] Performance work (large-case pagination, OCR throughput)
- [ ] Enterprise integrations; PDF export decision (DOCX→PDF converter)
- [ ] Object-storage GC on deletion; retention policies; auth rate limiting

## Standing constraints

No branding/design/report-style changes; no navigation changes; smallest safe
additive diffs; every phase gated by tests and the Definition of Done in
[MASTER_PRODUCT_SPEC.md](MASTER_PRODUCT_SPEC.md).
