# EPIC-001 — Recommendation Integrity Engine

**Status:** Partially shipped (Priority 1) · versioning portion formalized as
P2.R1

## Problem
A polished report must never contain medically mismatched, miscoded,
unsupported, or mislabeled recommendations — those are the exact defects
opposing counsel hunts for.

## Business value
Defensibility is the product's core promise (see
[../01_PRODUCT_VISION.md](../01_PRODUCT_VISION.md)); this epic is its engine.

## Shipped (2026-07-11/12)
- Deterministic validation layer (`src/lib/engine/integrity.ts`): body-region
  diagnosis mapping, CPT/HCPCS + pricing validation, literature relevance gate,
  honest physician labels, inclusion-in-totals gating.
- Persisted findings (`ValidationFinding`) + `/api/cases/:id/validation` +
  Plan Integrity Check card; DRAFT watermark on critical findings.
- 29+ unit tests; rules documented in
  [../09_CLINICAL_RULES.md](../09_CLINICAL_RULES.md).

## Remaining scope
- **P2.R1 Recommendation versioning** (binding requirement — see
  [../15_PRODUCT_ROADMAP.md](../15_PRODUCT_ROADMAP.md)): supersede-not-delete,
  stable lineage, material-change re-review, audit events, preservation tests.
- Frequency/duration plausibility rules (ATD-4: narrow deterministic bounds).
- CPT reference growth under coder review.

## Acceptance criteria (remaining)
Per P2.R1 §5 and [../14_TESTING.md](../14_TESTING.md) "Required additions."
