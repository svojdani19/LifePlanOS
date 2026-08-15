# 33 — Reducing what a reviewer must decide

Status: **design, awaiting decisions.** No behaviour changes with this document.
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

## 3. Scope a failed section to the pages it covers

**The finding.** 438 rows carry *"N section(s) of the source could not be
processed"*, which sets EXTRACTION_INCOMPLETE for **every** row in that
document. On the re-extracted document, one unprocessable chunk held all 80
otherwise-clean rows below PASS.

**The change.** `failedRanges` is already recorded per chunk with
`pageStart`/`pageEnd`. Pass it into the audit and treat the incompleteness as
belonging to entries whose pages fall inside — or adjacent to — a failed range,
instead of to the document. The document-level finding stays, the case-level
export gate stays, and the Records limitations banner keeps disclosing it.

**This one re-scopes a real signal rather than removing a problem**, so it is
the decision that most deserves an explicit yes. The argument for: an entry
extracted from pages 12–14 is not less faithful because pages 200–204 failed,
and today's rule means one bad chunk in a 625-page file makes the entire file
unreviewable-as-clean. The argument against: a failed section could contain
the note that contradicts an entry elsewhere, so "nowhere near" is a spatial
assumption about a document, not a logical guarantee.

**Proposed middle:** scope it, and additionally mark any entry whose date also
appears inside a failed range as NEEDS_HUMAN_REVIEW rather than PASS — so
temporal proximity, not just page proximity, is respected.

**Files.** `src/lib/documents/extractionRun.ts` (pass `failedRanges`),
`src/lib/llm/factualAudit.ts` (per-entry incompleteness).

**Decision needed:** approve the scoping, and choose plain page-scoping vs the
proposed middle.

---

## 4. Coverage gaps are mostly amplification, not missing records

**The finding.** 347 rows carry *"N dated note header(s) have no extracted
encounter"*. Measured directly against the segmenter:

```
dated note headers found across the case   47
header dates with NO extracted row          9
```

So the real recall gap is **9 dates**, and the 347 is the same document-wide
amplification as #3. Three documents account for 6 of the 9 (River Oaks 3,
St Joseph 2, Emergency Hospital MR AFF 2).

**The change.** Two parts, in order:
1. Attribute the finding to the document, not to every row — same fix shape as
   #3. This is where the 347 goes away.
2. Treat the 9 as an extraction-recall bug and inspect them individually. Do
   **not** suppress them: a dated header with no encounter is exactly the
   under-extraction the critic-omission work exists to surface.

**Files.** Same two as #3, plus a short investigation of the 9 dates.

**Decision needed:** none for part 1. Part 2 is a bug hunt, not a design.

---

## 5. The "duplicate encounter groups" finding is a false positive

**The finding, and it is the surprising one.** 176 rows carry *"N apparent
duplicate encounter group(s) require review."* The audit's duplicate key is
document + date + provider. Inspecting the largest groups:

```
42 rows, 42 DISTINCT summaries   2024-03-15  (no provider named)
   p3  inpatient admission — Admission type was elective.
   p1  laboratory results — Phosphorus Serum collected 03/21/2024 05:05AM…
   p1  post-operative orders — Laboratory testing performed at SOUS MEDICAL LAB…
28 rows, 28 DISTINCT summaries   2025-07-14  (no provider named)
20 rows, 20 DISTINCT summaries   2025-12-03  (no provider named)
```

These are not duplicates. They are the many distinct records of a single
**inpatient day** — admission, labs, orders, consults — none of which names a
provider, so the key collapses them all together. Every group with a large
count shares one property: `provider` is empty.

**The change.** An ABSENT provider is not a distinguishing value and must not
be a grouping value either. The duplicate check should require a named
provider, or content similarity, before calling two entries apparent
duplicates. This is the same lesson already learned in
`consolidateEncounters` (`valuesCompatible`: a missing value is not evidence of
a different visit) — it simply never reached the audit's own duplicate check.

**Files.** `src/lib/llm/factualAudit.ts`, the `seen` map around the
per-encounter loop. Small and self-contained.

**Expected effect.** 176 rows lose a finding that was never true. Note this
finding only sets NEEDS_HUMAN_REVIEW, so it is not what holds rows out of PASS
— but it is noise in front of a physician, and it is wrong.

**Decision needed:** none. This is a defect.

---

## Order, and what each is worth

| # | Change | Rows affected | Kind | Needs a decision |
| --- | --- | --- | --- | --- |
| — | Re-extract 22 documents | ~425 → est. <100 | operational | no |
| 1 | Note-level review surface | 561 → 227 decisions | fidelity | no |
| 5 | Duplicate-key defect | 176 findings | defect | no |
| 4 | Coverage-gap scoping (+9 recall bugs) | 347 | scoping + bug | part 2 only |
| 3 | Failed-section scoping | 438 | **re-scoping a real signal** | **yes** |

Everything above leaves the human review gate, the export gate and per-row
provenance untouched. #1 and #5 are strict improvements; #3 and #4-part-1
change what a signal is attached to, and #3 is the one where a reasonable
person could say no.

Each change lands with a claim + refutation in `src/lib/safeguards/claims.ts`,
so the label it puts in front of a physician is testable.
