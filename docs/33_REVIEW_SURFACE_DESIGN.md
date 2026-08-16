# 33 — Reducing what a reviewer must decide

Status: **#3, #4 and #5 implemented — all three turned out to be defects.
#1 (note-level review) specified and awaiting build.** No decision is
outstanding for any of them.
Measured against REF-2026-0005 (McHenry, 23 documents / 1,357 pages) on
2026-08-15, after the review-4 fixes landed (`59aacc6`).

The question this answers: a physician opens Records and is asked for 547
decisions. Which of those does the case actually need, and which are an
artefact of how the surface is built?

---

## Where the 547 come from

| Audit result on current rows | Rows |
| --- | --- |
| SOURCE_CONFLICT | 425 |
| EXTRACTION_INCOMPLETE | 80 |
| NEEDS_HUMAN_REVIEW | 25 |
| PASS | 17 |

| Substance class | Rows |
| --- | --- |
| CLINICAL | 349 |
| ANCILLARY | 193 |
| ADMINISTRATIVE | 5 |

Paperwork (198 rows) is already folded out of the clinical queue by the triage
grouping. The clinical queue is ~349, and **425 of the 547 carry audit verdicts
computed under the pre-fix rules** — only one document has been re-extracted
since. That re-extraction measured 91 → 11 source conflicts. Re-running the
other 22 documents needs no code and is assumed as background to everything
below.

---

## 1. Review the NOTE, not the extraction fragment

**The finding.** The Records surface lists one card per `ExtractedEncounter`
row. The record the case actually asserts is the consolidated note that
`buildRecords` already produces and persists on `Document.segments`.

Measured on this case:

```
canonical notes (persisted segments)   227
extraction rows folded into them       561
notes built from more than one row      84
review decisions: note level 227  vs  row level 561
```

A reviewer is signing off on extraction fragments — three page-chunks of one
operative note are three separate decisions — while the chronology, the reports
and the care plan all speak in notes. **59% of the decisions exist only because
the review surface is at a finer grain than the record.**

**The change.** Make the reviewable unit the note.

- `getStructuredRecord` gains a note-level projection built from the same
  persisted `segments` the canonical builder wrote: each note carries its
  rowIds, its date and provenance, its claims (union of its rows'), and the
  worst audit result among its rows.
- The Records card renders one note, with its rows listed beneath as citations
  (page ranges, per-row excerpts) — visible, not decisions.
- A review action on a note applies to every row it consolidates, through the
  **existing group endpoint** (`/records/encounters/group`), which already
  takes row ids plus per-row displayed-content hashes and commits all-or-none.
  No new write path.
- Correction stays per-row: a correction is about one row's exact content, and
  the note view links to the row that carries the field being corrected.

**Why this does not hide anything.** The note is what the report cites and what
the plan is built from. Reviewing it is reviewing the assertion; reviewing a
fragment is reviewing a chunk boundary the reviewer did not choose and cannot
see. Every underlying row keeps its own status, hash and audit result, and the
group decision writes each one individually.

**Files.** `src/lib/records/structuredRecord.ts` (projection),
`src/components/case/CaseWorkspace.tsx` (ExtractionBlock renders notes),
`src/app/api/cases/[caseId]/records/extractions/route.ts` (shape).
No schema change. No new endpoint.

**Risk.** A note whose rows disagree in audit result must present as its WORST
row, or the grouping would launder a conflict. The safeguard registry gets a
new claim + refutation for exactly this.

**Decision needed:** none — this is strictly a fidelity improvement. Ship it.

---

## 3. ~~Scope a failed section to the pages it covers~~ — WITHDRAWN

**This proposal was wrong, and the measurement that retired it is worth
keeping.** The original idea: 438 rows carry *"N section(s) of the source
could not be processed"*, which marks the whole document incomplete, so scope
the mark to the failed pages instead. That would have re-scoped a real signal
on a spatial assumption (pages 12–14 are fine because pages 200–204 failed),
and it would have needed a judgement call about how far "near" reaches.

Then the failures themselves were counted:

```
documents with >=1 failed section    4 of 23
failed sections total               15
reason (14 of 15)  structured output failed after retry:
                   schema: encounters.0.claims.11.excerpt:
                   String must contain at least 3 character(s)
```

Fourteen of fifteen failures were **one claim whose excerpt came back under
three characters**, which failed the claims array, the payload, the chunk, and
finally an entire page of a medical record. Not an unreadable page. Not a
provider outage. Our own schema, discarding a page over one malformed field.

That contradicts the pipeline's stated policy — *grounding fails closed,
everything else bends* — because grounding is supposed to fail closed for the
CLAIM that is ungrounded, not for its neighbours.

**Implemented instead (`salvageClaims`, recordExtraction.ts):**

- each claim is parsed on its own; an unparseable one is dropped with a
  PHI-free reason naming its field, and the rest of the page survives;
- an entry left with no claims is dropped — an entry with nothing to cite is
  not an entry;
- if entries were sent and NONE survived, the response throws as before, so a
  model answering unusably still fails loudly instead of reporting an empty
  page (three existing fail-closed tests hold this line and were what caught
  the first version of this change);
- any salvage marks the response INCOMPLETE, which the existing machinery
  already handles by subdividing the range and re-asking — so a salvaged page
  is re-read on a smaller range rather than passed off as whole.

The document-level rule for a section that genuinely cannot be processed is
**unchanged and still strict**. The population it applies to should now be
close to zero. Registered in the safeguard registry as `claim-salvage`, with
refutations.

**Decision needed:** none. It was a defect.

---

## 4. Coverage gaps belong to the document, not to every entry — IMPLEMENTED

**The finding.** 347 rows carried *"N dated note header(s) have no extracted
encounter"*. Measured against the segmenter:

```
dated note headers found across the case   47
header dates with NO extracted row          9
```

The real recall gap is **9 dates**; the 347 was the same amplification #3
suffered from. Three documents hold 6 of the 9 (River Oaks 3, St Joseph 2,
Emergency Hospital MR AFF 2).

**What was implemented.** A missed encounter makes the RECORD incomplete; it
does not make the entries that *were* produced defective. So the finding is now
document-only: it sets the document's audit result and stays off `perEncounter`.

Removing it from the rows would have quietly weakened the export gate — once
every row is human-reviewed, the per-row `EXTRACTION_INCOMPLETE` was the only
thing carrying "a note was missed" into `factualReviewState`. So the gate now
carries it explicitly: `RecordExtraction.coverageGaps` is persisted per run
(additive migration `20260816000000`), and `coverageGapBlocker()` — pure and
exported so the guarantee is *tested*, not asserted — blocks completion while
any latest-run gap remains. A re-extraction that closes the gap stops blocking,
because only each document's newest run counts.

**Still outstanding:** the 9 genuine misses are a recall bug to hunt. They are
not suppressed — they block the case gate until extraction finds them or a
human resolves them.

## 5. A two-row duplicate marked a whole document — IMPLEMENTED

**Correction to the original finding, which was wrong.** This document first
claimed the audit's duplicate key was defective — grouping on an empty
provider — based on a measurement that reconstructed the key as
`document + date + provider`. The real key already includes a 60-character
summary prefix. Re-measured with the actual key:

```
real duplicate groups across the case   1   (2 rows, one genuine repeat)
```

The key is sound. The defect was the same amplification as #3 and #4: those
2 rows sit in River Oaks, and the finding set a document-wide review flag, so
**all 176 rows of that document were marked as needing review because two of
them repeat.**

**What was implemented.** Duplicate detection now remembers the group's
MEMBERS, not just a count, and marks only those entries. Its neighbours are
untouched.

**Method note worth keeping.** Two of this document's five findings were
produced by measuring a reconstruction of the code rather than the code.
Re-deriving a key by hand is a guess; importing the real one is not. The
duplicate finding survived only because the second measurement contradicted
the first.

## Order, and what each is worth

| # | Change | Rows affected | Kind | Needs a decision |
| --- | --- | --- | --- | --- |
| — | Re-extract 22 documents | ~425 → est. <100 | operational | no |
| 1 | Note-level review surface | 561 → 227 decisions | fidelity | no |
| 5 | Duplicate finding amplified to a whole document | 176 rows | defect | no |
| 4 | Coverage gaps → document + case gate (+9 recall bugs) | 347 | defect + bug | no |
| 3 | ~~Failed-section scoping~~ → fixed the root cause instead | 438 | defect | no |

Everything above leaves the human review gate, the export gate and per-row
provenance untouched. #1, #3 and #5 are strict improvements; #4-part-1 changes
what a signal is attached to. Nothing here now requires a judgement call — the
one item that did (#3) dissolved once its failures were counted, which is the
general lesson: measure the population before designing a policy for it.

Each change lands with a claim + refutation in `src/lib/safeguards/claims.ts`,
so the label it puts in front of a physician is testable.

---

## Implementation status (2026-08-17)

Measured on REF-2026-0005 with `npm run records:burden`, counting distinct
findings by identity and canonical notes from persisted segments.

| | before | after |
| --- | --- | --- |
| active extraction rows | 548 | 548 |
| canonical notes (review decisions) | 548 | **229** |
| notes needing attention | 221 | **171** |
| clean notes awaiting attestation | 8 | **58** |
| distinct case / document / page blockers | not countable | 2 / 4 / 9 |
| rows at PASS | 8 | 142 |

`RecordFinding` is now the source of truth for review presentation and
metrics; `ExtractedEncounter.auditFindings` is retained for compatibility and
is no longer authoritative. `npm run records:reaudit` applies corrected
deterministic rules with no model calls, preserving human status, verification
hashes and any conflict whose dispute state predates persistence.
