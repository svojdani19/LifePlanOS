# Clinical Evidence Audit

## Standard of Care module

### What is strong

- It queries real external literature sources.
- It attempts to identify actual guidelines and consensus statements rather than generic articles.
- It excludes obvious AI-concordance, survey, bibliometric, and guideline-adherence papers from being treated as the guideline itself.
- It requires pertinent quotable abstract language.
- It preserves verbatim text rather than fabricating quotes.
- It reserves the ultimate determination for physician review.
- It allows reviewer-added notes and sources.

### What remains unsafe

#### 1. Guideline discovery is not sufficiently authoritative

A guideline found through article indexes may be:

- a translated or regional guideline with poor applicability;
- a pediatric guideline used in an adult case;
- an old version superseded by a society update;
- a narrative article describing a guideline;
- a consensus document with lower authority than an available national guideline.

The system should verify publisher, sponsoring society, publication status, population, jurisdiction, date, and whether a newer version exists.

#### 2. Condition applicability is too lexical

Clinical applicability must be determined using structured dimensions:

- diagnosis/concept;
- anatomy;
- acute versus chronic phase;
- age group;
- etiology;
- severity;
- intervention;
- outcome;
- care setting;
- jurisdiction or practice context.

Token overlap is useful for retrieval but insufficient for final inclusion.

#### 3. Guideline recommendations are not represented as discrete propositions

The engine stores a quote and derives matching terms. It should instead represent each relevant guideline recommendation as:

- recommendation text;
- recommendation strength;
- evidence certainty;
- target population;
- intervention;
- comparator;
- outcome;
- applicability to this patient;
- exclusions;
- source location.

#### 4. Concordance mapping can create false certainty

A chronology event or planned service may share a term with a guideline without demonstrating that the guideline's actual clinical requirement was satisfied.

The system must distinguish:

- clearly documented;
- partially documented;
- indirectly inferred;
- not documented;
- not applicable;
- unable to determine.

#### 5. The module should not automatically imply negligence

Even with careful wording, “potential gap against the cited standard” can be interpreted as a breach opinion. Standard Life Care Plan output should emphasize **clinical guidance and future-care relevance** unless the user intentionally activates a Standard of Care analysis.

## Evidence Explorer

### What is strong

- It exposes why an item exists.
- It displays source records, pages, quotes, guidelines, literature, contrary evidence, unknowns, and approval status.
- Recommendation evidence inherits from its mapped condition.
- It avoids exposing hidden chain-of-thought.

### Core defect

The Explorer is only as good as the upstream evidence links. It does not independently score or challenge them. If the same irrelevant article is assigned to several diagnoses, the Explorer presents it repeatedly as valid support.

### Required evidence dimensions

Each article or guideline should have a structured assessment:

| Dimension | Required output |
|---|---|
| Source type | Guideline, systematic review, RCT, cohort, case series, case report, narrative review |
| Authority | Sponsoring society, government body, major journal, other |
| Clinical question | What claim does this source support? |
| Diagnosis match | Exact, direct, indirect, none |
| Anatomy match | Exact, related, none |
| Population match | Age, sex where relevant, etiology, severity, care setting |
| Intervention match | Exact, class-level, indirect, none |
| Outcome match | Future need, natural history, efficacy, frequency, duration, complication risk, cost |
| Evidence quality | High, moderate, low, very low / ungraded |
| Recency/currentness | Current, potentially superseded, superseded, unknown |
| Patient applicability | High, moderate, low, not applicable |
| Limitations | Specific limitations for this patient and claim |
| Contradictory evidence | Sources or patient facts that weaken the claim |
| Selection rationale | Why this was chosen over alternatives |

## Best-evidence hierarchy

For each clinical question, search in this order:

1. Current specialty-society or government clinical practice guideline
2. Current systematic review or meta-analysis
3. High-quality randomized trial, when the question is therapeutic
4. Registry or large longitudinal cohort, when the question is natural history, complication, revision, or survivorship
5. Prospective cohort
6. Retrospective cohort
7. Case series
8. Narrative review
9. Case report only for rare conditions or unusual complications

The system should not force two citations if only one strong source exists.

## Required contradictory-evidence review

For each condition or recommendation, actively look for:

- normal or negative objective findings;
- documented pre-existing disease;
- alternative etiology;
- improvement or resolution;
- treatment nonresponse;
- lack of treating-physician recommendation;
- evidence that the proposed intervention is optional rather than probable;
- evidence against long-term frequency or duration;
- evidence that a less intensive alternative is standard;
- literature with conflicting results;
- population mismatch;
- outdated or superseded recommendations.

## Required unknowns review

Unknowns should be generated from structured gaps, including:

- missing specialist confirmation;
- missing current imaging;
- missing functional assessment;
- uncertain causation or apportionment;
- unknown treatment response;
- uncertain timing;
- uncertain frequency or duration;
- unknown coding or site of service;
- insufficient pricing support;
- absent caregiver/home assessment;
- incomplete medication reconciliation;
- unavailable full-text guideline;
- inability to confirm guideline currentness.
