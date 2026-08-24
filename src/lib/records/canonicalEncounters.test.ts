// ─────────────────────────────────────────────────────────────────────────────
// One canonical encounter, one decision — proved end to end.
//
// The defect these exist to prevent: a document whose `segments` still carry
// the INGEST-time shape (dates, pages, offsets, a summary — written before any
// extraction row existed, so no rowIds) presented every extraction fragment as
// its own signature. Hundreds of decisions for a chart documenting dozens of
// visits, and the review surface, the burden metric and the server each
// answering "which rows are this note?" separately.
//
// The rules under test, in the order they matter:
//   • valid persisted rowIds are authoritative and never re-litigated;
//   • the fallback runs only where there is no stored membership at all;
//   • a shared DATE merges nothing — ever;
//   • ambiguity is raised once for the cluster, never once per fragment;
//   • no fallback path can reach outside the document it was called for;
//   • a clean record stays visible without becoming a mandatory click.
//
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { groupCanonicalEncounters, hasEnrichedRowMembership, resolvedAmbiguityClusters, type CanonicalRow } from "@/lib/records/canonicalEncounters";
import { projectNotes } from "@/lib/records/noteProjection";
import { measureReviewBurden, canonicalNoteId, type BurdenRow } from "@/lib/records/reviewBurden";
import type { StructuredEncounter } from "@/lib/records/structuredRecord";

/**
 * The ingest-time segment shape, exactly as `segmentDocument` writes it — the
 * legacy state these tests are about. It carries no rowIds, because at the
 * moment it was written no extraction row existed to name.
 */
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

/** A row as every consumer of the grouping sees it. */
const base = (id: string, over: Partial<CanonicalRow> = {}): CanonicalRow => ({
  id,
  sourceDocumentId: "doc-1",
  encounterDate: "2025-03-14",
  dateStatus: "DOCUMENTED",
  analysisClass: "CLINICAL_ENCOUNTER",
  provider: "A. Rivera, MD",
  facility: "Northgate Clinic",
  page: 4,
  pageEnd: 4,
  substanceClass: "CLINICAL",
  segmentKey: null,
  claims: [],
  ...over,
});

const memberships = (input: Parameters<typeof groupCanonicalEncounters>[0]) =>
  groupCanonicalEncounters(input)
    .map((g) => [...g.rowIds].sort().join(","))
    .sort();

// ─────────────────────────────────────────────────────────────────────────────
describe("fragments of one proven note become one canonical encounter", () => {
  it("joins fragments that carry the same stored note identity", () => {
    // The strongest evidence there is, short of a persisted rowId: the
    // extraction recorded which sub-document each fragment came from.
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments: ingestSegments(["2025-03-14"]) }],
      rows: [
        base("a", { segmentKey: "op-note-1", claims: [{ field: "procedure", value: "L4-5 microdiscectomy performed" }] }),
        base("b", { segmentKey: "op-note-1", claims: [{ field: "findings", value: "Extruded disc fragment removed intact" }] }),
        base("c", { segmentKey: "op-note-1", claims: [{ field: "ebl", value: "Estimated blood loss 30 millilitres" }] }),
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].rowIds.sort()).toEqual(["a", "b", "c"]);
    expect(groups[0].basis).toBe("COMPATIBILITY_FALLBACK");
    expect(groups[0].ambiguityAnchor).toBe(false);
    expect(groups[0].ambiguityClusterId).toBeNull();
  });

  it("joins fragments that name the same record identifier", () => {
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments: null }],
      rows: [
        base("a", { claims: [{ field: "study", value: "Accession number RA-88213 lumbar MRI without contrast" }] }),
        base("b", { claims: [{ field: "impression", value: "Accession RA-88213: broad-based disc protrusion at L4-5" }] }),
      ],
    });
    expect(memberships({ documents: [{ id: "doc-1", segments: null }], rows: [] })).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].rowIds.sort()).toEqual(["a", "b"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("a date is not an identity", () => {
  it("keeps two visits to different clinicians on one day apart", () => {
    const rows = [
      base("clinic", { provider: "A. Rivera, MD", claims: [{ field: "assessment", value: "Lumbar radiculopathy, conservative care continued" }] }),
      base("therapy", { provider: "M. Okonkwo, PT", claims: [{ field: "treatment", value: "Manual therapy and lumbar traction at sixty pounds" }] }),
    ];
    const groups = groupCanonicalEncounters({ documents: [{ id: "doc-1", segments: ingestSegments(["2025-03-14"]) }], rows });
    expect(groups).toHaveLength(2);
    // Proven different, so there is nothing unresolved to ask about.
    expect(groups.every((g) => !g.ambiguityAnchor && !g.ambiguityClusterId)).toBe(true);
  });

  it("keeps two notes of incompatible clinical class on one day apart", () => {
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments: ingestSegments(["2025-03-14"]) }],
      rows: [
        base("op", { analysisClass: "OPERATIVE", claims: [{ field: "procedure", value: "L4-5 microdiscectomy performed under general anaesthesia" }] }),
        base("mri", { analysisClass: "DIAGNOSTIC_STUDY", claims: [{ field: "impression", value: "Broad-based disc protrusion at L4-5 with foraminal narrowing" }] }),
      ],
    });
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.ambiguityAnchor && !g.ambiguityClusterId)).toBe(true);
  });

  it("keeps two notes with different stored note identities apart", () => {
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments: ingestSegments(["2025-03-14"]) }],
      rows: [
        base("op", { segmentKey: "operative-report" }),
        base("dc", { segmentKey: "discharge-summary" }),
      ],
    });
    expect(groups).toHaveLength(2);
  });

  it("keeps two visits at different documented times apart", () => {
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments: ingestSegments(["2025-03-14"]) }],
      rows: [
        base("am", { claims: [{ field: "subjective", value: "Time: 08:15 patient reports worsening low back pain overnight" }] }),
        base("pm", { claims: [{ field: "subjective", value: "Time: 16:40 patient returns after a fall in the car park" }] }),
      ],
    });
    expect(groups).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("undated fragments", () => {
  const undated = (id: string, over: Partial<CanonicalRow> = {}) =>
    base(id, { encounterDate: null, dateStatus: "UNKNOWN", ...over });

  it("may group when they carry the SAME stored note identity", () => {
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments: null }],
      rows: [undated("a", { segmentKey: "letter-1" }), undated("b", { segmentKey: "letter-1" })],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].rowIds.sort()).toEqual(["a", "b"]);
  });

  it("stay separate without it — two dateless rows have nothing in common", () => {
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments: null }],
      rows: [
        undated("a", { claims: [{ field: "correspondence", value: "Records request acknowledged and forwarded to counsel" }] }),
        undated("b", { claims: [{ field: "correspondence", value: "Fee schedule for reproduction of medical records" }] }),
      ],
    });
    expect(groups.map((g) => g.rowIds)).toEqual([["a"], ["b"]]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("valid persisted row ids are authoritative", () => {
  it("reproduces the builder's grouping exactly, and never re-derives it", () => {
    // These three rows name different providers and different classes: the
    // identity rules would hold them apart. The builder — which had the
    // document text, the note structure and the adjudicator — put them in one
    // note, and that answer stands.
    const rows = [
      base("a", { provider: "A. Rivera, MD", analysisClass: "OPERATIVE" }),
      base("b", { provider: "M. Okonkwo, PT", analysisClass: "THERAPY_COURSE" }),
      base("c", { provider: "S. Vance, MD", analysisClass: "DIAGNOSTIC_STUDY" }),
    ];
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments: [{ rowIds: ["a", "b", "c"] }] }],
      rows,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].rowIds).toEqual(["a", "b", "c"]);
    expect(groups[0].basis).toBe("PERSISTED_SEGMENT");
  });

  it("leaves a row no enriched segment claimed as a note of one", () => {
    // One enriched segment means the builder DID answer for this document.
    // Its answer is kept, and the fallback does not second-guess it.
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments: [{ rowIds: ["a"] }] }],
      rows: [base("a", { segmentKey: "note-1" }), base("orphan", { segmentKey: "note-1" })],
    });
    expect(groups.map((g) => g.rowIds)).toEqual([["a"], ["orphan"]]);
    expect(groups[1].basis).toBe("PERSISTED_SEGMENT_ORPHAN");
  });

  it("does not treat a segment naming only superseded rows as membership", () => {
    // Its rowIds resolve to nothing, so the document has no stored membership
    // and the compatibility path applies.
    const segments = [{ rowIds: ["gone-1", "gone-2"] }];
    expect(hasEnrichedRowMembership(segments, () => false)).toBe(false);
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments }],
      rows: [base("a", { segmentKey: "n" }), base("b", { segmentKey: "n" })],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].basis).toBe("COMPATIBILITY_FALLBACK");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("scope", () => {
  it("never groups across documents on the compatibility path", () => {
    // Byte-identical rows in two productions. Cross-document folding is the
    // persisted linkage's job — a fallback that did it would be a scope
    // widening dressed as a convenience.
    const rows = [
      base("a", { sourceDocumentId: "doc-1", segmentKey: "shared-key" }),
      base("b", { sourceDocumentId: "doc-2", segmentKey: "shared-key" }),
    ];
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments: null }, { id: "doc-2", segments: null }],
      rows,
    });
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.documentId).sort()).toEqual(["doc-1", "doc-2"]);
  });

  it("never invents a row the caller did not supply", () => {
    // `alsoResolvable` is membership only: it lets a PERSISTED segment name a
    // copy elsewhere in the case. It is not a fallback candidate, so it can
    // never be pulled into a group the caller's own rows did not contain.
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments: null }],
      rows: [base("a", { segmentKey: "k" })],
      alsoResolvable: () => true,
    });
    expect(groups.flatMap((g) => g.rowIds)).toEqual(["a"]);
  });

  it("leaves a row whose document was not supplied as a note of one", () => {
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments: null }],
      rows: [base("a", { sourceDocumentId: "doc-elsewhere", segmentKey: "k" }), base("b", { sourceDocumentId: "doc-elsewhere", segmentKey: "k" })],
    });
    expect(groups.map((g) => g.rowIds)).toEqual([["a"], ["b"]]);
    expect(groups.every((g) => g.basis === "SINGLETON_UNKNOWN_DOCUMENT")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ambiguity is one question, not one per fragment", () => {
  /** Same day, same clinician, no stored identity, nothing distinctive shared. */
  const unsure = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      base(`u${i}`, { claims: [{ field: "subjective", value: `Interval note paragraph number ${i} describing the visit` }] }),
    );

  it("raises ONE scoped exception for a cluster of six unresolvable fragments", () => {
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments: ingestSegments(["2025-03-14"]) }],
      rows: unsure(6),
    });
    // Not merged — an unproven merge is a deletion.
    expect(groups).toHaveLength(6);
    // …and not six questions either.
    expect(groups.filter((g) => g.ambiguityAnchor)).toHaveLength(1);
    const flagged = groups.find((g) => g.ambiguityAnchor)!;
    expect(flagged.ambiguousWith).toHaveLength(5);
    expect([...flagged.rowIds, ...flagged.ambiguousWith].sort()).toEqual(["u0", "u1", "u2", "u3", "u4", "u5"]);
    // Every member is MARKED, anchor included, under one cluster identity: the
    // question is asked once, but none of the six is a settled record until it
    // is answered.
    expect(new Set(groups.map((g) => g.ambiguityClusterId)).size).toBe(1);
    expect(groups.every((g) => g.ambiguityClusterId === flagged.ambiguityClusterId)).toBe(true);
  });

  it("is settled by an explicit review of the ANCHOR, and by nothing else", () => {
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments: ingestSegments(["2025-03-14"]) }],
      rows: unsure(4),
    });
    const anchor = groups.find((g) => g.ambiguityAnchor)!;
    const other = groups.find((g) => !g.ambiguityAnchor)!;
    const statuses: Record<string, string> = Object.fromEntries(groups.flatMap((g) => g.rowIds.map((id) => [id, "AI_AUDIT_PASSED"])));
    const settled = () => resolvedAmbiguityClusters(groups, (id) => statuses[id]);

    expect(settled().size).toBe(0);

    // Reviewing a NON-anchor member answers nothing.
    for (const id of other.rowIds) statuses[id] = "REVIEWED";
    expect(settled().size).toBe(0);

    // Nor does correcting the anchor's content: editing what a record SAYS
    // says nothing about which record it is.
    for (const id of anchor.rowIds) statuses[id] = "HUMAN_EDITED";
    expect(settled().size).toBe(0);

    // An explicit review of the anchor is the answer.
    for (const id of anchor.rowIds) statuses[id] = "REVIEWED";
    expect(settled()).toEqual(new Set([anchor.ambiguityClusterId]));

    // …and so is a verification.
    for (const id of anchor.rowIds) statuses[id] = "VERIFIED";
    expect(settled()).toEqual(new Set([anchor.ambiguityClusterId]));
  });

  it("raises nothing when every pair is proven distinct", () => {
    const groups = groupCanonicalEncounters({
      documents: [{ id: "doc-1", segments: ingestSegments(["2025-03-14"]) }],
      rows: [base("a", { segmentKey: "n1" }), base("b", { segmentKey: "n2" }), base("c", { segmentKey: "n3" })],
    });
    expect(groups.filter((g) => g.ambiguityAnchor)).toHaveLength(0);
    expect(groups.every((g) => g.ambiguityClusterId === null)).toBe(true);
  });

  it("is deterministic and order-independent", () => {
    const rows = unsure(4);
    const doc = [{ id: "doc-1", segments: null }];
    const forward = groupCanonicalEncounters({ documents: doc, rows });
    const reversed = groupCanonicalEncounters({ documents: doc, rows: [...rows].reverse() });
    expect(reversed.map((g) => g.rowIds)).toEqual(forward.map((g) => g.rowIds));
    expect(reversed.find((g) => g.ambiguityAnchor)!.rowIds).toEqual(forward.find((g) => g.ambiguityAnchor)!.rowIds);
    expect(reversed.map((g) => g.ambiguityClusterId)).toEqual(forward.map((g) => g.ambiguityClusterId));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The two consumers, on the same input.
// ─────────────────────────────────────────────────────────────────────────────

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
    claims: [{ field: "assessment", value: "Lumbar radiculopathy documented", excerpt: "…", page: 4, confidence: null }],
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
    contentHash: id.padEnd(64, "0"),
    ...over,
  }) as StructuredEncounter;

/** The same rows, in each consumer's own shape. */
const asBurdenRow = (e: StructuredEncounter): BurdenRow => ({
  id: e.id,
  sourceDocumentId: e.sourceDocumentId,
  status: e.status,
  auditResult: e.auditResult ?? null,
  dateStatus: e.dateStatus,
  analysisClass: e.analysisClass,
  encounterDate: e.encounterDate,
  provider: e.provider,
  facility: e.facility,
  segmentKey: (e as { segmentKey?: string | null }).segmentKey ?? null,
  page: e.page,
  pageEnd: e.pageEnd,
  substanceClass: e.substanceClass,
  claims: e.claims,
});

describe("the review surface and the burden metric group identically", () => {
  const cases: { name: string; segments: unknown; rows: StructuredEncounter[] }[] = [
    {
      name: "persisted membership",
      segments: [{ rowIds: ["a", "b"] }, { rowIds: ["c"] }],
      rows: [enc("a"), enc("b"), enc("c")],
    },
    {
      name: "persisted membership with an unclaimed row",
      segments: [{ rowIds: ["a", "b"] }],
      rows: [enc("a"), enc("b"), enc("c")],
    },
    {
      name: "legacy ingest-time segments",
      segments: ingestSegments(["2025-03-14", "2025-04-02"]),
      rows: [
        enc("a", { segmentKey: "note-1" } as never),
        enc("b", { segmentKey: "note-1" } as never),
        enc("c", { segmentKey: "note-2" } as never),
      ],
    },
    { name: "no segments at all", segments: null, rows: [enc("a", { segmentKey: "k" } as never), enc("b", { segmentKey: "k" } as never)] },
  ];

  for (const c of cases) {
    it(`agrees on membership: ${c.name}`, () => {
      const projected = projectNotes("doc-1", c.segments, c.rows, [])
        .map((n) => [...n.rowIds].sort().join(","))
        .sort();
      const burden = measureReviewBurden({
        documents: [{ id: "doc-1", segments: c.segments }],
        rows: c.rows.map(asBurdenRow),
        findings: [],
        pages: [],
      });
      expect(projected).toHaveLength(burden.canonicalNotes);
      // The identifiers a decision is submitted under are the same strings.
      expect(projected.map((ids) => canonicalNoteId("doc-1", ids.split(",")))).toEqual(
        projectNotes("doc-1", c.segments, c.rows, []).map((n) => n.id).sort(),
      );
    });
  }

  it("collapses a legacy document's fragments instead of asking about each one", () => {
    // The reference defect: an ingest-time segment shape, six fragments of two
    // real notes, six mandatory decisions.
    const rows = [
      enc("a1", { segmentKey: "visit-1" } as never),
      enc("a2", { segmentKey: "visit-1" } as never),
      enc("a3", { segmentKey: "visit-1" } as never),
      enc("b1", { segmentKey: "visit-2", encounterDate: "2025-04-02" } as never),
      enc("b2", { segmentKey: "visit-2", encounterDate: "2025-04-02" } as never),
      enc("b3", { segmentKey: "visit-2", encounterDate: "2025-04-02" } as never),
    ];
    const segments = ingestSegments(["2025-03-14", "2025-04-02"]);
    const notes = projectNotes("doc-1", segments, rows, []);
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.membershipBasis === "COMPATIBILITY_FALLBACK")).toBe(true);

    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments }],
      rows: rows.map(asBurdenRow),
      findings: [],
      pages: [],
    });
    expect(burden.canonicalNotes).toBe(2);
    expect(burden.fallbackNotes).toBe(2);
    expect(burden.decisionsBeforeConsolidation).toBe(6);
    // Every fragment is still visible and every note still needs a human — but
    // nobody is being asked six questions, or even two.
    expect(burden.requiredDecisions).toBe(0);
    expect(burden.cleanNotesAwaitingAttestation).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("consolidation loses nothing", () => {
  it("keeps every distinct claim and every citation under the encounter", () => {
    const rows = [
      enc("a", { segmentKey: "n", claims: [{ field: "subjective", value: "Low back pain radiating to the left leg", excerpt: "low back pain", page: 4, confidence: null }] } as never),
      enc("b", { segmentKey: "n", claims: [{ field: "objectiveFindings", value: "Straight leg raise positive at forty degrees", excerpt: "SLR positive", page: 5, confidence: null }] } as never),
      enc("c", { segmentKey: "n", claims: [{ field: "plan", value: "Referred for lumbar MRI without contrast", excerpt: "MRI ordered", page: 5, confidence: null }] } as never),
    ];
    const [note] = projectNotes("doc-1", null, rows, []);
    expect(note.rowIds.sort()).toEqual(["a", "b", "c"]);
    expect(note.claims).toHaveLength(3);
    expect(note.claims.map((c) => c.page).sort()).toEqual([4, 5, 5]);
    // The evidence beneath the decision, row by row.
    expect(note.rows).toHaveLength(3);
    expect(note.contentHashes.map((h) => h.rowId).sort()).toEqual(["a", "b", "c"]);
  });

  it("exposes a material contradiction ONCE, at encounter grain", () => {
    // Fragments the BUILDER joined — it had the document text and the note
    // boundaries — whose dates then disagree. (The compatibility path could
    // not have produced this group: differing dates are a hard conflict there,
    // which is the conservative reading and the right one when there is no
    // stored membership to rely on.)
    const rows = [enc("a", { encounterDate: "2025-03-14" }), enc("b", { encounterDate: "2025-03-15" })];
    const [note] = projectNotes("doc-1", [{ rowIds: ["a", "b"] }], rows, []);
    expect(note.rowIds.sort()).toEqual(["a", "b"]);
    expect(note.materialDisagreement).toEqual(["date"]);
    // One record, one exception — not one per fragment.
    expect(note.needsAttention).toBe(true);
    expect(note.guidance.kind).toBe("FRAGMENT_DISAGREEMENT");
    // Neither reading was silently picked as the winner.
    expect(note.dateStatus).toBe("UNKNOWN");
  });

  it("does not turn a legitimate multi-provider course into a contradiction", () => {
    // A therapy course the builder folded into one record, delivered by two
    // clinicians of the same practice. Both are shown; neither is a defect.
    const rows = [enc("a", { provider: "M. Okonkwo, PT" }), enc("b", { provider: "D. Halloran, PTA" })];
    const [note] = projectNotes("doc-1", [{ rowIds: ["a", "b"] }], rows, []);
    expect(note.providers).toHaveLength(2);
    expect(note.fragmentDisagreement).toContain("provider");
    expect(note.materialDisagreement).toEqual([]);
    expect(note.needsAttention).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("visible and auditable is not the same as a decision owed", () => {
  it("does not make a clean encounter a mandatory exception", () => {
    const [note] = projectNotes("doc-1", [{ rowIds: ["a"] }], [enc("a")], []);
    expect(note.attention).toBe("CLEAN");
    expect(note.requiresDecision).toBe(false);
    // Still short of a human signature, and it says so.
    expect(note.status).not.toBe("VERIFIED");
    expect(note.awaitingAttestation).toBe(true);
    expect(note.coveredByCaseConfirmation).toBe(true);
  });

  it("keeps machine corroboration distinct from human review", () => {
    const [note] = projectNotes(
      "doc-1",
      [{ rowIds: ["a"] }],
      [enc("a", { corroboration: { result: "CORROBORATED", reproduced: 4, total: 4 } })],
      [],
    );
    expect(note.corroboration?.result).toBe("CORROBORATED");
    expect(note.status).toBe("AI_AUDIT_PASSED");
    expect(note.coveredByCaseConfirmation).toBe(true);
  });

  it("counts required decisions as exceptions at their own scope, not as clean notes", () => {
    const rows = [enc("a"), enc("b"), enc("c", { status: "STALE" })];
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments: [{ rowIds: ["a"] }, { rowIds: ["b"] }, { rowIds: ["c"] }] }],
      rows: rows.map(asBurdenRow),
      findings: [
        { id: "f1", fingerprint: "fp-doc", scope: "DOCUMENT", type: "MISSING_ENCOUNTER", status: "OPEN", blocking: true, sourceDocumentId: "doc-1" },
        { id: "f2", fingerprint: "fp-page", scope: "PAGE", type: "PAGE_UNREADABLE", status: "OPEN", blocking: true, sourceDocumentId: "doc-1" },
      ],
      pages: [],
    });
    expect(burden.canonicalNotes).toBe(3);
    expect(burden.cleanNotesAwaitingAttestation).toBe(2);
    // One stale encounter + one document blocker + one page blocker. The two
    // clean encounters are not obligations, and the document blocker is not
    // copied onto them.
    expect(burden.requiredDecisions).toBe(3);
    expect(burden.requiredDecisionsByKind).toEqual({
      encounterExceptions: 1,
      ambiguousAssignments: 0,
      caseBlockers: 0,
      documentBlockers: 1,
      pageBlockers: 1,
    });
  });

  it("counts an ambiguity cluster as ONE required decision, not one per row", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      enc(`u${i}`, { claims: [{ field: "subjective", value: `Interval note paragraph number ${i} describing the encounter`, excerpt: "…", page: 4, confidence: null }] }),
    );
    const segments = ingestSegments(["2025-03-14"]);
    const burden = measureReviewBurden({
      documents: [{ id: "doc-1", segments }],
      rows: rows.map(asBurdenRow),
      findings: [],
      pages: [],
    });
    expect(burden.canonicalNotes).toBe(5);
    expect(burden.ambiguousAssignments).toBe(1);
    expect(burden.requiredDecisions).toBe(1);

    // …and the surface says the same thing, with a reason and next steps.
    const notes = projectNotes("doc-1", segments, rows, []);
    const flagged = notes.filter((n) => n.requiresDecision);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].guidance.kind).toBe("AMBIGUOUS_ASSIGNMENT");
    expect(flagged[0].guidance.steps.length).toBeGreaterThan(0);
    expect(flagged[0].ambiguousWith).toHaveLength(4);
    // Confirming them AS SEPARATE is a legitimate answer, so it is not refused.
    expect(flagged[0].guidance.canAttest).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("existing human work keeps its status and identity", () => {
  it("leaves reviewed, verified and human-edited records exactly as they are", () => {
    const rows = [
      enc("verified", { segmentKey: "n1", status: "VERIFIED", verifiedAt: "2025-05-01T00:00:00.000Z" } as never),
      enc("authored", { segmentKey: "n2", status: "HUMAN_EDITED" } as never),
      enc("reviewed", { segmentKey: "n3", status: "REVIEWED", reviewedAt: "2025-05-02T00:00:00.000Z" } as never),
    ];
    const notes = projectNotes("doc-1", ingestSegments(["2025-03-14"]), rows, []);
    expect(notes).toHaveLength(3);
    for (const n of notes) {
      expect(n.rows[0].status).toBe(n.status);
      expect(n.requiresDecision).toBe(false);
      // A human record is not "awaiting" anything and is not swept into the
      // case-level confirmation either.
      expect(n.awaitingAttestation).toBe(false);
      expect(n.coveredByCaseConfirmation).toBe(false);
    }
    expect(notes.map((n) => n.id).sort()).toEqual(
      ["authored", "reviewed", "verified"].map((id) => canonicalNoteId("doc-1", [id])).sort(),
    );
  });

  it("shows the worst state of a consolidated encounter, so nothing is laundered", () => {
    const rows = [
      enc("clean", { segmentKey: "n", status: "VERIFIED" } as never),
      enc("stale", { segmentKey: "n", status: "STALE", staleReason: "the source changed after review" } as never),
    ];
    const [note] = projectNotes("doc-1", null, rows, []);
    expect(note.rowIds.sort()).toEqual(["clean", "stale"]);
    expect(note.status).toBe("STALE");
    expect(note.requiresDecision).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("a cross-document copy is one decision that keeps every appearance", () => {
  const primary = enc("r-primary", { sourceDocumentId: "doc-primary", contentHash: "hash-primary".padEnd(64, "0") });
  const copy = enc("r-copy", { sourceDocumentId: "doc-copy", page: 11, contentHash: "hash-copy".padEnd(64, "0") });

  it("folds through the persisted linkage only, and keeps both citations", () => {
    const caseRows = new Map([primary, copy].map((r) => [r.id, r]));
    const [note] = projectNotes("doc-primary", [{ rowIds: ["r-primary", "r-copy"] }], [primary], [], caseRows);
    expect(note.rowIds.sort()).toEqual(["r-copy", "r-primary"]);
    expect(note.membershipBasis).toBe("PERSISTED_SEGMENT");
    // Each appearance survives with its own page and its own displayed content.
    expect(note.crossDocumentMembers).toEqual([
      { id: "r-copy", sourceDocumentId: "doc-copy", page: 11, status: "AI_AUDIT_PASSED", contentHash: "hash-copy".padEnd(64, "0") },
    ]);
    expect(note.contentHashes.map((h) => h.contentHash).sort()).toEqual(
      ["hash-copy".padEnd(64, "0"), "hash-primary".padEnd(64, "0")].sort(),
    );
  });

  it("is one obligation in the burden metric, not two", () => {
    const burden = measureReviewBurden({
      documents: [
        { id: "doc-primary", segments: [{ rowIds: ["r-primary", "r-copy"] }] },
        { id: "doc-copy", segments: [] },
      ],
      rows: [primary, copy].map(asBurdenRow),
      findings: [{ id: "f", fingerprint: "fp", scope: "ENTRY", type: "UNSUPPORTED_CLAIM", status: "OPEN", blocking: true, encounterId: "r-copy" }],
      pages: [],
    });
    expect(burden.canonicalNotes).toBe(1);
    expect(burden.crossDocumentCopies).toBe(1);
    // The finding names the copy; the obligation is the one encounter.
    expect(burden.requiredDecisions).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the server's compatibility path cannot widen a query", () => {
  // The membership a signature covers is derived on the server. A legacy
  // document takes a DIFFERENT branch to get there, and a branch that forgot a
  // tenant or case predicate would be a cross-case read reachable by sending a
  // note id — so every row query in these files is checked, not just the new
  // one.
  const ROUTES = [
    "src/app/api/cases/[caseId]/records/encounters/group/route.ts",
    "src/app/api/cases/[caseId]/records/encounters/group/correct/route.ts",
  ];

  for (const file of ROUTES) {
    it(`scopes every row query in ${file.split("/").slice(-2).join("/")} to case and firm`, () => {
      const source = readFileSync(file, "utf8");
      const calls = source.split("prisma.extractedEncounter.findMany(").slice(1);
      expect(calls.length).toBeGreaterThan(1);
      for (const call of calls) {
        const args = call.slice(0, call.indexOf("select:"));
        expect(args).toContain("caseId: params.caseId");
        expect(args).toContain("firmId: ctx.firm.id");
      }
    });

    it(`confines the compatibility grouping to one document in ${file.split("/").slice(-2).join("/")}`, () => {
      const source = readFileSync(file, "utf8");
      const at = source.indexOf("groupCanonicalEncounters({");
      expect(at).toBeGreaterThan(0);
      // The rows it groups are loaded for THIS document…
      const before = source.slice(Math.max(0, at - 1200), at);
      expect(before).toContain("sourceDocumentId: documentId");
      expect(before).toContain("REVIEW_VISIBLE_WHERE");
      // …and only that document's persisted segments are consulted.
      expect(source.slice(at, at + 400)).toContain("documents: [{ id: documentId, segments: doc.segments }]");
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe("one finding is one obligation, against one CURRENT record", () => {
  // A stored `canonicalNoteId` is a snapshot of a grouping, and grouping
  // changes: a finding written while a legacy row was a note of one carries
  // that singleton id, and once the compatibility path folds the row into a
  // real encounter the two disagree. Counting both made one problem two — or,
  // when the row is gone, an obligation against a note nobody can open.
  const rows = [
    enc("a", { segmentKey: "note-1" } as never),
    enc("b", { segmentKey: "note-1" } as never),
  ];
  const segments = ingestSegments(["2025-03-14"]);
  const currentNote = canonicalNoteId("doc-1", ["a", "b"]);
  const staleNote = canonicalNoteId("doc-1", ["a"]);

  const measure = (findings: Parameters<typeof measureReviewBurden>[0]["findings"]) =>
    measureReviewBurden({ documents: [{ id: "doc-1", segments }], rows: rows.map(asBurdenRow), findings, pages: [] });

  it("resolves a finding carrying a STALE note id to the row's current encounter, once", () => {
    const burden = measure([
      { id: "f", fingerprint: "fp", scope: "ENTRY", type: "CONTRADICTED_DATE", status: "OPEN", blocking: true, encounterId: "a", canonicalNoteId: staleNote },
    ]);
    expect(burden.canonicalNotes).toBe(1);
    // Not two obligations, and not one against a note that no longer exists.
    expect(burden.notesWithFindings).toBe(1);
    expect(burden.notesNeedingAttention).toBe(1);
    expect(burden.requiredDecisions).toBe(1);
  });

  it("drops a stale note id that names no current encounter rather than inventing one", () => {
    const burden = measure([
      { id: "f", fingerprint: "fp", scope: "NOTE", type: "STALE_REVIEW", status: "OPEN", blocking: true, canonicalNoteId: canonicalNoteId("doc-1", ["long-gone"]) },
    ]);
    expect(burden.notesWithFindings).toBe(0);
    expect(burden.requiredDecisions).toBe(0);
    // The finding is still counted where it is true: by scope and by type.
    expect(burden.findingsByScope.NOTE).toBe(1);
  });

  it("accepts a stored note id when it still names a current encounter", () => {
    const burden = measure([
      { id: "f", fingerprint: "fp", scope: "NOTE", type: "STALE_REVIEW", status: "OPEN", blocking: true, canonicalNoteId: currentNote },
    ]);
    expect(burden.notesWithFindings).toBe(1);
    expect(burden.requiredDecisions).toBe(1);
  });

  it("treats a NON-BLOCKING finding as a caution, matching the review surface", () => {
    const burden = measure([
      { id: "f", fingerprint: "fp", scope: "ENTRY", type: "NOT_CORROBORATED", status: "OPEN", blocking: false, encounterId: "a" },
    ]);
    // Visible…
    expect(burden.notesWithFindings).toBe(1);
    expect(burden.findingsByScope.ENTRY).toBe(1);
    // …but not a decision somebody owes.
    expect(burden.notesNeedingAttention).toBe(0);
    expect(burden.notesCarryingCaution).toBe(1);
    expect(burden.requiredDecisions).toBe(0);

    // …and the review surface says the same thing about the same finding.
    const note = projectNotes("doc-1", segments, rows, [
      { id: "f", scope: "ENTRY", type: "NOT_CORROBORATED", severity: "WARNING", blocking: false, source: "CORROBORATION", detail: "one field was not reproduced", status: "OPEN", encounterId: "a" },
    ])[0];
    expect(note.needsAttention).toBe(false);
    expect(note.attention).toBe("CAUTION");
  });

  it("counts one encounter carrying several blocking findings as ONE decision", () => {
    const burden = measure([
      { id: "f1", fingerprint: "fp1", scope: "ENTRY", type: "CONTRADICTED_DATE", status: "OPEN", blocking: true, encounterId: "a", canonicalNoteId: staleNote },
      { id: "f2", fingerprint: "fp2", scope: "CLAIM", type: "UNSUPPORTED_CLAIM", status: "OPEN", blocking: true, encounterId: "b" },
    ]);
    expect(burden.findingsByScope).toEqual({ ENTRY: 1, CLAIM: 1 });
    expect(burden.requiredDecisions).toBe(1);
  });
});
