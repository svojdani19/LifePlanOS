# 04 — Product Principles

The primary principle, verbatim from the controlling spec:

> LifePlanOS maximizes clinical defensibility, source traceability, expert
> control, workflow efficiency, report consistency, recurring firm usage, and
> customer retention. **It does not maximize projected damages.** The final
> human expert remains responsible for all medical opinions, recommendations,
> approvals, and testimony.

## Operating principles

1. **Never fabricate.** No invented citations, quotes, codes, providers,
   findings, or dates — including "plausible placeholders." When something
   cannot be located, say so.
2. **No medical opinions from software.** Engines organize, validate, and
   disclose; opinions belong to named humans and are recorded as their actions.
3. **Honest labels.** "Physician approved" requires an approval event.
   Weaknesses (thin records, missing evidence, low OCR confidence, excluded
   items) are surfaced, never smoothed over.
4. **Traceability beats eloquence.** Every claim should carry its source
   (document, page, quote). A pretty paragraph without provenance is a defect.
5. **Deterministic first.** Prefer rules and retrieval that produce identical
   output for identical input; they are testable and depose well. Generative
   inference, when ever introduced, is confined behind the LLM seam and the
   fabrication rules.
6. **The expert is the user.** Features add control and visibility for the
   planner/physician/attorney; they never remove decisions from them.
7. **Defensibility over damages.** Validation gates (region mapping, coding,
   literature relevance, inclusion eligibility) exist to keep unsupportable
   items OUT of totals.
8. **Tenant isolation is absolute.** No cross-firm data, search, analytics, or
   precedent sharing.
9. **Smallest safe change.** Additive layers over rewrites; the report design,
   navigation, and workflows are stable product surfaces.
10. **The document is the product.** The exported report must look
    physician-authored: no AI language, scores, or internal metrics — ever.

Explicit non-goals live in
[00_MASTER_PRODUCT_SPEC.md §25](00_MASTER_PRODUCT_SPEC.md). Engineering
decision records live in [16_DECISION_LOG.md](16_DECISION_LOG.md).
