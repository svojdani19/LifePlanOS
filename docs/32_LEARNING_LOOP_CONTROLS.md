# The controlled learning loop

The program corrects itself the way a clinic does: someone notices a defect,
someone with standing confirms it, the case is put right, and only then does
anyone ask whether the way of working should change. Nothing here rewrites a
prompt, a rule, or a line of source code because one report came back wrong.

```
failure detected → evidence validated → human correction or deterministic
resolution → same-case repair → reusable tenant-scoped lesson → candidate rule
or prompt guidance → held-out evaluation → controlled adoption → repeat-failure
monitoring → rollback when necessary
```

## What was already here

Two mechanisms were live before this work, and both are extended rather than
replaced.

| Piece | Status before | Now |
|---|---|---|
| `CorrectionExemplar` | **Live loop.** Written by the encounter review route, read by `extractionRun.ts` into extraction prompts | Adopted lessons join the same channel; all guidance sanitized on the way out |
| `LearnedPrior` | **Live read.** `generate.ts` applies firm-scoped priors to future-care drafts; written only by `scripts/learn.ts` | Unchanged; clinical priors now require repeated corrections before a candidate may be proposed |
| `ValidationRun` | **Live, script-driven.** Written by `scripts/clinical-validation.ts` | Unchanged |
| `GoldCase` | **Script only.** No app runtime path | Unchanged; it is the natural held-out corpus |
| `src/lib/learning/*` | **Not in production.** Imported only by gitignored corpus harnesses | Unchanged; still offline calibration |

The gap was not a missing mechanism. It was that nothing recorded **what went
wrong** — a correction was stored as `WRONG_FIELD` or `SUMMARY_REWORDED`, which
says what a reviewer touched, not what the program got wrong. Without that you
cannot measure a repeat failure, tell a recoverable miss from an unrecoverable
one, or decide which mechanism should learn from a defect.

## Two rules everything else follows from

**A critic's allegation is not training truth.** Detection is cheap and often
wrong. A finding enters at `DETECTED` and influences nothing. It becomes
learnable only when the source itself disagrees with the output, or a reviewer
with the right standing says so. `REJECTED_FALSE_POSITIVE` is terminal and is
kept rather than deleted, because the rate at which the critic cries wolf is
itself worth measuring.

**A lesson is not a licence.** Confirming a defect earns the right to repair
*this case* and to propose a lesson. Changing behaviour needs held-out
evaluation, a safety check, and a recorded adoption decision with the previous
version still available to roll back to.

## Failure taxonomy

Each code declares three things that govern its whole lifecycle
(`src/lib/learning/failureTaxonomy.ts`):

- **Mechanism** — what may learn from it. A safety defect must never be "fixed"
  by retrieving a prose example; a style preference must never become a
  deterministic rule.
- **Severity** — whether a regression here is ever negotiable. `SAFETY_CRITICAL`
  has zero tolerance.
- **Scope** — how far a lesson may travel: this case, this document class within
  the firm, or the firm's clinical preferences.

| Mechanism | Codes | Why |
|---|---|---|
| `DETERMINISTIC_RULE` | wrong laterality/anatomy, negation reversed, planned-as-performed, consent-as-treatment, unsupported claim/prose, all identity defects, wrong date/provider/facility, copied-forward, pricing mismatch | Retrieving an example cannot stop a laterality inversion. The program may *propose* a rule; adopting a code-level rule stays a reviewed software change |
| `TASK_GUIDANCE` | missed section, missed material fact, missed negative finding | Fact-free structural guidance, scoped to a document class |
| `SALIENCE_PREFERENCE` | irrelevant summary, important fact omitted | Which claim fields lead; never the corrected prose |
| `CLINICAL_PRIOR` | unsupported recommendation/frequency/duration/treatment-failure | Firm-scoped, applied with provenance, always still reviewable |
| `NONE` | source conflict, other reviewer correction | Repair the case, count the finding |

## How a correction becomes a lesson

1. **Detect** — critic, factual audit, section ledger, deterministic check or
   human review records a finding with the pipeline versions and source
   fingerprint that produced it.
2. **Validate** — deterministic confirmation, or a human with the standing the
   code requires. A care-planning defect needs clinical standing, so a learned
   prior can never originate from someone without it.
3. **Repair** — a targeted retry of the affected page or encounter, bounded at
   two attempts. `REPAIRED` is claimed only when the source-grounded defect is
   gone; an exhausted repair goes to `UNRESOLVED` and stays visible, because a
   finding that quietly disappears is indistinguishable from one that was fixed.
4. **Propose** — a candidate carrying fact-free guidance. A clinical prior
   additionally requires three consistent corrections from the same firm.
5. **Evaluate** — on cases the candidate did not come from.
6. **Adopt or reject** — recorded either way.

## Adoption gates

`judgeCandidate` rejects, in this order:

1. `EVALUATION_OVERLAPS_TRAINING` — scored on its own source case. A lesson
   drawn from one case and measured on that case restates the correction.
2. `NO_HELD_OUT_CASES`
3. `SAFETY_REGRESSION:*` — any of unsupported claims, negation reversal,
   planned-as-delivered, wrong laterality, false encounter merge, cross-tenant
   retrieval, or unsupported recommendation entering finalized totals. Rejected
   however large the gain elsewhere.
4. `NO_MEASURED_IMPROVEMENT`
5. `REGRESSION_IN_CLASS:*` — a gain in one document class bought with a material
   loss in another is a redistribution, not an improvement.

## Tenant isolation and PHI

`retrieveGuidance` takes `firmId` as a **required parameter**, not an option, so
there is no call shape that omits it. Only `ADOPTED` candidates are returned;
drafts, rejected and retired candidates influence nothing. Results are bounded
by count (5) and rough token budget (400), and ordered deterministically so the
same firm and task build the same prompt every time.

`assertPhiFree` throws on anything that looks like a date, a DOB, an MRN, an
SSN, a named patient, or anything longer than 240 characters. It runs when a
lesson is written **and** again in `sanitizeGuidance` immediately before the
text enters a prompt — a guidance sentence is cheap to lose and expensive to
leak. Findings reference the rows they concern by ID and record which fields
changed and which claim ids moved; never record text or model responses.

## Rollback

`retireCandidate` marks the lesson `RETIRED` with its evaluation and adoption
timestamp intact, and restores whatever it superseded via `supersedesId`.
Rollback is not deletion: the record of what the program believed, and when,
survives. `applicationCount` on each candidate, incremented through
`recordApplications`, is what lets a regression be traced back to the lesson
that caused it.

## Detectors, repair and metrics

| Detector | Arrives as | Why |
|---|---|---|
| **Section ledger** | `VALIDATED` | Self-confirming: it compares claims against the uploaded document, so "this page prints an Assessment heading and we captured nothing from it" needs no adjudication |
| **Extraction critic / factual audit** | `DETECTED` | A model asked to find fault obliges. Recorded anyway, because the rate at which it cries wolf is only measurable if rejections are kept |
| **Encounter identity** | `DETECTED` | A `POSSIBLE_DUPLICATE` verdict is exactly the state that must not be resolved silently in either direction |
| **Reviewer correction** | `VALIDATED` | A human with standing has changed the output. Wired into the encounter review route, which now also accepts an explicit `failureCode` — the reviewer's answer beats any mapping inferred from the correction category |

A warning the vocabulary cannot classify is **dropped**, not filed as `OTHER`: a
finding with the wrong code pollutes the repeat-failure rate for a code that did
not actually recur.

**Repair** (`repairService.ts`) is narrow, bounded at two attempts, and refuses
before it starts in three cases: a defect no retry can fix, a defect that has
used its attempts, and content whose review status is `HUMAN_EDITED`,
`REVIEWED` or `VERIFIED`. A regeneration that overwrites a physician's
correction is worse than the defect it was fixing, because the defect was
visible and the overwrite is not. `auditIsQualified` reports a case as
unqualified while any confirmed defect remains open.

**Metrics** (`learningMetrics.ts`) count rows, codes and dates — never a claim
value, an excerpt or a patient identifier. The two that matter most are
uncomfortable: `falsePositiveCriticRate`, and `repeatFailureRate`, which
distinguishes a **new** failure from the same code recurring in the same
document class. A repeat rate that does not fall is the honest signal that a
lesson did nothing.

## What this is not

The model's weights do not change. Nothing here retrains anything. The accurate
description of the behaviour is that the program applies **verified prior
corrections, deterministic rules, and firm-specific guidance** — and any
interface copy should say exactly that rather than implying the model learned
something after one report.
