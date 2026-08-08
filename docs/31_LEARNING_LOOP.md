# Learning from published plans

How the program gets better at chronicling a case each time a new case arrives
with a professionally published Life Care Plan beside it.

## The idea

A published plan is the only ground truth we have for what a qualified life-care
planner actually does with a case file: which encounters they chronicle, what
they say about each, and in what order. Everything in `src/lib/learning/` exists
to turn that into something the program can be measured against and can learn
from — and to keep the two apart, because a system that grades itself and
rewrites itself in the same breath is not learning, it is drifting.

The plans are real patient records. They live in the gitignored corpus area and
never enter the repository. What enters the repository is structure: clause
names, counts, positions, and the code that derives them.

## What is measured

`planAgreement.ts` scores the program's chronology for a case against the plan
published for that same case. Four numbers, because they belong to different
layers and a single score would say something got worse without saying what to
fix:

| measure | question | whose fault when it is low |
| --- | --- | --- |
| **date recall** | of the dates the planner chronicled, how many do we have an entry for? | ingestion and extraction coverage |
| **extraction recall** | of the salient terms in their entry, how many appear anywhere in our claims? | the extraction pipeline |
| **summary precision** | of the terms our one-line summary spends its space on, how many did they also use? | the emphasis profile |
| **lead agreement** | did we lead the entry with the same kind of clause they led with? | the emphasis profile |

**Summary precision, not summary recall, is what the emphasis profile is held
to.** Their entry runs to paragraphs; ours is one line of three clauses, so it
cannot contain most of what they wrote however well it is chosen. Recall is
reported because it is a useful floor, but it can never approach 1 and improving
it is not a goal. Precision asks the question a bounded summary can be held to:
is what we chose to say the kind of thing the professional said?

## What is learned

`emphasisLearning.ts` measures three things per kind of record and proposes a
profile in the shape `summaryEmphasis.ts` holds:

- **share** — how often the planner includes a clause at all. What they consider
  worth saying. Decides which clauses earn a place under the three-clause cap.
- **position** — mean ordinal position among entries that include it. Narrative
  order. Decides how the kept clauses read.
- **compression** — among entries the planner wrote as a single clause, how
  often it was this one. A one-line summary *is* the compressed form, so this
  decides what leads.

## What it cannot learn, and why that matters

A derivation only knows what the plans could show it. Some of what the program
must get right is invisible there **by construction**:

- **A procedure inside a visit.** The planner gives a procedure its own
  chronology entry, so no encounter entry ever labels one. Derived alone, the
  clause disappears and a visit where an injection was performed stops saying
  so. Clauses like this are marked `carried: true` and survive adoption.
- **Field order inside a clause.** The planner writes one "Plan:" paragraph
  covering both the modality delivered and the course advised. We hold those as
  two fields, and preferring the delivered one is a judgement their prose cannot
  express either way.
- **Kinds they never chronicle.** A planner chronicles care, so five plans hold
  no billing entry, no deposition and no pathology report. Those keep
  `basis: "hand-shaped"` and are never fitted to evidence that does not exist.

`mergeForAdoption` encodes the division: **the corpus supplies the weight, the
human supplies the fields and the wording.** A measured clause updates the share
of the clause it overlaps and leaves its field list alone; clauses the corpus had
no opportunity to speak about are kept as they were.

## The loop

```bash
npx tsx uploads/corpus-tmp/learn-from-finals.ts
```

1. Parse every published plan in the corpus.
2. Score each case against its own plan under the committed profile — the
   baseline.
3. **Leave-one-out**: derive a profile from the other four plans, score it on the
   fifth. This is the honest test. A profile derived from the same plans it is
   scored on will always look good; one derived from plans it has never seen
   either generalizes or does not.
4. **The gate**: neither held-out measure may regress on average and one must
   gain. Pass prints `ADOPT`, fail prints `HOLD`.
5. Either way, emit `candidate-emphasis.ts` — the full-corpus proposal, merged
   with what the corpus cannot teach, as compiling source.

Adoption is then a human diff against `src/lib/llm/summaryEmphasis.ts` and a
commit. Nothing writes to the running profile.

### Why adoption is not automatic

This is a medico-legal opinion engine. An attestation binds a physician to
specific recommendations, and a report is written to be defended on a witness
stand. A profile that quietly differs from the one that produced last month's
opinion cannot be explained there — and "the program changed its mind between
runs" is not an answer a plaintiff's expert can give under cross-examination.
The loop is therefore built to make adoption *easy and evidenced*, not
invisible: the candidate compiles, the report says what changed and by how much,
and a person commits it.

## Adding a case

1. Put the published plan's text in the corpus finals directory.
2. Add the case number and filename to `CASES` in `learn-from-finals.ts`.
3. Run the loop. The held-out score now includes the new plan, and the gate says
   whether what it teaches survives contact with the others.

## Where the numbers stood on 2026-08-08

Five plans, 557 chronology entries, 248 carrying labelled clauses.

- Date recall 85.7–100% — coverage is good; the program has an entry for nearly
  every date the planner chronicled.
- Extraction recall 23.6–38.4% — **the largest gap, and it is not an emphasis
  problem.** Roughly two thirds of the terms a planner uses never reach our
  claims at all. No amount of re-ordering a summary fixes that.
- Summary precision 36.9–60.2%.
- Lead agreement 58.7–87.5%.

Leave-one-out returned `ADOPT` (mean precision +0.2 pt, lead agreement +1.0 pt),
confirming the derivation generalizes. The full-corpus candidate was **not**
adopted, because the committed profile was itself derived from these same five
plans and differs from the candidate only in rounding. The loop's value is for
the sixth case, not this one.
