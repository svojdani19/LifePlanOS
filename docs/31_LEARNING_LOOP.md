# Learning from cases

How the program gets better at chronicling a case each time a new one is worked
— and better still when that case arrives with a professionally published Life
Care Plan beside it.

> ## ⚠️ Never regenerate the emphasis profile without `mergeForAdoption`
>
> `src/lib/llm/summaryEmphasis.ts` is derived from the published plans, so
> re-deriving it looks like a safe, mechanical refresh. It is not. **A bare
> derivation silently deletes clauses the corpus cannot teach**, and the loss is
> invisible in every measurement the loop reports.
>
> The clearest case is `procedure` on `CLINICAL_ENCOUNTER`. A planner gives a
> procedure its own chronology entry, so **no encounter entry in any published
> plan ever labels one** — the measured share is zero because of how planners
> organize a document, not because a procedure does not matter. Re-derive
> without merging and the clause disappears, and a visit where an injection was
> performed stops saying so. Verified against real records, not hypothetical.
>
> Clauses in that position are marked **`carried: true`**. `mergeForAdoption`
> keeps them, keeps any clause over a field the candidate does not cover, and
> keeps whole the kinds a planner never chronicles at all (billing, depositions,
> pathology — `basis: "hand-shaped"`).
>
> It also cannot preserve **field order inside a clause**. Our therapy `care:`
> clause prefers the modality *delivered* over the course *advised*; the
> planner writes one "Plan:" paragraph covering both, so no derivation can see
> that preference and a naive one reverses it. **The corpus supplies the weight;
> a human supplies the fields and the wording.** That is why adoption is a diff
> and not a script.

## The aim

To reach a pipeline that reproduces what a qualified life-care planner finds,
and then a report that is **more thorough than the published one while staying
in the same scope**. Scope is the constraint that makes the goal meaningful: a
longer report is easy and worthless. The measurements below exist to tell the
difference between a report that says more and one that says more of what
matters.

## Every case teaches something. Not every case has ground truth.

Most cases will never have a published plan. One is the end of a months-long
professional engagement, and a program that only learned from cases that already
had one would learn from a handful and ignore the practice.

So learning has two halves, kept apart by what each can honestly claim.

| | needs a published plan? | what it can say |
| --- | --- | --- |
| **Observation** (`caseObservation.ts`) | no — **every case** | what our pipeline CAN say: which fields extraction actually yields per kind of document, which profile clauses ever fire, where composition finds nothing |
| **Emphasis** (`emphasisLearning.ts`) | yes | what SHOULD be said: which clauses a planner writes, in what order, and which one survives when they compress an entry to a single line |

Observation is not the lesser half. A clause that never fires spends a slot of a
three-clause summary on nothing. A profile whose clauses never draw on anything
holds a belief about a kind of record that our extraction contradicts. Neither
needs ground truth to detect.

**The join is where the two halves pay off.** A clause the planners write in most
entries that our pipeline can fill in almost none is not an emphasis question to
be re-ordered — it is a fact we are not extracting, and `findEmphasisGaps` names
it precisely. That list is the roadmap to the more-thorough report.

## What is measured against a published plan

`planAgreement.ts` scores a case against the plan published for it. Four numbers,
because they belong to different layers and one score would say something got
worse without saying what to fix:

| measure | question | whose fault when low |
| --- | --- | --- |
| **date recall** | of the dates the planner chronicled, how many do we have an entry for? | ingestion coverage |
| **extraction recall** | of the salient terms in their entry, how many appear anywhere in our claims? | the extraction pipeline |
| **summary precision** | of the terms our one-line summary spends its space on, how many did they also use? | the emphasis profile |
| **lead agreement** | did we lead the entry with the same kind of clause they led with? | the emphasis profile |

**Summary precision, not recall, is what the emphasis profile is held to.** Their
entry runs to paragraphs; ours is one line of three clauses, so it cannot contain
most of what they wrote however well chosen. Recall is reported as a floor, but
it can never approach 1 and chasing it would be chasing an artefact of the cap.

## What a derivation cannot learn, and why that matters

A derivation only knows what the plans could show it. Some of what the program
must get right is invisible there **by construction**:

- **A procedure inside a visit.** The planner gives a procedure its own entry, so
  no encounter entry ever labels one. Derived alone, the clause disappears and a
  visit where an injection was performed stops saying so. Clauses like this are
  marked `carried: true` and survive adoption.
- **Field order inside a clause.** The planner writes one "Plan:" paragraph
  covering both the modality delivered and the course advised. We hold those as
  two fields, and preferring the delivered one is a judgement their prose cannot
  express either way.
- **Kinds they never chronicle.** A planner chronicles care, so the plans hold no
  billing entry, no deposition and no pathology report. Those keep
  `basis: "hand-shaped"` and are never fitted to evidence that does not exist.

`mergeForAdoption` encodes the division: **the corpus supplies the weight, the
human supplies the fields and the wording.**

## Running it

```bash
npx tsx uploads/corpus-tmp/learn-from-cases.ts
```

1. Every case with extracted records is observed. No plan required.
2. Cases that also have a published plan are scored against it, and contribute
   to the emphasis measurement.
3. The two halves are joined into the gap list.
4. **Leave-one-out**, when two or more plans exist: derive from the others,
   score on the held-out one. A profile derived from the plans it is scored on
   will always look good; one derived from plans it has never seen either
   generalizes or does not. With fewer than two plans the gate is skipped and
   says so.
5. **The gate**: neither held-out measure may regress on average and one must
   gain. Prints `ADOPT` or `HOLD`.
6. Either way, emit `candidate-emphasis.ts` — the proposal merged with what the
   corpus cannot teach, as compiling source.

Adoption is a human diff against `src/lib/llm/summaryEmphasis.ts` and a commit.
Nothing writes to the running profile.

### Why adoption is not automatic

This is a medico-legal opinion engine. An attestation binds a physician to
specific recommendations, and a report is written to be defended on a witness
stand. A profile that quietly differs from the one that produced last month's
opinion cannot be explained there. The loop makes adoption *easy and evidenced*,
not invisible.

## Adding a case

- **Without a published plan** — nothing to do. Any case with extracted records
  is observed automatically.
- **With one** — put the plan's text in the corpus finals directory and add the
  case number to `FINAL_BY_CASE` in `learn-from-cases.ts`.

## Where the numbers stood on 2026-08-08

Six cases had extracted records; five had a published plan. 557 chronology
entries parsed, 248 carrying labelled clauses.

**From the plans:** date recall 85.7–100%, summary precision 36.9–60.2%, lead
agreement 58.7–87.5%, and **extraction recall 23.6–38.4%** — roughly two thirds
of the terms a planner uses never reach our claims. That is the largest gap in
the program, it is not an emphasis problem, and it is the main obstacle to a
more-thorough report.

Leave-one-out returned `ADOPT` (mean precision +0.2 pt, lead +1.0 pt), confirming
the derivation generalizes. The full-corpus candidate was not adopted, because
the committed profile came from these same five plans and differs only in
rounding.

**From observation, needing no plan at all:**

- `OPERATIVE` — 26% of encounters compose nothing, and the `implants` clause drew
  on nothing across all 50. Our profile leads operative records with `procedure`,
  which yields in only 30% of them, while `operativeFindings` yields 36%.
- `INSURANCE_ADMINISTRATIVE` — the profile asks for claim status, authorization
  and coverage; extraction produces `documentContent` and `payer`. It composes
  nothing, every time. Only 2 encounters, so it is reported rather than acted on.
- Mean clauses per summary is 1.7–2.4 against a cap of 3 — summaries are starved
  more often than they are crowded, which is the opposite of the problem the cap
  was added to solve.
- `CORRESPONDENCE_OR_GENERIC_EVIDENCE` — 217 encounters, none composed, and this
  is **correct**. The class has one field; there is nothing to shape, and the
  fallback path states that one fact at a more generous length than a clause
  would allow. An earlier version of this report counted it as a failure and sent
  a reader looking for a defect that was a design working as intended; the
  observation now separates *no shape* from *misfit*.
