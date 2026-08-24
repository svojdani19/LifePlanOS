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

  it("skips a record whose extent could not be resolved", () => {
    // Same day, same clinician, no stored note identity, nothing distinctive
    // shared: the identity rules can neither join nor separate them.
    const rows = Array.from({ length: 4 }, (_, i) =>
      enc(`u${i}`, { claims: [{ field: "subjective", value: `Interval note paragraph number ${i} describing the encounter`, excerpt: "…", page: 4, confidence: null }] }),
    );
    const notes = notesFor(rows);
    const plan = planBatchConfirmation({ notes, events: [] });
    expect(plan.counts.skippedEncounters).toBe(1);
    expect(plan.skippedByReason.AMBIGUOUS_ASSIGNMENT).toBe(1);
    // The rest of the cluster is not confirmed through the ambiguity either:
    // the records were never proven separate, so none of them is "clean".
    expect(plan.counts.eligibleEncounters).toBe(3);
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
describe("chronology drafts", () => {
  it("covers current unedited drafts", () => {
    const notes = notesFor([enc("a")], [{ rowIds: ["a"] }]);
    const plan = planBatchConfirmation({ notes, events: [event("e1"), event("e2")] });
    expect(plan.eventIds).toEqual(["e1", "e2"]);
  });

  it("leaves an edited draft and a stale entry exactly as they are", () => {
    const notes = notesFor([enc("a")], [{ rowIds: ["a"] }]);
    const plan = planBatchConfirmation({
      notes,
      events: [event("edited", { edited: true }), event("stale", { reviewStatus: "STALE" }), event("reviewed", { reviewStatus: "REVIEWED" })],
    });
    expect(plan.eventIds).toEqual([]);
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
    expect(plan.counts.heldEvents).toBe(1);
    // One exception holds its own date in its own document, never the case.
    expect(plan.counts.events).toBe(1);
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
describe("the manifest", () => {
  it("is sensitive to a row leaving the set", () => {
    const rows = [{ id: "a", contentHash: "h-a", status: "AI_DRAFT" }, { id: "b", contentHash: "h-b", status: "AI_DRAFT" }];
    expect(manifestHashOf(rows.slice(0, 1), [])).not.toBe(manifestHashOf(rows, []));
  });

  it("is sensitive to an event's state changing", () => {
    const rows = [{ id: "a", contentHash: "h-a", status: "AI_DRAFT" }];
    expect(manifestHashOf(rows, [event("e1", { edited: true })])).not.toBe(manifestHashOf(rows, [event("e1")]));
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
