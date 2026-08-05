// Correction learning — firm-scoped, fact-free, bounded. An exemplar teaches
// formatting/extraction choices; it can never transfer patient names, dates,
// providers, or any case fact into another case's prompt.
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  findMany: vi.fn(async () => [] as { guidance: string; documentType: string | null; promoted: boolean }[]),
  create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ex-1", ...data })),
}));
vi.mock("@/lib/db", () => ({ prisma: { correctionExemplar: { findMany: db.findMany, create: db.create } } }));

import { guidanceFor, diffFields, fetchExemplarGuidance, recordCorrectionExemplar, type CorrectionCategory } from "./correctionExemplars";

const CATEGORIES: CorrectionCategory[] = ["WRONG_FIELD", "BOILERPLATE_REMOVED", "DATE_CORRECTED", "PROVIDER_CORRECTED", "EXCERPT_MISMATCH", "SUMMARY_REWORDED", "OTHER"];

beforeEach(() => {
  db.findMany.mockClear();
  db.create.mockClear();
  db.findMany.mockResolvedValue([]);
});

describe("fact-free guidance (case facts never transfer)", () => {
  it("guidance sentences never contain snapshot values — only field NAMES and style guidance", () => {
    const draft = { factualSummary: "Seen by Dr. Angela Pierce on 03/14/2025 for lumbar radiculopathy at Springfield Ortho", provider: "Angela Pierce, MD" };
    const corrected = { factualSummary: "Clinic visit — Assessment: lumbar radiculopathy", provider: "Angela Pierce, MD" };
    const diffs = diffFields(draft, corrected);
    for (const cat of CATEGORIES) {
      const g = guidanceFor(cat, diffs);
      // No patient/provider/facility/date material from the snapshots.
      expect(g).not.toMatch(/Pierce|Springfield|radiculopathy|03\/14|2025/);
      expect(g.length).toBeGreaterThan(20);
    }
  });

  it("diffFields reports structural change types, not values", () => {
    const diffs = diffFields({ a: "x", b: "y", c: null }, { a: "x2", c: "added", d: "new" });
    expect(diffs).toEqual(
      expect.arrayContaining([
        { field: "a", changeType: "reworded" },
        { field: "b", changeType: "removed" },
        { field: "c", changeType: "added" },
        { field: "d", changeType: "added" },
      ]),
    );
    expect(JSON.stringify(diffs)).not.toMatch(/x2|new/);
  });
});

describe("tenant-safe retrieval", () => {
  it("queries are scoped to the requesting FIRM — never across firms", async () => {
    await fetchExemplarGuidance("firm-A", "PROGRESS_NOTE");
    expect(db.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ firmId: "firm-A" }) }));
  });

  it("returns only bounded, deduplicated guidance sentences — never snapshots", async () => {
    db.findMany.mockResolvedValue([
      { guidance: "Reviewers here prefer terse, neutral phrasing in summaries; avoid narrative filler and keep the documented terminology.", documentType: "PROGRESS_NOTE", promoted: true },
      { guidance: "Reviewers here prefer terse, neutral phrasing in summaries; avoid narrative filler and keep the documented terminology.", documentType: "PROGRESS_NOTE", promoted: false },
      { guidance: "Reviewers here correct encounter dates; prefer explicit service-date labels over any other date on the page.", documentType: null, promoted: false },
    ]);
    const out = await fetchExemplarGuidance("firm-A", "PROGRESS_NOTE", 3);
    expect(out).toHaveLength(2); // deduplicated
    expect(out.every((g) => typeof g === "string")).toBe(true);
  });

  it("RECORD_EXEMPLARS=off disables retrieval entirely (safe fallback)", async () => {
    process.env.RECORD_EXEMPLARS = "off";
    try {
      expect(await fetchExemplarGuidance("firm-A", "PROGRESS_NOTE")).toEqual([]);
      expect(db.findMany).not.toHaveBeenCalled();
    } finally {
      delete process.env.RECORD_EXEMPLARS;
    }
  });
});

describe("recording", () => {
  it("stores the correction under its own firm+case with structured diffs and provenance", async () => {
    await recordCorrectionExemplar({
      firmId: "firm-A",
      caseId: "case-1",
      encounterId: "enc-1",
      documentType: "PROGRESS_NOTE",
      category: "SUMMARY_REWORDED",
      draft: { factualSummary: "old" },
      corrected: { factualSummary: "new" },
      reviewerId: "user-1",
      promptVersion: "rex-1.0",
      schemaVersion: "rex-enc-1",
      model: "test-model",
    });
    const data = db.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.firmId).toBe("firm-A");
    expect(data.caseId).toBe("case-1");
    expect(data.reviewerId).toBe("user-1");
    expect(data.promptVersion).toBe("rex-1.0");
    expect(String(data.guidance)).not.toMatch(/\bold\b|\bnew\b/); // fact-free
  });
});
