# Claude Code Prompt — Clinical Evidence Quality, Standard of Care, and Evidence Explorer

```text
You are working in the existing LifePlanOS repository.

Implement a focused Clinical Evidence Quality Epic that corrects the Standard of Care and Evidence Explorer evidence-selection defects.

IMPORTANT CHANGE CONTROL

This is a clinical-evidence integrity project.

Do not redesign the application.
Do not change branding, navigation, report typography, report layout, or unrelated workflows.
Do not rebuild the codebase.
Do not remove existing working functionality.
Use the current Next.js, Prisma, evidence graph, recommendation lifecycle, validation, and report systems.
Make the smallest coherent additive changes.

The known defect is that the same article may appear for several diagnoses or recommendations even when it is not clinically relevant. The Evidence Explorer currently displays the stored source relationships but does not sufficiently validate whether each source is the best applicable evidence or explain what weakens the claim and what remains unknown.

PRIMARY OBJECTIVES

1. Every Standard of Care source must be real, resolvable, current where reasonably determinable, clinically applicable, and directly relevant to the selected diagnosis and clinical question.
2. Every Evidence Explorer source must support a defined clinical claim for that specific diagnosis or recommendation.
3. The same source must not be reused across clinically unrelated diagnoses or recommendations merely because of shared keywords.
4. The Evidence Explorer must provide the best available evidence hierarchy, meaningful contradictory evidence, patient-specific weaknesses, and structured unknowns.
5. Final report export must not represent weak, unapproved, or inapplicable sources as authoritative support.

PHASE 1 — INSPECT BEFORE MODIFYING

Trace and document:

- src/lib/literature/*
- src/lib/engine/generate.ts citation enrichment
- src/lib/engine/standardOfCare.ts
- src/lib/engine/evidenceGraph.ts
- Evidence Explorer UI in CaseWorkspace
- EvidenceLink, Condition, FutureCareItem, ValidationFinding, and SocUserInput models
- Standard of Care and Evidence APIs
- report generation sections that consume these sources
- existing tests and fixtures

Before coding, provide a concise implementation plan and exact files expected to change. Then implement without waiting unless a destructive schema decision is unavoidable.

PHASE 2 — CANONICAL EVIDENCE SOURCE MODEL

Add a canonical EvidenceSource model rather than storing all sources only as anonymous JSON.

Minimum fields:

- id
- sourceType: GUIDELINE, CONSENSUS, SYSTEMATIC_REVIEW, META_ANALYSIS, RCT, REGISTRY, COHORT, CASE_CONTROL, CASE_SERIES, CASE_REPORT, NARRATIVE_REVIEW, OTHER
- title
- authors
- journalOrPublisher
- year
- publicationDate when available
- PMID
- DOI
- canonicalUrl
- sponsoringOrganization
- guidelineVersion
- supersedesSourceId / supersededBySourceId where known
- abstract
- openAccess status when known
- retracted/corrected status when known
- retrievalSource
- retrievedAt
- contentHash or stable deduplication key

Deduplicate by PMID, DOI, canonical URL, and normalized title/year.

Do not store copyrighted full text unless legally permitted. Metadata, abstract, source links, and short permitted excerpts are sufficient.

Add an EvidenceAssessment model connecting a source to a specific claim/entity.

Minimum fields:

- caseId / firmId
- evidenceSourceId
- entityType: CONDITION, RECOMMENDATION, SOC_PROPOSITION
- entityId
- clinicalQuestion
- claimSupported
- diagnosisMatch: EXACT, DIRECT, INDIRECT, NONE
- anatomyMatch: EXACT, RELATED, NONE
- populationMatch: HIGH, MODERATE, LOW, NONE
- interventionMatch: EXACT, CLASS_LEVEL, INDIRECT, NONE, NOT_APPLICABLE
- outcomeMatch: EXACT, DIRECT, INDIRECT, NONE
- evidenceQuality: HIGH, MODERATE, LOW, VERY_LOW, UNGRADED
- applicability: HIGH, MODERATE, LOW, NOT_APPLICABLE
- currentness: CURRENT, POSSIBLY_SUPERSEDED, SUPERSEDED, UNKNOWN
- relevanceScore
- selectionRationale
- limitations
- contradictoryToClaim boolean
- reviewerStatus: AI_PROPOSED, PLANNER_APPROVED, PHYSICIAN_APPROVED, REJECTED, REPLACED
- reviewedById / reviewedAt / reviewerComment
- createdAt / updatedAt

Preserve reviewer decisions across evidence-graph rebuilds. Derived links may be rebuilt; reviewed assessments may not be silently deleted.

PHASE 3 — DEFINE CLINICAL QUESTIONS

Do not search for generic “literature for a diagnosis.”

Create a structured clinical question for every source request.

Examples:

- What current guideline defines management and surveillance of adult traumatic neurogenic bladder after spinal cord injury?
- What is the long-term risk of post-traumatic knee arthritis or arthroplasty after tibial plateau fracture?
- Does evidence support repeated lifetime physical therapy for this condition, and at what frequency/duration?
- What evidence supports revision risk after the specific index procedure?

Each question must include, where applicable:

- patient population
- diagnosis/etiology
- anatomy
- intervention/exposure
- comparator
- outcome
- time horizon
- care setting

Store the question with the assessment.

PHASE 4 — BEST-EVIDENCE RETRIEVAL HIERARCHY

Search and rank in this order:

1. Current primary clinical practice guideline from an authoritative specialty society or government body
2. Current consensus statement when no guideline exists
3. Systematic review/meta-analysis
4. RCT for treatment efficacy questions
5. Registry or large longitudinal cohort for natural history, complication, revision, or survivorship questions
6. Prospective cohort
7. Retrospective cohort/case-control
8. Case series
9. Narrative review
10. Case report only for rare conditions or unusual complications

Do not force a fixed number of citations. One strong applicable guideline is better than two irrelevant papers.

Prefer primary publisher/society sources. Indexed records may discover the source, but the canonical link should resolve to the authoritative source when available.

Add current-version checks for guidelines. Flag possible supersession rather than presenting an uncertain old version as current.

PHASE 5 — HARD APPLICABILITY GATES

A source may be displayed as supporting evidence only if it passes all applicable hard gates:

- diagnosis/concept match is not NONE
- anatomy match is not NONE for anatomy-dependent claims
- population match is not NONE
- intervention match is not NONE when an intervention is being supported
- outcome match is not NONE
- source is not retracted
- guideline is not known to be superseded
- the source actually addresses the defined clinical question

Examples that must be rejected:

- pediatric congenital neurogenic bladder source for an adult traumatic neurogenic bladder claim
- hip arthroplasty paper supporting total knee arthroplasty
- adolescent spine case report supporting adult knee follow-up
- generic pain paper supporting implant surveillance
- article mentioning a guideline but not itself constituting the guideline

Keep lexical/vector similarity only as candidate retrieval. It must never be the final applicability decision.

PHASE 6 — SOURCE REUSE POLICY

Track source use across the entire case.

The same source may support multiple entities only when:

- the source directly addresses each clinical question;
- each EvidenceAssessment independently passes the applicability gates;
- the reuse rationale is stored;
- the entities are clinically related or the source is legitimately broad guidance.

Flag suspicious reuse when:

- one article supports more than two distinct diagnoses;
- diagnoses involve different body regions or etiologies;
- the source is a case report or narrow population study;
- the same generic source is repeatedly selected because candidate pools are weak.

Do not solve reuse only with a scoring penalty. Add an actual validation finding and require review when reuse is suspicious.

PHASE 7 — STANDARD OF CARE REFACTOR

Separate these steps:

A. Guideline discovery
B. Guideline identity/currentness verification
C. Extraction of discrete recommendations/propositions
D. Patient applicability assessment
E. Mapping patient records to each proposition
F. Human review

Represent each guideline proposition with:

- verbatim recommendation text
- source location when available
- recommendation strength
- certainty/quality of evidence when available
- target population
- intervention
- outcome
- exclusions
- applicability to this patient

Do not mark a proposition “addressed” solely because one significant word overlaps a chronology event or future-care service.

Use explicit statuses:

- CLEARLY_DOCUMENTED
- PARTIALLY_DOCUMENTED
- INDIRECTLY_INFERRED
- NOT_DOCUMENTED
- NOT_APPLICABLE
- UNABLE_TO_DETERMINE

The narrative must accurately reflect those statuses.

In ordinary Life Care Plan mode, use the heading and framing:

“Clinical Guidance and Future-Care Relevance”

Avoid automatic negligence/breach conclusions. A separate explicitly enabled Standard of Care module may use medicolegal standard-of-care framing.

PHASE 8 — THOROUGH WEAKENING-EVIDENCE ENGINE

For each diagnosis and recommendation, build separate structured sections:

1. Patient-specific evidence that weakens the claim
2. Conflicting or limiting literature
3. Alternative explanations
4. Missing treating-provider support
5. Evidence-quality limitations

Actively evaluate:

- normal/negative tests
- pre-existing conditions
- alternative diagnoses
- improvement or resolution
- treatment response or nonresponse
- absence of physician recommendation
- low probability or optional care
- evidence against proposed frequency/duration
- lower-intensity alternatives
- population mismatch
- outdated guidance
- contradictory high-quality studies

Do not state “No contradictory evidence identified” unless the engine actually completed the structured checks and the result is documented.

PHASE 9 — STRUCTURED UNKNOWNS / EVIDENCE GAPS

Replace reliance on one free-text missingInfo/missingSupport field with structured gap categories:

- CLINICAL_DIAGNOSIS
- CAUSATION_APPORTIONMENT
- CURRENT_STATUS
- IMAGING
- FUNCTION
- TREATMENT_RESPONSE
- PHYSICIAN_SUPPORT
- FREQUENCY
- DURATION
- TIMING
- CODING
- PRICING
- HOME_ENVIRONMENT
- CAREGIVER_SUPPORT
- MEDICATIONS
- GUIDELINE_CURRENTNESS
- LITERATURE_QUALITY
- OTHER

For each gap store:

- description
- why it matters
- effect on the claim
- recommended evidence source
- severity
- resolved status

PHASE 10 — EVIDENCE EXPLORER UI

Use the current design system and existing Evidence tab.

For each selected diagnosis or recommendation, show:

A. Why this item exists
B. Best supporting patient-specific evidence
C. Best clinical guidance / literature
D. Evidence quality and applicability
E. Why each source was selected
F. Patient-specific evidence that weakens it
G. Conflicting or limiting literature
H. Alternative explanations
I. What remains unknown, grouped by gap category
J. What approval is required
K. Source reuse warning when applicable

For each article/guideline display:

- source type
- authority/sponsoring organization
- year and currentness
- evidence quality
- applicability
- clinical question supported
- selection rationale
- limitations
- PMID/DOI/link
- approve / reject / replace controls for authorized users

Do not display a source as supporting evidence if its assessment is rejected or not applicable.

PHASE 11 — REPORT RULES

The Standard of Care / Clinical Guidance section must include only:

- approved, applicable, resolvable sources
- verified verbatim excerpts
- accurate currentness status
- patient-specific applicability discussion
- explicit limitations and unknowns

Major recommendations must not cite unreviewed low-applicability sources in a final report.

Add export-blocking Critical findings for:

- unresolved or broken citation
- source not applicable to the claim
- known superseded guideline presented as current
- retracted source
- major claim supported only by an unrelated source
- suspicious cross-diagnosis source reuse without review
- fabricated or unverifiable quotation

Allow draft export with the existing DRAFT watermark.

PHASE 12 — TESTS

Add curated regression fixtures and tests for at least:

1. Adult traumatic neurogenic bladder rejects pediatric congenital sources.
2. TKA rejects hip arthroplasty literature.
3. Knee follow-up rejects adolescent spine literature.
4. Guideline-about-guideline studies are not treated as governing guidance.
5. A superseded guideline is flagged.
6. A retracted source is rejected.
7. Same article cannot silently support unrelated spine, knee, and urology diagnoses.
8. Legitimately broad guideline reuse is allowed with independent assessments.
9. Evidence Explorer hides rejected sources.
10. Evidence Explorer shows selection rationale, applicability, limitations, weakness, and unknowns.
11. “No contradictory evidence” is shown only after completed checks.
12. Guideline proposition is not marked addressed by generic token overlap.
13. Reviewer approvals survive evidence graph rebuild.
14. Final export blocks inapplicable primary support.
15. All quotes can be traced to their source text.

Create a curated clinician-review test set of diagnosis/recommendation/source combinations with expected accept/reject outcomes.

PHASE 13 — DOCUMENTATION

Update:

- docs/06_DATABASE_SPEC.md
- docs/07_AI_ENGINE.md
- docs/08_EVIDENCE_GRAPH.md
- docs/09_CLINICAL_RULES.md
- docs/10_REPORT_ENGINE.md
- docs/14_TESTING.md
- docs/15_PRODUCT_ROADMAP.md
- docs/16_DECISION_LOG.md
- docs/17_CHANGELOG.md

Create a full Epic PRD for this work under docs/epics.

COMPLETION REPORT

At completion provide:

- architecture summary
- schema changes and migration
- files changed
- source-ranking and applicability rules
- source reuse rules
- Standard of Care changes
- Evidence Explorer changes
- validation/export blocks
- tests added and results
- examples of previously accepted irrelevant sources now rejected
- remaining clinical limitations requiring physician review
- confirmation that application/report design was not otherwise changed
```
