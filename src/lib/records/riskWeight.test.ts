import { describe, it, expect } from "vitest";
import {
  weighNote,
  normalizeConfidence,
  splitByRisk,
  riskSentence,
  WEAK_CLAIM_CONFIDENCE,
  WEAK_OCR_CONFIDENCE,
  THIN_EVIDENCE_CLAIMS,
  WIDE_CONSOLIDATION_ROWS,
  type RiskWeighable,
} from "./riskWeight";

/** A clean note nothing fires on: the baseline the signals are measured against. */
const clean = (over: Partial<RiskWeighable> = {}): RiskWeighable => ({
  id: "n1",
  rowIds: ["r1"],
  claims: [
    { confidence: 0.95 },
    { confidence: 0.92 },
    { confidence: 0.88 },
    { confidence: 0.9 },
  ],
  claimCount: 4,
  rows: [{ ocrConfidence: null, warnings: [] }],
  crossDocumentMembers: [],
  copies: [],
  corroboration: { result: "REPRODUCED", reproduced: 4, total: 4 },
  fragmentDisagreement: [],
  membershipBasis: "PERSISTED_SEGMENT",
  awaitingAttestation: true,
  attention: "CLEAN",
  ...over,
});

const codes = (n: RiskWeighable) => weighNote(n).signals.map((s) => s.code);

describe("weighNote", () => {
  it("leaves a clean, well-evidenced note in the light batch", () => {
    const w = weighNote(clean());
    expect(w.tier).toBe("LOW_RISK");
    expect(w.signals).toEqual([]);
  });

  // ── The guard. This is the property that makes the whole thing safe. ──────
  it("never weighs a note that is not already clean and attestable", () => {
    expect(weighNote(clean({ awaitingAttestation: false })).tier).toBe("NEEDS_EYES");
    expect(weighNote(clean({ attention: "EXCEPTION" })).tier).toBe("NEEDS_EYES");
    expect(weighNote(clean({ attention: "CAUTION" })).tier).toBe("NEEDS_EYES");
    expect(codes(clean({ awaitingAttestation: false }))).toEqual(["NOT_ATTESTABLE"]);
  });

  it("cannot promote anything — the only move is out of the light batch", () => {
    // Every signal combination over a non-attestable note stays NEEDS_EYES.
    const hostile = clean({
      awaitingAttestation: false,
      claims: [{ confidence: 1 }, { confidence: 1 }, { confidence: 1 }],
      claimCount: 99,
      corroboration: { result: "REPRODUCED", reproduced: 9, total: 9 },
    });
    expect(weighNote(hostile).tier).toBe("NEEDS_EYES");
  });

  // ── Extraction confidence ────────────────────────────────────────────────
  it("pulls out a note whose weakest claim is below the confidence bar", () => {
    const n = clean({ claims: [{ confidence: 0.95 }, { confidence: 0.6 }, { confidence: 0.9 }, { confidence: 0.91 }] });
    expect(codes(n)).toContain("WEAK_CLAIM");
    expect(weighNote(n).signals[0].reason).toContain("60%");
  });

  it("keeps a note exactly at the confidence bar in the light batch", () => {
    const n = clean({ claims: [{ confidence: WEAK_CLAIM_CONFIDENCE }, { confidence: 0.9 }, { confidence: 0.91 }, { confidence: 0.92 }] });
    expect(weighNote(n).tier).toBe("LOW_RISK");
  });

  // ── The scale bug this file shipped once and must never ship again. ──────
  it("reads a perfect 1.0 as perfect, not as 1%", () => {
    const n = clean({ claims: [{ confidence: 1 }, { confidence: 1 }, { confidence: 1 }, { confidence: 1 }] });
    expect(weighNote(n).tier).toBe("LOW_RISK");
  });

  it("accepts a 0-100 percentage without inverting it", () => {
    expect(normalizeConfidence(95)).toBeCloseTo(0.95);
    expect(normalizeConfidence(0.95)).toBeCloseTo(0.95);
    expect(weighNote(clean({ claims: [{ confidence: 95 }, { confidence: 92 }, { confidence: 90 }, { confidence: 91 }] })).tier).toBe("LOW_RISK");
    expect(codes(clean({ claims: [{ confidence: 40 }, { confidence: 92 }, { confidence: 90 }] }))).toContain("WEAK_CLAIM");
  });

  it("discards a confidence outside every known scale rather than guessing", () => {
    expect(normalizeConfidence(-1)).toBeNull();
    expect(normalizeConfidence(1000)).toBeNull();
    expect(normalizeConfidence("high")).toBeNull();
  });

  it("pulls out a note carrying a claim-level warning", () => {
    expect(codes(clean({ claims: [{ confidence: 0.95, warning: "value inferred" }, { confidence: 0.92 }, { confidence: 0.9 }] }))).toContain("CLAIM_WARNING");
  });

  // ── Page quality ─────────────────────────────────────────────────────────
  it("pulls out a note read from a poorly-OCR'd page", () => {
    const n = clean({ rows: [{ ocrConfidence: WEAK_OCR_CONFIDENCE - 0.05, warnings: [] }] });
    expect(codes(n)).toContain("WEAK_OCR");
  });

  it("does not treat a native text layer as low-confidence OCR", () => {
    // ocrConfidence null means the page was never OCR'd — the schema is
    // explicit that it is "never a fabricated 0.96". Null must not read as 0.
    expect(weighNote(clean({ rows: [{ ocrConfidence: null, warnings: [] }] })).tier).toBe("LOW_RISK");
  });

  it("pulls out a note whose source page carried an extraction warning", () => {
    expect(codes(clean({ rows: [{ ocrConfidence: null, warnings: ["truncated"] }] }))).toContain("EXTRACTION_WARNING");
  });

  // ── How much the record actually asserts ─────────────────────────────────
  it("pulls out a clean grade that covers very little content", () => {
    const n = clean({ claims: [{ confidence: 0.99 }], claimCount: 1 });
    expect(codes(n)).toContain("THIN_EVIDENCE");
    expect(weighNote(n).signals.find((s) => s.code === "THIN_EVIDENCE")!.reason).toContain("1 value");
  });

  it("keeps a note exactly at the evidence floor", () => {
    const n = clean({ claims: Array.from({ length: THIN_EVIDENCE_CLAIMS }, () => ({ confidence: 0.95 })), claimCount: THIN_EVIDENCE_CLAIMS });
    expect(weighNote(n).tier).toBe("LOW_RISK");
  });

  // ── Assembly ─────────────────────────────────────────────────────────────
  it("pulls out a note joined from many fragments", () => {
    const n = clean({ rowIds: Array.from({ length: WIDE_CONSOLIDATION_ROWS + 1 }, (_, i) => `r${i}`) });
    expect(codes(n)).toContain("WIDE_CONSOLIDATION");
  });

  it("pulls out a note whose fragments disagreed, even immaterially", () => {
    const n = clean({ fragmentDisagreement: ["provider", "facility"] });
    const reason = weighNote(n).signals.find((s) => s.code === "FRAGMENT_DISAGREEMENT")!.reason;
    expect(reason).toContain("provider, facility");
  });

  it("pulls out a record that appears in more than one document", () => {
    expect(codes(clean({ crossDocumentMembers: [{ id: "x" }] }))).toContain("CROSS_DOCUMENT");
    expect(codes(clean({ copies: [{ id: "y" }] }))).toContain("CROSS_DOCUMENT");
  });

  it("pulls out a record whose membership the builder did not establish", () => {
    expect(codes(clean({ membershipBasis: "COMPATIBILITY_FALLBACK" }))).toContain("DERIVED_MEMBERSHIP");
    expect(codes(clean({ membershipBasis: "UNVERIFIABLE_DOCUMENT" }))).toContain("DERIVED_MEMBERSHIP");
    expect(weighNote(clean({ membershipBasis: "PERSISTED_SEGMENT" })).tier).toBe("LOW_RISK");
  });

  // ── Independent re-read ──────────────────────────────────────────────────
  it("pulls out a note a blind second read only partly reproduced", () => {
    const n = clean({ corroboration: { result: "PARTIAL", reproduced: 3, total: 5 } });
    const reason = weighNote(n).signals.find((s) => s.code === "PARTIAL_CORROBORATION")!.reason;
    expect(reason).toContain("3 of 5");
  });

  it("does not fire on a fully reproduced re-read, or on none at all", () => {
    expect(weighNote(clean({ corroboration: { result: "REPRODUCED", reproduced: 5, total: 5 } })).tier).toBe("LOW_RISK");
    expect(weighNote(clean({ corroboration: null })).tier).toBe("LOW_RISK");
  });

  it("reports every signal that fired, not just the first", () => {
    const n = clean({
      claims: [{ confidence: 0.4 }],
      claimCount: 1,
      rows: [{ ocrConfidence: 0.5, warnings: ["truncated"] }],
      crossDocumentMembers: [{ id: "x" }],
    });
    const c = codes(n);
    expect(c).toEqual(expect.arrayContaining(["WEAK_CLAIM", "WEAK_OCR", "EXTRACTION_WARNING", "THIN_EVIDENCE", "CROSS_DOCUMENT"]));
  });

  it("is deterministic — the same note yields the same tier and reasons", () => {
    const n = clean({ claims: [{ confidence: 0.4 }], claimCount: 1 });
    expect(weighNote(n)).toEqual(weighNote(n));
  });

  it("survives absent and malformed fields rather than throwing", () => {
    const bare: RiskWeighable = { id: "n", awaitingAttestation: true, attention: "CLEAN" };
    expect(() => weighNote(bare)).not.toThrow();
    // No claims at all is thin evidence, not a crash and not a free pass.
    expect(weighNote(bare).tier).toBe("NEEDS_EYES");
    const junk = clean({ claims: "nope" as never, rows: 7 as never, fragmentDisagreement: null });
    expect(() => weighNote(junk)).not.toThrow();
  });
});

describe("splitByRisk", () => {
  it("loses nothing — every note lands on exactly one side", () => {
    const notes = [
      clean({ id: "a" }),
      clean({ id: "b", claims: [{ confidence: 0.1 }], claimCount: 1 }),
      clean({ id: "c" }),
      clean({ id: "d", membershipBasis: "COMPATIBILITY_FALLBACK" }),
    ];
    const s = splitByRisk(notes);
    expect(s.lowRisk.length + s.needsEyes.length).toBe(notes.length);
    const ids = [...s.lowRisk.map((n) => n.id), ...s.needsEyes.map((x) => x.note.id)].sort();
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });

  it("ranks the signals by how often they fired, ties broken stably", () => {
    const s = splitByRisk([
      clean({ id: "a", crossDocumentMembers: [{ id: "x" }] }),
      clean({ id: "b", crossDocumentMembers: [{ id: "y" }] }),
      clean({ id: "c", membershipBasis: "COMPATIBILITY_FALLBACK" }),
    ]);
    expect(s.topSignals[0].code).toBe("CROSS_DOCUMENT");
    expect(s.topSignals[0].count).toBe(2);
    expect(s.topSignals[1].code).toBe("DERIVED_MEMBERSHIP");
  });

  it("handles an empty batch", () => {
    expect(splitByRisk([])).toEqual({ lowRisk: [], needsEyes: [], topSignals: [] });
  });
});

describe("riskSentence", () => {
  it("names both numbers and does not imply the read-me set is a problem", () => {
    const s = riskSentence(14, 4);
    expect(s).toContain("14 of 18");
    expect(s).toContain("4 carry");
    expect(s).not.toMatch(/problem|error|fail/i);
  });

  it("says so when nothing needs a second look", () => {
    expect(riskSentence(18, 0)).toBe("All 18 ready records scored low risk.");
  });

  it("says so when everything does", () => {
    expect(riskSentence(0, 3)).toContain("All 3 ready records carry");
  });

  it("handles an empty batch and the singular", () => {
    expect(riskSentence(0, 0)).toBe("No records are ready to confirm.");
    expect(riskSentence(1, 0)).toBe("All 1 ready record scored low risk.");
    expect(riskSentence(5, 1)).toContain("1 carries");
  });
});
