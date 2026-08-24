// ─────────────────────────────────────────────────────────────────────────────
// One confirmation, over exactly the clean part — and over nothing else.
//
// The defect these exist to prevent is the one the grouping change left
// behind: a metric reporting "0 required decisions" while a reviewer still had
// to sign every card before the case could export. Fixing that by relaxing the
// export gate, or by demoting exceptions to cautions, would be worse than the
// defect — so the tests below check both directions at once. The clean set
// collapses to ONE act; the unclean set does not shrink by one record.
//
// The other property under test is that this act is not a content change. The
// plan names rows and events; it never proposes a new claim, a new summary, a
// new date or a different canonical membership, and the parity test asserts
// that by comparing the whole projection before and after.
//
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { manifestHashOf, planBatchConfirmation, type ConfirmableEvent } from "@/lib/records/batchConfirmation";
import { projectNotes, type NoteFinding } from "@/lib/records/noteProjection";
import { measureReviewBurden, type BurdenRow } from "@/lib/records/reviewBurden";
import type { StructuredEncounter } from "@/lib/records/structuredRecord";

const enc = (id: string, over: Partial<StructuredEncounter> = {}): StructuredEncounter =>
  ({
    id,
    sourceDocumentId: "doc-1",
    dateStatus: "DOCUMENTED",
    encounterDate: "2025-03-14",
    encounterDateEnd: null,
    provider: "A. Rivera, MD",
    providerCredentials: "MD",
    facility: "Northgate Clinic",
    encounterType: "Clinic visit",
    factualSummary: `Clinic visit ${id}.`,
    synthesis: null,
    claims: [{ field: "assessment", value: "Lumbar radiculopathy documented", excerpt: "Assessment: …", page: 4, confidence: null }],
    page: 4,
    pageEnd: 4,
    ocrConfidence: 0.98,
    warnings: [],
    status: "AI_AUDIT_PASSED",
    substanceClass: "CLINICAL",
    substanceReason: null,
    analysisClass: "CLINICAL_ENCOUNTER",
    attributionName: null,
    attributionRole: null,
    reviewedAt: null,
    verifiedAt: null,
    staleReason: null,
    auditResult: "PASS",
    auditVersion: "2026-08-17.scoped-findings",
    unresolvedDisputes: 0,
    contradictedFields: [],
    editedFields: [],
    contentHash: id.padEnd(64, "0"),
    ...over,
  }) as StructuredEncounter;

const finding = (over: Partial<NoteFinding> = {}): NoteFinding => ({
  id: "f1",
  scope: "ENTRY",
  type: "UNSUPPORTED_CLAIM",
  severity: "BLOCKING",
  blocking: true,
  source: "DETERMINISTIC_VALIDATOR",
  detail: "A claim has no supporting excerpt.",
  status: "OPEN",
  ...over,
});

/** A whole case's canonical notes, from the same projection the screen uses. */
const notesFor = (rows: StructuredEncounter[], segments: unknown = null, findings: NoteFinding[] = []) =>
  projectNotes("doc-1", segments, rows, findings);

/** The ingest-time segment shape: no rowIds, so the compatibility path runs. */
const ingestSegments = (dates: string[]) =>
  dates.map((date, i) => ({
    date,
    label: `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`,
    pageStart: i + 1,
    pageEnd: i + 1,
    offsetStart: i * 1000,
    offsetEnd: (i + 1) * 1000,
    kind: "clinical",
    type: "CLINICAL_ENCOUNTER",
    category: null,
    bearsOnCare: true,
    provider: "A. Rivera, MD",
    facility: "Northgate Clinic",
    summary: "Clinic visit.",
  }));

/** The same row, in the burden metric's own shape. */
const asBurdenRow = (e: StructuredEncounter): BurdenRow => ({
  id: e.id,
  sourceDocumentId: e.sourceDocumentId,
  status: e.status,
  auditResult: e.auditResult ?? null,
  auditVersion: e.auditVersion ?? null,
  dateStatus: e.dateStatus,
  analysisClass: e.analysisClass,
  encounterDate: e.encounterDate,
  provider: e.provider,
  facility: e.facility,
  segmentKey: e.segmentKey ?? null,
  page: e.page,
  pageEnd: e.pageEnd,
  substanceClass: e.substanceClass,
  claims: e.claims,
});

/**
 * Fragments the identity rules can neither join nor separate: one document,
 * one day, one clinician, no stored note identity, nothing distinctive shared.
 */
const unsureCluster = (n: number, over: Partial<StructuredEncounter> = {}) =>
  Array.from({ length: n }, (_, i) =>
    enc(`u${i}`, {
      claims: [{ field: "subjective", value: `Interval note paragraph number ${i} describing the encounter`, excerpt: "…", page: 4, confidence: null }],
      ...over,
    }),
  );

const event = (id: string, over: Partial<ConfirmableEvent> = {}): ConfirmableEvent => ({
  id,
  reviewStatus: "AI_DRAFT",
  edited: false,
  sourceDocumentId: "doc-1",
  eventDate: new Date("2025-03-14T00:00:00Z"),
  sourceFingerprint: `fp-${id}`,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
describe("a hundred clean records are one decision, not a hundred", () => {
  // Each row carries its own stored note identity, so the grouping is proven
  // rather than guessed: 100 fragments, 50 real encounters.
  const rows = Array.from({ length: 100 }, (_, i) =>
    enc(`r${i}`, {
      segmentKey: `note-${Math.floor(i / 2)}`,
      encounterDate: `2025-03-${String(1 + (Math.floor(i / 2) % 28)).padStart(2, "0")}`,
      claims: [{ field: "assessment", value: `Documented assessment for encounter ${Math.floor(i / 2)}`, excerpt: "…", page: 1 + i, confidence: null }],
    } as never),
  );

  it("covers every clean canonical encounter with ONE confirmation", () => {
    const notes = notesFor(rows);
    expect(notes).toHaveLength(50);
    const plan = planBatchConfirmation({ notes, events: [] });
    expect(plan.counts.canonicalEncounters).toBe(50);
    expect(plan.counts.eligibleEncounters).toBe(50);
    expect(plan.counts.skippedEncounters).toBe(0);
    // 100 fragments, 50 records, ONE act.
    expect(plan.rowIds).toHaveLength(100);
    expect(new Set(plan.rowIds).size).toBe(100);
  });

  it("names the rows itself, from the persisted grouping", () => {
    const plan = planBatchConfirmation({ notes: notesFor(rows), events: [] });
    // Every row it proposes to write belongs to an encounter it declared
    // eligible — there is no path by which an id reaches this list otherwise.
    const fromEncounters = plan.encounters.filter((e) => e.eligible).flatMap((e) => e.confirmRowIds).sort();
    expect(plan.rowIds).toEqual(fromEncounters);
  });

  it("has a manifest that moves when any covered content moves", () => {
    const before = planBatchConfirmation({ notes: notesFor(rows), events: [] }).manifestHash;
    const changed = rows.map((r, i) => (i === 7 ? enc(r.id, { ...r, contentHash: "changed".padEnd(64, "0") } as never) : r));
    const after = planBatchConfirmation({ notes: notesFor(changed), events: [] }).manifestHash;
    expect(after).not.toBe(before);
  });

  it("has a manifest that does not depend on the order it was built in", () => {
    const a = planBatchConfirmation({ notes: notesFor(rows), events: [event("e1"), event("e2")] }).manifestHash;
    const b = planBatchConfirmation({ notes: notesFor([...rows].reverse()), events: [event("e2"), event("e1")] }).manifestHash;
    expect(b).toBe(a);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("cautions are covered — and disclosed", () => {
  it("includes a sound entry inside an incomplete document, and names the caution", () => {
    const notes = notesFor([
      enc("clean"),
      enc("caution", { auditResult: "EXTRACTION_INCOMPLETE" }),
    ], [{ rowIds: ["clean"] }, { rowIds: ["caution"] }]);
    expect(notes.map((n) => n.attention).sort()).toEqual(["CAUTION", "CLEAN"]);

    const plan = planBatchConfirmation({ notes, events: [] });
    expect(plan.counts.eligibleEncounters).toBe(2);
    expect(plan.counts.cleanEncounters).toBe(1);
    expect(plan.counts.cautionEncounters).toBe(1);
    // Named, not merely counted: the reviewer is told what they are covering.
    expect(plan.cautionsByKind).toEqual({ DOCUMENT_INCOMPLETE: 1 });
  });

  it("includes an old grade whose reason was never recorded", () => {
    const notes = notesFor([enc("legacy", { auditResult: "SOURCE_CONFLICT", auditVersion: null } as never)], [{ rowIds: ["legacy"] }]);
    const plan = planBatchConfirmation({ notes, events: [] });
    expect(plan.counts.eligibleEncounters).toBe(1);
    expect(plan.cautionsByKind).toEqual({ LEGACY_CONFLICT: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("nothing unclean can reach the batch", () => {
  const skipped = (rows: StructuredEncounter[], segments: unknown = null, findings: NoteFinding[] = []) => {
    const plan = planBatchConfirmation({ notes: notesFor(rows, segments, findings), events: [] });
    return { plan, codes: Object.keys(plan.skippedByReason) };
  };

  it("skips a record whose audit ended as a failure", () => {
    const { plan } = skipped([enc("a", { auditResult: "FAILED" })], [{ rowIds: ["a"] }]);
    expect(plan.counts.eligibleEncounters).toBe(0);
    expect(plan.rowIds).toEqual([]);
    expect(plan.counts.skippedEncounters).toBe(1);
  });

  it("skips a record the audit recorded a source conflict for", () => {
    const { plan } = skipped([enc("a", { auditResult: "SOURCE_CONFLICT" })], [{ rowIds: ["a"] }]);
    expect(plan.rowIds).toEqual([]);
  });

  it("skips a record carrying an unresolved extraction dispute", () => {
    const { plan } = skipped([enc("a", { unresolvedDisputes: 2 })], [{ rowIds: ["a"] }]);
    expect(plan.rowIds).toEqual([]);
  });

  it("skips a record whose field the source contradicts", () => {
    const { plan } = skipped([enc("a", { contradictedFields: ["date"] })], [{ rowIds: ["a"] }]);
    expect(plan.rowIds).toEqual([]);
  });

  it("skips stale human work and generation-loss candidates", () => {
    expect(skipped([enc("a", { status: "STALE" })], [{ rowIds: ["a"] }]).plan.rowIds).toEqual([]);
    expect(skipped([enc("a", { status: "GENERATION_LOSS" })], [{ rowIds: ["a"] }]).plan.rowIds).toEqual([]);
  });

  it("skips a clinical record with no supportable service date", () => {
    const { plan } = skipped([enc("a", { dateStatus: "UNKNOWN", encounterDate: null })], [{ rowIds: ["a"] }]);
    expect(plan.rowIds).toEqual([]);
    expect(Object.keys(plan.skippedByReason)).toContain("UNDATED");
  });

  it("skips a record carrying an open BLOCKING finding", () => {
    const { plan } = skipped([enc("a")], [{ rowIds: ["a"] }], [finding({ encounterId: "a" })]);
    expect(plan.rowIds).toEqual([]);
  });

  it("holds the WHOLE ambiguity cluster, while asking only ONE question", () => {
    // Same day, same clinician, no stored note identity, nothing distinctive
    // shared: the identity rules can neither join nor separate them. If the
    // open question is whether these four fragments are one encounter or four,
    // then none of the four is a settled record — confirming three of them as
    // "clean" answers the question by default, in the direction nobody chose.
    const notes = notesFor(unsureCluster(4));
    const plan = planBatchConfirmation({ notes, events: [] });

    // ONE decision…
    expect(plan.counts.skippedEncounters).toBe(1);
    expect(plan.skippedByReason).toEqual({ AMBIGUOUS_ASSIGNMENT: 1 });
    // …and not one more. The other three owe nobody anything.
    expect(plan.counts.heldEncounters).toBe(3);
    expect(plan.heldByReason).toEqual({ AWAITING_ASSIGNMENT_DECISION: 3 });
    // Nothing at all is confirmed until that one question is answered.
    expect(plan.counts.eligibleEncounters).toBe(0);
    expect(plan.rowIds).toEqual([]);
  });

  it("does NOT demote a material exception into a caution to make it eligible", () => {
    const cases: Partial<StructuredEncounter>[] = [
      { auditResult: "FAILED" },
      { auditResult: "SOURCE_CONFLICT" },
      { unresolvedDisputes: 1 },
      { contradictedFields: ["provider"] },
      { status: "STALE" },
      { status: "GENERATION_LOSS" },
      { dateStatus: "UNKNOWN", encounterDate: null },
      { corroboration: { result: "NOT_CORROBORATED", reproduced: 1, total: 4 } },
    ];
    for (const over of cases) {
      const notes = notesFor([enc("a", over)], [{ rowIds: ["a"] }]);
      const plan = planBatchConfirmation({ notes, events: [] });
      expect(notes[0].attention, JSON.stringify(over)).toBe("EXCEPTION");
      expect(plan.counts.cautionEncounters, JSON.stringify(over)).toBe(0);
      expect(plan.rowIds, JSON.stringify(over)).toEqual([]);
    }
  });

  it("keeps a clean record beside an exception eligible — the case need not be perfect", () => {
    const notes = notesFor(
      [enc("clean"), enc("broken", { auditResult: "FAILED" })],
      [{ rowIds: ["clean"] }, { rowIds: ["broken"] }],
    );
    const plan = planBatchConfirmation({ notes, events: [] });
    expect(plan.rowIds).toEqual(["clean"]);
    expect(plan.counts.skippedEncounters).toBe(1);
    expect(plan.skippedByReason).toEqual({ INTEGRITY_FAILURE: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("human work is never written over", () => {
  it("leaves an already-reviewed record alone and counts it as done", () => {
    const notes = notesFor(
      [enc("done", { status: "REVIEWED", reviewedAt: "2025-05-01T00:00:00.000Z" }), enc("draft")],
      [{ rowIds: ["done"] }, { rowIds: ["draft"] }],
    );
    const plan = planBatchConfirmation({ notes, events: [] });
    expect(plan.rowIds).toEqual(["draft"]);
    expect(plan.counts.alreadyReviewedEncounters).toBe(1);
  });

  it("never proposes a verified or human-edited row", () => {
    const notes = notesFor(
      [enc("v", { status: "VERIFIED" }), enc("h", { status: "HUMAN_EDITED" })],
      [{ rowIds: ["v"] }, { rowIds: ["h"] }],
    );
    expect(planBatchConfirmation({ notes, events: [] }).rowIds).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("a chronology draft is confirmed only when a record actually supports it", () => {
  it("covers a draft tied to a record this confirmation is settling", () => {
    const notes = notesFor([enc("a")], [{ rowIds: ["a"] }]);
    const plan = planBatchConfirmation({ notes, events: [event("e1"), event("e2")] });
    expect(plan.eventIds).toEqual(["e1", "e2"]);
  });

  it("covers a draft tied to a record a PERSON has already settled", () => {
    const notes = notesFor([enc("a", { status: "VERIFIED" })], [{ rowIds: ["a"] }]);
    const plan = planBatchConfirmation({ notes, events: [event("e1")] });
    // No row to write — but the timeline entry over that settled record is
    // still a draft, and confirming it is exactly this act's job.
    expect(plan.rowIds).toEqual([]);
    expect(plan.eventIds).toEqual(["e1"]);
  });

  it("HOLDS a draft that cites no source document", () => {
    const notes = notesFor([enc("a")], [{ rowIds: ["a"] }]);
    const plan = planBatchConfirmation({ notes, events: [event("orphan", { sourceDocumentId: null })] });
    expect(plan.eventIds).toEqual([]);
    expect(plan.heldEventsByReason).toEqual({ NO_SOURCE_CITATION: 1 });
  });

  it("HOLDS a draft whose document and date carry no canonical record at all", () => {
    // Previously swept in by default: the rule was "include unless an
    // exception exists on this day", and an unexplained event has no
    // exception because it has no record either.
    const notes = notesFor([enc("a", { encounterDate: "2025-03-14" })], [{ rowIds: ["a"] }]);
    const plan = planBatchConfirmation({ notes, events: [event("floating", { eventDate: new Date("2031-01-01T00:00:00Z") })] });
    expect(plan.eventIds).toEqual([]);
    expect(plan.heldEventsByReason).toEqual({ NO_CONFIRMED_RECORD: 1 });
  });

  it("HOLDS a draft whose document is not in this case's records at all", () => {
    const notes = notesFor([enc("a")], [{ rowIds: ["a"] }]);
    const plan = planBatchConfirmation({ notes, events: [event("elsewhere", { sourceDocumentId: "doc-unknown" })] });
    expect(plan.eventIds).toEqual([]);
    expect(plan.heldEventsByReason).toEqual({ NO_CONFIRMED_RECORD: 1 });
  });

  it("leaves an edited draft and a stale entry exactly as they are", () => {
    const notes = notesFor([enc("a")], [{ rowIds: ["a"] }]);
    const plan = planBatchConfirmation({
      notes,
      events: [event("edited", { edited: true }), event("stale", { reviewStatus: "STALE" }), event("reviewed", { reviewStatus: "REVIEWED" })],
    });
    expect(plan.eventIds).toEqual([]);
    // Not "held" either: nobody is waiting on anything. They are simply not
    // this act's business.
    expect(plan.counts.heldEvents).toBe(0);
  });

  it("holds back an entry on a document-and-date whose record is still in question", () => {
    const notes = notesFor(
      [enc("clean", { encounterDate: "2025-04-02" }), enc("broken", { auditResult: "FAILED", encounterDate: "2025-03-14" })],
      [{ rowIds: ["clean"] }, { rowIds: ["broken"] }],
    );
    const plan = planBatchConfirmation({
      notes,
      events: [event("contested"), event("clear", { eventDate: new Date("2025-04-02T00:00:00Z") })],
    });
    expect(plan.eventIds).toEqual(["clear"]);
    expect(plan.heldEventsByReason).toEqual({ RECORD_IN_QUESTION: 1 });
    // One exception holds its own date in its own document, never the case.
    expect(plan.counts.events).toBe(1);
  });

  it("holds an entry whose day is waiting on an ambiguity decision", () => {
    const plan = planBatchConfirmation({ notes: notesFor(unsureCluster(3)), events: [event("e1")] });
    expect(plan.eventIds).toEqual([]);
    expect(plan.heldEventsByReason).toEqual({ RECORD_IN_QUESTION: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("confirming changes review state and nothing else", () => {
  // The acceptance property: this act may not improve, condense or reduce the
  // extracted record in order to shrink a queue.
  const rows = [
    enc("a", { segmentKey: "n1", claims: [{ field: "subjective", value: "Low back pain radiating to the left leg", excerpt: "low back pain", page: 4, confidence: null }] } as never),
    enc("b", { segmentKey: "n1", claims: [{ field: "objectiveFindings", value: "Straight leg raise positive at forty degrees", excerpt: "SLR positive", page: 5, confidence: null }] } as never),
    enc("c", { segmentKey: "n2", encounterDate: "2025-04-02", claims: [{ field: "plan", value: "Referred for lumbar MRI without contrast", excerpt: "MRI ordered", page: 9, confidence: null }] } as never),
  ];

  /** Everything about the record that the confirmation must NOT alter. */
  const substanceOf = (notes: ReturnType<typeof notesFor>) =>
    notes.map((n) => ({
      id: n.id,
      rowIds: [...n.rowIds].sort(),
      basis: n.membershipBasis,
      encounterDate: n.encounterDate,
      provider: n.provider,
      providers: n.providers,
      facility: n.facility,
      encounterType: n.encounterType,
      pageStart: n.pageStart,
      pageEnd: n.pageEnd,
      claims: n.claims.map((c) => ({ field: c.field, value: c.value, excerpt: c.excerpt, page: c.page })),
      claimCount: n.claimCount,
      summaries: n.rows.map((r) => r.factualSummary),
      contentHashes: n.contentHashes,
    }));

  it("preserves every row, claim, citation, date, provider and canonical group", () => {
    const before = notesFor(rows);
    const plan = planBatchConfirmation({ notes: before, events: [event("e1")] });
    expect(plan.rowIds).toEqual(["a", "b", "c"]);

    // The database write is `status`, `reviewedById`, `reviewedAt` — modelled
    // here by advancing exactly those and nothing else.
    const after = notesFor(rows.map((r) => enc(r.id, { ...r, status: "REVIEWED", reviewedAt: "2026-08-23T00:00:00.000Z" } as never)));

    expect(substanceOf(after)).toEqual(substanceOf(before));
    expect(after).toHaveLength(before.length);
    expect(after.flatMap((n) => n.rows).length).toBe(before.flatMap((n) => n.rows).length);
  });

  it("changes only the review state, and only for the rows it named", () => {
    const before = notesFor(rows);
    const after = notesFor(rows.map((r) => enc(r.id, { ...r, status: "REVIEWED" } as never)));
    expect(before.map((n) => n.status)).toEqual(["AI_AUDIT_PASSED", "AI_AUDIT_PASSED"]);
    expect(after.map((n) => n.status)).toEqual(["REVIEWED", "REVIEWED"]);
    // No longer awaiting anything, and still not verified or attested.
    expect(after.every((n) => n.status !== "VERIFIED")).toBe(true);
    expect(after.every((n) => !n.awaitingAttestation)).toBe(true);
  });

  it("does not deduplicate, condense or drop anything to reduce the queue", () => {
    // Two records that read alike but are separate encounters. A confirmation
    // that "tidied" them would lose a visit.
    const twins = [
      enc("t1", { segmentKey: "s1", encounterDate: "2025-03-14" } as never),
      enc("t2", { segmentKey: "s2", encounterDate: "2025-03-14" } as never),
    ];
    const notes = notesFor(twins);
    const plan = planBatchConfirmation({ notes, events: [] });
    expect(notes).toHaveLength(2);
    expect(plan.counts.canonicalEncounters).toBe(2);
    expect(plan.rowIds).toEqual(["t1", "t2"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the manifest binds the whole plan the reviewer was shown", () => {
  const rows = [enc("a", { segmentKey: "n1" } as never), enc("b", { segmentKey: "n2", encounterDate: "2025-04-02" } as never)];
  const base = () => planBatchConfirmation({ notes: notesFor(rows), events: [event("e1")] });

  it("moves when a row's content moves", () => {
    const changed = planBatchConfirmation({
      notes: notesFor([enc("a", { ...rows[0], contentHash: "changed".padEnd(64, "0") } as never), rows[1]]),
      events: [event("e1")],
    });
    expect(changed.manifestHash).not.toBe(base().manifestHash);
  });

  it("moves when the GROUPING changes but the row set does not", () => {
    // The hole the id/hash/status manifest left open: the same two rows, one
    // canonical encounter instead of two. Same rows, same content, same
    // statuses — a completely different dialog.
    const regrouped = planBatchConfirmation({
      notes: notesFor([
        enc("a", { segmentKey: "same-note" } as never),
        enc("b", { segmentKey: "same-note" } as never),
      ]),
      events: [event("e1")],
    });
    expect(regrouped.counts.canonicalEncounters).toBe(1);
    expect(regrouped.manifestHash).not.toBe(base().manifestHash);
  });

  it("moves when a record changes from eligible to skipped", () => {
    const skipped = planBatchConfirmation({
      notes: notesFor([enc("a", { segmentKey: "n1", auditResult: "FAILED" } as never), rows[1]]),
      events: [event("e1")],
    });
    expect(skipped.manifestHash).not.toBe(base().manifestHash);
  });

  it("moves when a caution appears without changing eligibility", () => {
    const cautioned = planBatchConfirmation({
      notes: notesFor([enc("a", { segmentKey: "n1", auditResult: "EXTRACTION_INCOMPLETE" } as never), rows[1]]),
      events: [event("e1")],
    });
    expect(cautioned.counts.eligibleEncounters).toBe(base().counts.eligibleEncounters);
    expect(cautioned.cautionsByKind).toEqual({ DOCUMENT_INCOMPLETE: 1 });
    expect(cautioned.manifestHash).not.toBe(base().manifestHash);
  });

  it("moves when a chronology entry's PROSE changes and its status does not", () => {
    // A chronology event has no `updatedAt` to compare against, and
    // `sourceFingerprint` fingerprints the claims it was generated from — not
    // the sentence a reader sees. Binding only id/status/date/fingerprint let
    // a rewritten summary be signed as the one that was displayed.
    const rewritten = planBatchConfirmation({
      notes: notesFor(rows),
      events: [event("e1", { summary: "A materially different sentence about this visit." })],
    });
    expect(rewritten.manifestHash).not.toBe(base().manifestHash);
  });

  it("moves for every material chronology field, one at a time", () => {
    const fields: Partial<ConfirmableEvent>[] = [
      { eventType: "SURGERY" },
      { provider: "Someone Else, MD" },
      { facility: "A different hospital" },
      { specialty: "Orthopaedics" },
      { recordType: "OPERATIVE" },
      { diagnosis: "A different assessment" },
      { treatment: "A different plan" },
      { procedure: "A procedure that was not there" },
      { workStatus: "Off work six weeks" },
      { restrictions: "No lifting over ten pounds" },
      { functionalStatus: "Ambulates with a cane" },
      { impairmentRating: "12% whole person" },
      { clinicalSignificance: "Grounds the future-care recommendation" },
      { sourcePage: 42 },
      { sourceQuote: "a different verbatim excerpt" },
      { dateInferred: true },
      { relevanceScore: 90 },
      { relatedness: "RELATED" },
      { seriesMembers: [{ date: "2025-03-14", documentId: "doc-1", page: 4 }] },
      { eventDateEnd: new Date("2025-05-01T00:00:00Z") },
      { extractionId: "run-2" },
    ];
    for (const over of fields) {
      const moved = planBatchConfirmation({ notes: notesFor(rows), events: [event("e1", over)] });
      expect(moved.manifestHash, JSON.stringify(over)).not.toBe(base().manifestHash);
    }
  });

  it("does not depend on the order anything arrived in", () => {
    const forward = planBatchConfirmation({ notes: notesFor(rows), events: [event("e1"), event("e2")] });
    const reversed = planBatchConfirmation({ notes: notesFor([...rows].reverse()), events: [event("e2"), event("e1")] });
    expect(reversed.manifestHash).toBe(forward.manifestHash);
  });

  it("is computed from the same shape the server re-checks with", () => {
    const plan = base();
    const rowsById = new Map(notesFor(rows).flatMap((n) => n.rows.map((r) => [r.id, r] as const)));
    const recomputed = manifestHashOf({
      encounters: plan.encounters,
      rows: plan.rowIds.map((id) => {
        const r = rowsById.get(id)!;
        return { id: r.id, contentHash: r.contentHash, status: r.status };
      }),
      events: [event("e1")],
      counts: plan.counts,
      cautionsByKind: plan.cautionsByKind,
      skippedByReason: plan.skippedByReason,
      heldByReason: plan.heldByReason,
      heldEventsByReason: plan.heldEventsByReason,
      basisCounts: plan.basisCounts,
    });
    expect(recomputed).toBe(plan.manifestHash);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("a cross-document copy is one decision, named once", () => {
  it("does not name the same row twice when it belongs to two documents' notes", () => {
    const primary = enc("r-primary", { sourceDocumentId: "doc-primary" });
    const copy = enc("r-copy", { sourceDocumentId: "doc-copy" });
    const caseRows = new Map([primary, copy].map((r) => [r.id, r]));
    // The primary document's note absorbs the copy (the builder's own
    // linkage); the copy's own document also projects a card for it.
    const primaryNotes = projectNotes("doc-primary", [{ rowIds: ["r-primary", "r-copy"] }], [primary], [], caseRows);
    const copyNotes = projectNotes("doc-copy", [{ rowIds: ["r-copy"] }], [copy], [], caseRows);
    expect(primaryNotes[0].rowIds.sort()).toEqual(["r-copy", "r-primary"]);

    const plan = planBatchConfirmation({ notes: [...primaryNotes, ...copyNotes], events: [] });
    expect(plan.rowIds).toEqual(["r-copy", "r-primary"]);
    expect(new Set(plan.rowIds).size).toBe(plan.rowIds.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the ambiguity decision, before and after", () => {
  /** The four fragments, at whatever statuses the test puts them in. */
  const cluster = (statuses: Record<string, string> = {}) =>
    notesFor(unsureCluster(4).map((r) => enc(r.id, { ...r, status: statuses[r.id] ?? "AI_AUDIT_PASSED" } as never)));

  const anchorOf = (notes: ReturnType<typeof notesFor>) => notes.find((n) => n.ambiguousAssignment || n.ambiguityAwaitingAnchor === false)!;

  it("BEFORE: one required decision, four records held, nothing confirmed", () => {
    const notes = cluster();
    expect(notes.filter((n) => n.ambiguousAssignment)).toHaveLength(1);
    expect(notes.filter((n) => n.ambiguityAwaitingAnchor)).toHaveLength(3);
    // Every one of them knows which question it is waiting on.
    expect(new Set(notes.map((n) => n.ambiguityClusterId)).size).toBe(1);

    const plan = planBatchConfirmation({ notes, events: [] });
    expect(plan.counts.skippedEncounters).toBe(1);
    expect(plan.counts.heldEncounters).toBe(3);
    expect(plan.rowIds).toEqual([]);
  });

  it("EXACTLY ONE decision: reviewing a NON-anchor member releases nothing", () => {
    const notes = cluster();
    const bystander = notes.find((n) => n.ambiguityAwaitingAnchor)!;
    const after = cluster(Object.fromEntries(bystander.rowIds.map((id) => [id, "REVIEWED"])));
    expect(after.filter((n) => n.ambiguousAssignment)).toHaveLength(1);
    const plan = planBatchConfirmation({ notes: after, events: [] });
    expect(plan.rowIds).toEqual([]);
    expect(plan.counts.skippedEncounters).toBe(1);
  });

  it("a CORRECTION to the anchor does not silently settle the assignment", () => {
    // Editing what a record SAYS answers nothing about which record it is.
    const notes = cluster();
    const anchor = notes.find((n) => n.ambiguousAssignment)!;
    const after = cluster(Object.fromEntries(anchor.rowIds.map((id) => [id, "HUMAN_EDITED"])));
    expect(after.filter((n) => n.ambiguousAssignment)).toHaveLength(1);
    expect(planBatchConfirmation({ notes: after, events: [] }).rowIds).toEqual([]);
  });

  it("AFTER an explicit review of the anchor: the question clears and the rest become confirmable", () => {
    const notes = cluster();
    const anchor = notes.find((n) => n.ambiguousAssignment)!;
    const after = cluster(Object.fromEntries(anchor.rowIds.map((id) => [id, "REVIEWED"])));

    // Not an immortal exception: it is gone from the surface…
    expect(after.filter((n) => n.ambiguousAssignment)).toHaveLength(0);
    expect(after.filter((n) => n.ambiguityAwaitingAnchor)).toHaveLength(0);
    // …and from the metric.
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments: ingestSegments(["2025-03-14"]) }],
      rows: after.flatMap((n) => n.rows).map(asBurdenRow),
      findings: [],
      pages: [],
    });
    expect(burden.ambiguousAssignments).toBe(0);
    expect(burden.requiredDecisions).toBe(0);

    // …and the three that were waiting are now covered by the next batch.
    const plan = planBatchConfirmation({ notes: after, events: [] });
    expect(plan.counts.skippedEncounters).toBe(0);
    expect(plan.counts.heldEncounters).toBe(0);
    expect(plan.counts.eligibleEncounters).toBe(3);
    expect(plan.rowIds.sort()).toEqual(anchor.rowIds.length === 1 ? ["u1", "u2", "u3"] : plan.rowIds.sort());
    // The anchor itself is not re-confirmed — a person already decided it.
    expect(plan.rowIds).not.toContain(anchor.rowIds[0]);
    expect(plan.counts.alreadyReviewedEncounters).toBe(1);
  });

  it("the metric asks the question once, before and never after", () => {
    const before = measureReviewBurden({
      documents: [{ id: "doc-1", segments: ingestSegments(["2025-03-14"]) }],
      rows: cluster().flatMap((n) => n.rows).map(asBurdenRow),
      findings: [],
      pages: [],
    });
    expect(before.ambiguousAssignments).toBe(1);
    expect(before.requiredDecisions).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("one bad appearance vetoes its rows everywhere", () => {
  it("does not confirm a shared row through its clean appearance", () => {
    // The same record produced twice. The primary document's note absorbs
    // both rows and is clean; the copy's own document projects a card for the
    // copy row, and THAT one carries a blocking finding. Unioning the rows of
    // the eligible decisions alone would confirm the copy row anyway.
    const primary = enc("r-primary", { sourceDocumentId: "doc-primary" });
    const copy = enc("r-copy", { sourceDocumentId: "doc-copy" });
    const caseRows = new Map([primary, copy].map((r) => [r.id, r]));
    const primaryNotes = projectNotes("doc-primary", [{ rowIds: ["r-primary", "r-copy"] }], [primary], [], caseRows);
    const copyNotes = projectNotes("doc-copy", [{ rowIds: ["r-copy"] }], [copy], [finding({ encounterId: "r-copy" })], caseRows);

    expect(primaryNotes[0].needsAttention).toBe(false);
    expect(copyNotes[0].needsAttention).toBe(true);

    const plan = planBatchConfirmation({ notes: [...primaryNotes, ...copyNotes], events: [] });
    // The shared row is not confirmed through the clean appearance…
    expect(plan.rowIds).toEqual([]);
    // …and the problem is still reported ONCE, at decision grain.
    expect(plan.counts.skippedEncounters).toBe(1);
    expect(plan.counts.heldEncounters).toBe(1);
    expect(plan.heldByReason).toEqual({ ROW_BLOCKED_ELSEWHERE: 1 });
  });

  it("still confirms a shared row when EVERY appearance is clean", () => {
    const primary = enc("r-primary", { sourceDocumentId: "doc-primary" });
    const copy = enc("r-copy", { sourceDocumentId: "doc-copy" });
    const caseRows = new Map([primary, copy].map((r) => [r.id, r]));
    const plan = planBatchConfirmation({
      notes: [
        ...projectNotes("doc-primary", [{ rowIds: ["r-primary", "r-copy"] }], [primary], [], caseRows),
        ...projectNotes("doc-copy", [{ rowIds: ["r-copy"] }], [copy], [], caseRows),
      ],
      events: [],
    });
    expect(plan.rowIds).toEqual(["r-copy", "r-primary"]);
    expect(plan.heldByReason).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("an entry the factual audit never graded is not clean", () => {
  it("is an EXCEPTION on the surface, not a silent pass", () => {
    const [note] = notesFor([enc("a", { auditResult: null } as never)], [{ rowIds: ["a"] }]);
    expect(note.auditResult).toBeNull();
    expect(note.guidance.kind).toBe("UNAUDITED");
    expect(note.attention).toBe("EXCEPTION");
    expect(note.guidance.canAttest).toBe(false);
  });

  it("cannot be batch-confirmed", () => {
    const plan = planBatchConfirmation({ notes: notesFor([enc("a", { auditResult: null } as never)], [{ rowIds: ["a"] }]), events: [] });
    expect(plan.rowIds).toEqual([]);
    expect(plan.skippedByReason).toEqual({ UNAUDITED: 1 });
  });

  it("makes a MULTI-row note unaudited when any one fragment was never graded", () => {
    // The note's audit result used to fall back to PASS when no row carried
    // one, so an ungraded note presented a clean audit.
    const [note] = notesFor(
      [enc("a", { segmentKey: "n" } as never), enc("b", { segmentKey: "n", auditResult: null } as never)],
      null,
    );
    expect(note.rowIds.sort()).toEqual(["a", "b"]);
    expect(note.auditResult).toBeNull();
    expect(note.needsAttention).toBe(true);
  });

  it("is released by a human CORRECTION, which is a decision, not by a batch", () => {
    const corrected = notesFor([enc("a", { auditResult: null, status: "HUMAN_EDITED", editedFields: ["factualSummary"] } as never)], [{ rowIds: ["a"] }]);
    expect(corrected[0].needsAttention).toBe(false);
    // …and there is nothing left for the batch to write, because a person
    // already owns the row.
    expect(planBatchConfirmation({ notes: corrected, events: [] }).rowIds).toEqual([]);
  });
});
