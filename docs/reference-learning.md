# Reference-report learning

## What a reference plan is, and is not

A professionally finalized life care plan is the **answer key**. It records what
an experienced planner concluded from a record set. That makes it the most
valuable document a case can carry — for *learning* — and it is **not evidence
about the patient**. It is an opinion written after the fact, citing the same
records the generator is already reading.

Mining it as a record is the worst failure this system can make, and it is
silent: every recommendation would read as "record-supported", and the plan the
program produced would be a paraphrase of the plan it was shown, presented to a
physician as independent work.

## The boundary

`src/lib/reference/boundary.ts` is the single answer to *may this document speak
about the patient?* `LIFE_CARE_PLAN`, `EXPERT_REPORT`, `COST_PROJECTION` and
`PEER_REVIEW` may be stored, displayed and cited as what they are. They may
never contribute a diagnosis, an objective finding, a chronology event, a
treating-provider recommendation or condition evidence.

Reference plan ITEMS live in `ReferencePlanItem`, preserved out of the runtime
plan. `GOLD_IMPORT` is no longer an authored production origin, so a
regeneration cannot resurrect them into the case.

## What is learned, and what cannot be

| Artifact | Carries | Cannot carry |
|---|---|---|
| **Style profile** (`referenceStyle.ts`) | median sentence length, paragraph length, passive share, clinical-lead share, lead-clause distribution, section KINDS, connective phrases from a declared vocabulary | any sentence, name, date, finding, measurement |
| **Care patterns** (`carePatterns.ts`) | `InterventionId` + condition key + two counts | service text, frequency, duration, cost, rationale |

Both are fact-free **by construction, not by filtering**. The style profile's
free-text surface is closed: a heading is mapped to one of eleven declared
section kinds or dropped; a lead clause to one of nine labels or dropped; a
connective must be in a fixed list. `assertFactFree` is a second line of
defence, and it **refuses** rather than sanitising — a near-miss that looks
clean is worse than a rejection.

## What a pattern may do

A pattern is evidence about **professional practice**, not about this patient.
It licenses the generator to CONSIDER an intervention — to raise it to
`CANDIDATE_REVIEW`, visible to a reviewer and outside the supported total. It
can never do more, whatever its corpus share. `patternSupportCeiling()` returns
the same value at 3-of-3 as at 2-of-3, and support still has to come from this
patient's own record.

## Storage, approval and consumption

Artifacts persist to `LearnedArtifact` — versioned, attributable, with the
sample size and the held-out cases recorded. `scripts/reference-learn.ts
--write` creates them with `approvedById` **null**.

**Nothing consumes an unapproved artifact.** `approvedCarePatterns()` filters on
`approvedById: { not: null }`, so running the script is not the same act as
authorising a clinical rule. That is the same discipline the learning loop
already applies to priors.

Leave-one-out is enforced at the point of **use**, not only at derivation: an
artifact whose `heldOut` does not include the case being generated is refused
for that case. An artifact that learned from a case cannot inform the run being
scored on it.

## Current limitation: the corpus is one plan

`MIN_CORPUS_PLANS = 3`, and **only REF-2026-0005 has a preserved reference
plan**. With one plan every pattern is "1 of 1, 100%", and each of that case's
five condition keys inherits all 37 of its items — a memory of one case wearing
a pattern's clothes. Left unguarded it would push one patient's care list onto
every case sharing a diagnosis keyword.

So the pattern layer is **deliberately inert today**. It is built, verified and
tested; it suggests nothing until the corpus grows.

Reference cases 0001–0004 are extracted — documents, encounters and chronology —
but carry **no preserved reference plan** (`ReferencePlanItem` count is zero for
all four). Generating future-care plans for them would exercise the pipeline on
other diagnoses, which is worth doing, but it would not grow the LEARNING
corpus: there is no published plan to learn from or score against.

Growing this layer needs the finalized reports for those cases imported as
`LIFE_CARE_PLAN` / `EXPERT_REPORT` documents and their published items preserved
via `scripts/preserve-reference-plan.ts`. Until then the style profile has no
input either — the derivation runs and reports that it found no finalized-report
documents rather than inventing one.

## Leave-one-out

`scripts/reference-learn.ts --hold-out <caseNumber>` excludes a case so
artifacts can be built for evaluating it. Learning from a plan and then scoring
against that plan measures memorisation. With N=1, leave-one-out leaves zero —
another reason the layer is inert.

## Commands

```bash
# Preserve published-plan items out of the runtime plan (dry run first)
npx tsx scripts/preserve-reference-plan.ts
npx tsx scripts/preserve-reference-plan.ts --apply
npx tsx scripts/preserve-reference-plan.ts --undo      # reversible

# Derive learning artifacts (dry run; --write is currently a no-op by design)
npx tsx scripts/reference-learn.ts
npx tsx scripts/reference-learn.ts --hold-out REF-2026-0005

# Blind evaluation: generator output only, scored against the published plan
npx tsx scripts/reference-eval.ts
npx tsx scripts/reference-eval.ts REF-2026-0005
```

## Promotion

Machine-derived lessons are **candidates, not self-authorizing rules**. Clinical
rules and frequency/duration priors follow the existing learning-loop
discipline: repeated consistent corrections, clinical approval, leave-one-out
evaluation, auditable promotion. Nothing in this layer auto-adopts.
