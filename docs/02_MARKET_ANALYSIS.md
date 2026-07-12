# 02 — Market Analysis

> Qualitative positioning document. It deliberately contains **no invented
> market statistics**; where sizing or pricing benchmarks are needed for
> fundraising or sales material, insert firm-validated figures and cite them.

## Buyer segments

1. **Life-care-planning practices** (solo CLCP → multi-planner firms). Buy for
   throughput and consistency; the planner is the daily user.
2. **Physician expert-witness practices.** Buy for the physician-grade report
   and the review workflow; the physician is reviewer and signer.
3. **Law firms (plaintiff and defense) with in-house planning staff.** Buy for
   damages visibility, version control, and deposition-ready traceability.
4. **IME / peer-review organizations.** Buy for the neutral template and audit
   trail.

## What buyers use today (the real competition)

- **Manual assembly** — Word templates, Excel cost tables, Adobe for records.
  The dominant "competitor." Strength: total control. Weakness: weeks per case,
  inconsistency, transcription errors, no validation.
- **Medical-record review services** (outsourced chronologies). Strength: labor
  relief. Weakness: no integration with care planning or pricing; quality
  varies; PHI leaves the firm.
- **Generic legal-medical software** (record viewers, chronology tools).
  Strength: mature viewers. Weakness: stop at the chronology; no future-care,
  pricing, physician-review, or LCP report engine.
- **Point tools for cost data** (fee-schedule lookups, UCR databases). Used
  alongside, not instead of, LifePlanOS pricing references.

## Positioning

LifePlanOS is the only workflow that runs **records → validated plan → signed
report** in one tenant-isolated system, with a deterministic integrity check
standing between draft and final. We do not sell "AI-generated plans"; we sell
**defensibility per hour** and expert control.

## Moats (in order of durability)

1. Clinical-validation ruleset (region mapping, coding, literature relevance) —
   compounding, testable domain IP.
2. The physician-voice report engine and its litigation formatting.
3. Firm precedent libraries and audit history (switching cost).
4. Workflow breadth (no assembly seams between modules).

## Pricing frame (current)

Seat + active-case tiers: `SOLO`, `SMALL_FIRM`, `ENTERPRISE` (negotiated
limits). Metered signals recorded per firm (`UsageRecord`): cases created, OCR
pages, generations, exports, active seats.

## Risks

- **Trust threshold**: one fabricated-looking citation would be fatal — hence
  the never-fabricate rules in [04_PRODUCT_PRINCIPLES.md](04_PRODUCT_PRINCIPLES.md).
- **Expert-market conservatism**: adoption follows referenceable experts;
  early-customer success is the marketing.
- **Admissibility scrutiny**: the methodology appendix and deterministic
  pipeline are designed to survive Daubert-style challenges; keep them so.
