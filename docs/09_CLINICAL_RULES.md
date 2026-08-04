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

## CRE v1 — reasoning gates (2026-07-14)

- **Condition definition (§3):** a recommendation never defaults to the first
  diagnosis; region mapping is enforced, and a laterality mismatch between the
  service and its diagnosis is a structural defect (assessment INVALID, finding
  raised, blocks final export when totaled).
- **Epistemic discipline (§4):** patient reports are never objective findings;
  physician approval is never treating-record support; literature is never
  patient-specific evidence.
- **Inclusion (§6):** an item enters totals only when probable, patient-supported,
  necessary, anatomically compatible, frequency- and duration-defensible, and
  cost-validated. Strong literature cannot rescue absent patient support.
- **Frequency (§7):** every frequency needs its own rationale; an unsupported
  frequency on a totaled line raises a HIGH finding that blocks FINAL export
  unless the reviewing physician has explicitly approved the item.
- **Duration (§8):** lifetime care requires stronger support than short-term;
  an unsupported lifetime line is HIGH, or CRITICAL when PV ≥ $100k.
  See "Lifetime is a projection horizon" below for what counts as support.
- **Literature (§12):** applicability outranks hierarchy — region, procedure
  family, scope (management vs procedural), and population (pediatric,
  pregnancy/obstetric) gates; rejections persist with reasons.
- **Export (§18):** final export blocks on unresolved critical defects; draft
  export is always available with a DRAFT watermark and an unresolved-issues
  appendix, and never advances the case to FINAL.

## Lifetime is a projection horizon, not clinical evidence (2026-08-03)

`isLifetime` instructs the cost engine which period to project over (period,
quantities, inflation/discounting, cost scenarios, display labels) — nothing
more. It is never evidence that a condition is chronic, permanent, or
progressive, and it never raises chronicity, trajectory, evidence sufficiency,
recommendation confidence, medical probability, record/provider support, or
validation status. Clinical conclusions flow evidence → projection, never
projection → clinical facts.

- **One duration-support authority.** `src/lib/engine/lifetimeSupport.ts`
  (`assessLifetimeSupport`) is the single deterministic verdict every engine
  consults (reasoning, dossier, findings, narratives). Statuses:
  `SUPPORTED_BY_RECORD` · `SUPPORTED_BY_GUIDELINE` ·
  `SUPPORTED_BY_PROFESSIONAL_OPINION` · `MULTIPLE_SUPPORTS` ·
  `ASSUMPTION_PENDING_REVIEW` · `INSUFFICIENT` (and `NOT_APPLICABLE` for
  non-lifetime items).
- **What counts as independent support:** explicit documented chronicity/
  permanence on the condition (anchored in the record), a source-linked
  prognosis quote, diagnosis-keyed clinical guidance carrying a VERIFIED
  duration claim (see below), or an ATTRIBUTED professional duration rationale
  (a note or interview opinion that actually speaks to duration). A generic
  objective finding (an MRI proving the injury) documents the injury, not the
  duration, and never counts.
- **Independent support vs. professional adoption are separate.** Physician
  approval of an item is professional ADOPTION under review policy: it lifts
  the finalized-totals/export block exactly as before, but it is never
  treating-record evidence, never converts a condition to documented-chronic,
  and never invents a prognosis. Insufficient evidence yields the honest value
  ("undetermined" chronicity/trajectory; projection-assumption narratives) —
  progression is never manufactured.
- **Unsupported lifetime scenarios remain calculated and disclosed.** They stay
  priced and visible per the existing contingency/inclusion rules, framed as
  "a remaining-lifetime scenario … shown as a projection assumption", and are
  never represented as established medical necessity — and never silently
  dropped. Supported scenarios name their independent basis.
- **The financial model stays deterministic.** `cost.ts` lifetime math is
  unchanged; identical financial inputs yield identical lifetime costs
  regardless of duration-support status.
- **Lifecycle:** the duration-support verdict (and any attributed professional
  duration rationale) feeds the assessment material fingerprint — a change
  supersedes the assessment version and invalidates prior approval per the
  existing lineage policy, with the duration-support field identified in the
  change set. A newly appearing contradictory-duration guideline also changes
  the fingerprint, even when the surviving bases are unchanged.

### Guideline duration claims (2026-08-04)

A guideline is evidence of MEDICAL NECESSITY. It never establishes a lifetime
duration merely because it matches the diagnosis/body region/intervention,
supports general medical necessity, or sits high on the evidence hierarchy.
`SUPPORTED_BY_GUIDELINE` requires a verified, structured duration claim on the
guideline entry (`GuidelineDurationClaim` in
`src/lib/engine/lifetimeSupport.ts`):

- **The claim shape:** `{ supportsDuration: boolean; durationClaim?; durationType?
  ("natural_history" | "chronic_recurrence" | "permanence" | "progressive_course" |
  "long_term_surveillance" | "indefinite_treatment" | "lifetime_replacement" |
  "continuing_utilization"); sourceId; sourceVersion?; quote?; applicability?;
  limitations?; serviceSpecific?; contradictsDuration? }`.
- **The gate:** a guideline counts toward duration ONLY when `supportsDuration`
  is true AND a `durationType` is present AND actual claim text exists
  (`durationClaim` or `quote`) AND the entry passed the upstream
  diagnosis/anatomy (condition-compatibility) gate AND — when `serviceSpecific`
  — the item's service matches the claim's stated `applicability`
  (`guidelineServiceMatches`: shared meaningful token, stopwords removed).
  The resulting basis is cited as `sourceId (sourceVersion)` with the claim
  text.
- **Construction-site derivation (never manufactured):** claims are built only
  in `deriveGuidelineDurationClaim` at the guideline-context construction site
  (`buildRecommendationDossier`): explicit per-entry `duration` metadata passes
  through when the stored source structures it; otherwise a conservative
  deterministic detector runs over the guidance TEXT (the stored quote) for
  duration-relevant language (natural history, permanen*, chronic recurrence,
  progressive/progression, lifelong / for life / indefinite, lifetime
  replacement / expected revision, long-term surveillance, continuing
  utilization). The TITLE alone is never sufficient, and an entry with no quote
  derives no claim. The matched sentence becomes `durationClaim`, the full
  quote is retained, and `sourceId`/`sourceVersion` come from the guideline
  title/year.
- **Contradiction policy:** guidance language contradicting a long/lifetime
  duration (self-limited, time-limited, "long-term … not recommended",
  no-evidence-for-long-term, should-be-discontinued) sets
  `contradictsDuration`. A self-contradicting entry never supports duration on
  its own text. When ANY contradicting guideline exists for the item, the
  conflict is always surfaced in `uncertaintyNotes`; guideline-based duration
  support is WITHDRAWN unless another independent non-guideline basis (record
  chronicity or an attributed professional duration opinion) stands — in that
  case the guideline basis is retained but the conflict remains disclosed for
  reconciliation at professional review.
- **Unchanged:** duration-silent guidelines keep supporting medical necessity,
  confidence, and probability exactly as before; professional adoption remains
  a separately labeled workflow fact (a bare approval is never guideline or
  record evidence), and attributed professional duration opinions remain their
  own basis kind.

## Attestation ↔ clinical-evidence binding (cfp-1)

An attestation signed today is bound to the EXACT clinical evidence reviewed,
via a versioned SHA-256 clinical fingerprint (`src/lib/engine/attestationBinding.ts`):

- **Per recommendation**, a canonical (recursively key-sorted, order-independent
  arrays) fingerprint covers: the item's identity/version and
  frequency/duration/lifetime; the current assessment's id, methodology version,
  lifecycle status, evidence-sufficiency verdict, and probability
  classification; the duration-support material (durationClass +
  durationRationale); classified evidence items, supporting quotations
  (document ids + page locators), contradicting evidence, and condition
  identity; referenced source-document content hashes; chronology events (ids +
  dates + description hashes); material interview findings; provider opinions
  (physician item note); literature/guideline identities; clinical assumptions;
  conflict flags; and material unknowns. Display-only text (narrative
  summaries, labels, physicianSummary) and financial fields (pinned by the
  existing scope contentHash) are excluded.
- **At signing**, per-item fingerprints are stored in the scope entries and an
  aggregate on `Attestation.clinicalFingerprint` with
  `bindingVersion = "cfp-1"`, plus the `opinionScopes` the statement actually
  covers (necessity + frequency/duration; never causation for the current
  statement). Existing rows are NEVER backfilled.
- **Verification fail-closes** with PHI-free codes: `ATTESTATION_UNVERSIONED`
  (legacy rows can never authorize a new final), `CLINICAL_FINGERPRINT_MISMATCH`,
  `ASSESSMENT_NEEDS_REVIEW`, `ASSESSMENT_INVALID`, `ASSESSMENT_SUPERSEDED`,
  `ASSESSMENT_MISSING`, `EVIDENCE_INSUFFICIENT`.
- **On material supersession** of an assessment, a PHI-minimized audit event
  (`reasoning.material_change`) names WHICH fingerprint categories changed,
  derived by diffing category-level sub-hashes.
