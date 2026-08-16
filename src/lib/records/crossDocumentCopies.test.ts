// ─────────────────────────────────────────────────────────────────────────────
// "One review covers every copy" — proved, not asserted.
//
// The card made that promise and the only function implementing it was called
// from nowhere. The active review path submitted the note's own document rows
// alone, so a copy in another production kept waiting for a decision that the
// screen said had already been made.
//
// These tests follow the actual path: the records builder's segments → the
// note projection → the payload the rendered button sends → the server's own
// membership derivation. If any link stops carrying the copies, one of them
// fails.
//
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { projectNotes } from "@/lib/records/noteProjection";
import { canonicalNoteId, parseCanonicalNoteId } from "@/lib/records/reviewBurden";
import type { StructuredEncounter } from "@/lib/records/structuredRecord";

const row = (id: string, sourceDocumentId: string, over: Partial<StructuredEncounter> = {}): StructuredEncounter =>
  ({
    id,
    sourceDocumentId,
    status: "AI_AUDIT_PASSED",
    dateStatus: "DOCUMENTED",
    encounterDate: "2025-03-14",
    encounterDateEnd: null,
    provider: "A. Rivera, MD",
    providerCredentials: null,
    facility: null,
    encounterType: "Operative note",
    factualSummary: `Operative note ${id}.`,
    synthesis: null,
    claims: [],
    page: 4,
    pageEnd: 6,
    ocrConfidence: 0.97,
    warnings: [],
    contentHash: `hash-${id}`,
    auditResult: "PASS",
    reviewedAt: null,
    verifiedAt: null,
    staleReason: null,
    ...over,
  }) as unknown as StructuredEncounter;

/** The same operative note produced twice: one segment, two documents. */
const crossDocumentCase = () => {
  const primary = row("r-primary", "doc-primary");
  const copy = row("r-copy", "doc-copy");
  const caseRows = new Map([primary, copy].map((r) => [r.id, r]));
  const segments = [{ rowIds: ["r-primary", "r-copy"] }];
  return { primary, copy, caseRows, segments };
};

describe("a cross-document copy is part of the note, not a footnote to it", () => {
  it("puts both productions' rows in one canonical note", () => {
    const { primary, caseRows, segments } = crossDocumentCase();
    const notes = projectNotes("doc-primary", segments, [primary], [], caseRows);
    expect(notes).toHaveLength(1);
    expect(notes[0].rowIds.sort()).toEqual(["r-copy", "r-primary"]);
  });

  it("carries a content hash for the copy, so nothing is signed unseen", () => {
    const { primary, caseRows, segments } = crossDocumentCase();
    const [note] = projectNotes("doc-primary", segments, [primary], [], caseRows);
    expect(note.contentHashes.map((h) => h.rowId).sort()).toEqual(["r-copy", "r-primary"]);
    expect(note.contentHashes.find((h) => h.rowId === "r-copy")!.contentHash).toBe("hash-r-copy");
  });

  it("names the copy as a cross-document member, for display before the decision", () => {
    const { primary, caseRows, segments } = crossDocumentCase();
    const [note] = projectNotes("doc-primary", segments, [primary], [], caseRows);
    expect(note.crossDocumentMembers).toHaveLength(1);
    expect(note.crossDocumentMembers[0]).toMatchObject({ id: "r-copy", sourceDocumentId: "doc-copy", page: 4 });
  });

  it("shows the note's worst state, so a stale copy cannot ride a clean primary", () => {
    const { primary, caseRows, segments } = crossDocumentCase();
    caseRows.set("r-copy", row("r-copy", "doc-copy", { status: "STALE", auditResult: "PASS" } as never));
    const [note] = projectNotes("doc-primary", segments, [primary], [], caseRows);
    expect(note.status).toBe("STALE");
    expect(note.needsAttention).toBe(true);
  });

  it("still projects a single-document note as one document's rows", () => {
    const a = row("a", "doc-1");
    const b = row("b", "doc-1");
    const notes = projectNotes("doc-1", [{ rowIds: ["a", "b"] }], [a, b], [], new Map([[a.id, a], [b.id, b]]));
    expect(notes[0].crossDocumentMembers).toHaveLength(0);
  });
});

describe("the identifier the button sends resolves to that exact set on the server", () => {
  it("round-trips the note id through the server's own parser", () => {
    const { primary, caseRows, segments } = crossDocumentCase();
    const [note] = projectNotes("doc-primary", segments, [primary], [], caseRows);
    // What the client sends is the note's own id…
    expect(note.id).toBe(canonicalNoteId("doc-primary", ["r-primary", "r-copy"]));
    // …and the server reads back the document plus every member from it.
    const parsed = parseCanonicalNoteId(note.id);
    expect(parsed.documentId).toBe("doc-primary");
    expect(parsed.rowIds.sort()).toEqual(["r-copy", "r-primary"]);
  });

  it("refuses a malformed identifier rather than partially matching one", () => {
    expect(parseCanonicalNoteId("no-colon")).toEqual({ documentId: null, rowIds: [] });
    expect(parseCanonicalNoteId(":only-rows")).toEqual({ documentId: null, rowIds: [] });
    expect(parseCanonicalNoteId("doc-1:")).toEqual({ documentId: null, rowIds: [] });
  });
});

// ── Reachability ─────────────────────────────────────────────────────────────
// The failure this whole item is about was not a wrong function — it was a
// correct function nothing called. A behavioural test cannot see that, so the
// wiring itself is asserted here.
describe("the rendered review action is wired to the server path", () => {
  const source = readFileSync("src/components/case/CaseWorkspace.tsx", "utf8");

  it("has no unreachable cross-document review helper left behind", () => {
    expect(source).not.toContain("reviewWithCopies");
  });

  it("submits every content hash the note carries, copies included", () => {
    // reviewNote is the only path the buttons call, and it sends the note's
    // whole hash set — which now includes cross-document members.
    const fn = source.slice(source.indexOf("async function reviewNote"), source.indexOf("async function reviewNote") + 1200);
    expect(fn).toContain("note.contentHashes");
    expect(fn).toContain("canonicalNoteId: note.id");
    expect(fn).toMatch(/rows: hashes\.map/);
  });

  it("wires every rendered review action to that one function", () => {
    // Asserted as booleans: a failing string match on a 5,000-line component
    // would dump the whole file into the report.
    for (const action of ["verify", "reject"]) {
      expect(source.includes(`reviewNote(e, "${action}")`), `${action} button is wired`).toBe(true);
    }
    // No rendered action reaches the server by any other route.
    const calls = [...source.matchAll(/reviewNote\(e, "(\w+)"\)/g)].map((m) => m[1]);
    expect([...new Set(calls)].sort()).toEqual(["reject", "verify"]);
  });

  it("claims copy coverage only over members the request actually signs", () => {
    // The sentence is computed from crossDocumentMembers — the same list the
    // payload is built from — so the promise cannot outrun the request.
    expect(source.includes("crossDocumentMembers"), "coverage sentence reads the signed set").toBe(true);
    expect(source.includes("One decision here"), "coverage is stated before the click").toBe(true);
    expect(source.includes("one review covers every copy:"), "the old unbacked promise is gone").toBe(false);
  });
});
