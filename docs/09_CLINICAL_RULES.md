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

## 4. Literature relevance (Clinical Evidence Sprint)
Implemented in `src/lib/engine/citationQuality.ts` (pure, unit-tested); applied
at citation SELECTION time in both `enrichCitations` and the Standard-of-Care
guideline selector, and re-checked by the validation service.
- **Hard compatibility gate** (`citationCompatible`) — before an article may be
  stored or displayed it must match on: body region (a knee arthroplasty paper
  can never appear under lumbar fusion; rotator cuff never under THA),
  procedure family (families must intersect; a combined service like
  "decompression / fusion" spans both), and population (pediatric/congenital
  literature cannot support an adult recommendation). Keyword overlap alone
  never qualifies an article.
- **Explicit relevance score** (`evaluateArticle`, 0–100) from diagnosis,
  procedure, region, population, clinical-question, and outcome relevance plus
  evidence level, publication quality, and recency. Acceptance requires the
  gate PLUS diagnosis-or-procedure anchoring PLUS a threshold — and stores the
  reason selected, the claim supported, and limitations.
- **Evidence hierarchy** (10 tiers, `EVIDENCE_HIERARCHY`): clinical guideline >
  consensus statement > systematic review > meta-analysis > RCT > large
  prospective > registry > cohort > case series > case report. `selectPrimary`
  guarantees the strongest evidence held is the primary citation; a weak
  primary while stronger exists is a validation finding.
- **No automatic reuse**: an article appears under a second recommendation only
  if it independently passes that recommendation's own gate. Cross-region reuse
  is a validation finding.
- No accepted literature ⇒ the analysis says support is limited; it never pads.

## 4a. Evidence transparency & confidence
- Every stored citation carries `relevance { score, evidenceLevel,
  evidenceLabel, whyRelevant, supports, limitations }`; the Evidence Explorer
  and SoC panel render these claim-first (what claim it supports, why, limits).
- Every SoC conclusion carries an honest `evidence { strength, limitations,
  unknowns, confidence, confidenceFactors }` and states its own weight in the
  rationale — weak evidence is called weak; nothing is overstated.
- Structured confidence (`structuredConfidence`) → High / Moderate / Low /
  Indeterminate from record quality, objective findings, physician support,
  guideline support, literature quality, contradictions, and missing info.

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

## 7. No Standard-of-Care module (Refactor Sprint)
LifePlanOS is an evidence-based life-care-planning platform, NOT a malpractice
platform. There is no user-facing Standard-of-Care workflow, tab, report
section, or export. The engine's guideline retrieval is retained as an internal
service feeding each recommendation's dossier. Every future-care recommendation
instead stands alone via the Medical Necessity & Clinical Evidence engine
(`medicalNecessity.ts`): medical-necessity narrative (physician voice; never a
diagnosis restatement), structured probability with a percentage, potential
challenges (what opposing experts could question), organized source-traceable
supporting evidence, actively-searched contradictory evidence, honest unknowns,
gated literature, and a structured clinical-confidence score. Met/departed/
negligence language is never generated.

## 7a. Recommendation-centric literature
Literature must support the RECOMMENDATION, not merely share a diagnosis. A
management / office-visit / monitoring recommendation (no procedure of its own)
cannot cite a study of a specific surgical or interventional procedure — pain-
management office visits draw on follow-up/frequency/necessity literature, never
a lumbar fusion or nerve-stimulation trial (`isManagementService` +
`citationCompatible` scope gate).

## 7b. Recommendation completeness
`validateRecommendationCompleteness` rejects a recommendation lacking a
supporting diagnosis (Critical/blocking), objective evidence (Moderate), or a
medical-necessity rationale (Moderate).

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
deterministic first — see decision ATD-4 in [16_DECISION_LOG.md](16_DECISION_LOG.md)).
