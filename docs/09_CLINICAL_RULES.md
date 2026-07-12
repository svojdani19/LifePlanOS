# 09 — Clinical Rules

The deterministic rules that keep a plan clinically coherent. Implementation:
`src/lib/engine/integrity.ts` (pure, unit-tested in `integrity.test.ts`);
persistence: `engine/validation.ts` → `ValidationFinding`.

## 1. Diagnosis ↔ recommendation mapping
- Every recommendation maps by **body region** (knee, hip, shoulder, spine,
  ankle/foot, wrist/hand, elbow, brain/head, genitourinary, psych) derived from
  its service text + specialty; region-specific care must match a documented
  injury-related diagnosis in that region.
- Region-agnostic care (case management, generic labs, transportation) may map
  to any injury-related diagnosis without a mismatch.
- A region-specific recommendation with **no** diagnosis in its region is a
  **Critical** finding: excluded from totals, blocks final export.

## 2. Coding (CPT/HCPCS)
- Codes are validated against a curated reference (region + procedure kind).
  Wrong-region codes (knee arthroplasty code on a spine procedure) and
  modality conflicts (EMG billed as MRI) are **Critical**.
- Injection approach matters: transforaminal (64483/64484) vs. interlaminar
  (62321/62323) mismatches are **Critical**.
- Unknown-but-plausible codes get a non-blocking "Requires review" — the
  reference grows only under coder review; the system never invents codes.
- A costed service with no code is acceptable **only** when its pricing basis
  discloses a bundled/non-code-specific estimate.

## 3. Pricing
- Pricing labels must match the service's modality/region (no MRI benchmarks on
  electrodiagnostics — **Critical**).
- Bundled categories (attendant care, medications, supplies, home mods) must
  say "bundled estimate" in the pricing source.

## 4. Literature relevance
- A citation may support a recommendation only if it addresses the diagnosis/
  region (required), matches the population (pediatric/congenital literature is
  rejected for adult injury cases), and clears the relevance threshold.
- Evidence hierarchy: guideline > systematic review/meta-analysis >
  cohort/registry > RCT > specialty review > case series > case report (case
  reports only for rare conditions).
- No relevant literature ⇒ the report says support is limited; it never pads.

## 5. Inclusion in totals
An item enters the damages total only when ALL hold:
1. region-matched supporting diagnosis;
2. no critical coding/pricing defect;
3. physician-approved (APPROVED/MODIFIED) **or** record-supported AND
   medically probable (more likely than not).
"Offered for physician confirmation" is never sufficient by itself.

## 6. Honest review labels
`reviewLabel()` wording is mandatory: "Physician approved (with modification)"
only after a recorded action; otherwise "Supported in treating record; awaiting
physician review" / "Proposed by planner; awaiting physician review."

## 7. Standard-of-care boundary
The ordinary LCP discusses **Clinical Basis and Future-Care Relevance** only —
documented diagnosis, objective findings, natural history, guideline support
for future care. Met/departed/negligence language is prohibited outside the
separate, explicitly enabled malpractice module.

## 8. Apportionment
No blanket "apportioned out" claims. Either a quantitative method is shown
(percentage/amount, basis, affected items, reviewer approval) or the report
uses qualitative consideration language.

## 9. Functional evidence
Specific documented findings (device use, tolerances, deficits) are carried
into the Functional Assessment verbatim-ish (never replaced by generic
"impairment documented"); gaps get the domain-appropriate evaluation (FCE,
OT/home, neuropsych, psych, driving, urology, PT gait) — not a blanket FCE.

## 10. Severity & export
Findings grade Critical / High / Moderate / Low. Any unresolved Critical ⇒
report exports with a visible DRAFT watermark and the finding table
(Appendix F). Roadmap: frequency/duration plausibility rules (narrow,
deterministic first — see decision ATD-4 in
[13_DEVELOPER_STANDARDS.md](13_DEVELOPER_STANDARDS.md)).
