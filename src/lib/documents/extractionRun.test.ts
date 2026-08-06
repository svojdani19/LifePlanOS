// Extraction-run orchestrator — OCR discipline, fail-closed persistence, and
// review lineage (human work survives every regeneration). Synthetic records
// only; a deterministic fake provider stands in for the model.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const db = vi.hoisted(() => {
  const encounters: Record<string, unknown>[] = [];
  let runSeq = 0;
  let encSeq = 0;
  const state = {
    doc: {} as Record<string, unknown>,
    runs: [] as Record<string, unknown>[],
    encounters,
    reset() {
      state.runs.length = 0;
      encounters.length = 0;
      runSeq = 0;
      encSeq = 0;
    },
    prisma: {
      document: { findUniqueOrThrow: async () => state.doc },
      recordExtraction: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `run-${++runSeq}`, ...data };
          state.runs.push(row);
          return row;
        },
      },
      extractedEncounter: {
        findMany: async ({ where }: { where: { status?: { notIn?: string[] } } }) =>
          encounters.filter((e) => !where.status?.notIn || !where.status.notIn.includes(e.status as string)),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `enc-${++encSeq}`, ...data };
          encounters.push(row);
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = encounters.find((e) => e.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
        updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
          for (const e of encounters) if (where.id.in.includes(e.id as string)) Object.assign(e, data);
          return { count: where.id.in.length };
        },
      },
      correctionExemplar: { findMany: async () => [] },
      // Per-page source rows; documents ingested before page tracking report
      // none, which the audit treats as unknown rather than as clean.
      sourcePage: { findMany: async () => [] as { pageNumber: number; status: string; ocrConfidence: number | null }[] },
    },
  };
  return state;
});

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));

import { processDocumentExtraction } from "./extractionRun";
import { fingerprint } from "@/lib/llm/recordExtraction";
import type { LlmProvider } from "@/lib/llm";

const TEXT = [
  "Orthopedic Associates Progress Note. Date of Service: 03/14/2025.",
  "Provider: Dana Rivers, MD.",
  "Assessment: Lumbar radiculopathy.",
  "Plan: Continue physical therapy twice weekly.",
].join("\n");

const GOOD_JSON = JSON.stringify({
  encounters: [
    {
      dateStatus: "DOCUMENTED",
      date: "2025-03-14",
      dateEnd: null,
      dateExcerpt: "Date of Service: 03/14/2025",
      encounterType: "Clinic visit",
      provider: { value: "Dana Rivers, MD", excerpt: "Provider: Dana Rivers, MD", page: null },
      providerCredentials: "MD",
      facility: null,
      claims: [
        { field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: null, confidence: 0.95 },
        { field: "treatment", value: "Continue physical therapy twice weekly", excerpt: "Plan: Continue physical therapy twice weekly", page: null, confidence: 0.9 },
      ],
    },
  ],
});

const provider = (responses: string[]): LlmProvider & { calls: number } => {
  let i = 0;
  const p = {
    name: "fake",
    calls: 0,
    async complete() {
      p.calls++;
      return responses[Math.min(i++, responses.length - 1)];
    },
  };
  return p;
};

function doc(over: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    firmId: "firm-1",
    caseId: "case-1",
    filename: "synthetic-note.pdf",
    type: "PROGRESS_NOTE",
    flags: "",
    extractedText: TEXT,
    ocrConfidence: 0.97,
    ...over,
  };
}

beforeEach(() => {
  db.reset();
  db.doc = doc();
});

describe("OCR discipline — unreadable text never reaches the model", () => {
  it("queued/in-progress OCR blocks extraction with an actionable state and zero model calls", async () => {
    db.doc = doc({ flags: "OCR queued", extractedText: "" });
    const p = provider([GOOD_JSON]);
    const r = await processDocumentExtraction("doc-1", { provider: p, exemplarGuidance: [] });
    expect(r.status).toBe("BLOCKED_OCR");
    expect(r.error).toMatch(/OCR has not completed/);
    expect(p.calls).toBe(0);
    expect(db.encounters).toHaveLength(0);
  });

  it("failed OCR blocks extraction — it can never become factual content", async () => {
    db.doc = doc({ flags: "OCR failed", extractedText: "garbled" });
    const p = provider([GOOD_JSON]);
    const r = await processDocumentExtraction("doc-1", { provider: p, exemplarGuidance: [] });
    expect(r.status).toBe("BLOCKED_OCR");
    expect(p.calls).toBe(0);
    expect(db.encounters).toHaveLength(0);
  });

  it("an empty/illegible document fails closed with a review-facing error — no invented rows", async () => {
    db.doc = doc({ extractedText: "  " });
    const r = await processDocumentExtraction("doc-1", { provider: provider([GOOD_JSON]), exemplarGuidance: [] });
    expect(r.status).toBe("EXTRACTION_FAILED");
    expect(r.error).toMatch(/human review/i);
    expect(db.encounters).toHaveLength(0);
  });
});

describe("fail-closed extraction", () => {
  it("persistently malformed output records EXTRACTION_FAILED — never template prose", async () => {
    const r = await processDocumentExtraction("doc-1", { provider: provider(["not json", "still not json"]), exemplarGuidance: [] });
    expect(r.status).toBe("EXTRACTION_FAILED");
    expect(db.encounters).toHaveLength(0);
    const run = db.runs.at(-1)!;
    expect(run.status).toBe("EXTRACTION_FAILED");
    // The document-level error states the outcome; the per-section reason is
    // disclosed in the warnings.
    expect(String(run.error)).toMatch(/No section of this document could be processed/);
    expect(JSON.stringify(run.warnings)).toMatch(/structured output failed after retry/);
  });
});

describe("persistence with server-controlled provenance", () => {
  it("rows carry the DOCUMENT's firm/case/document ids and run provenance — never model-chosen values", async () => {
    const r = await processDocumentExtraction("doc-1", { provider: provider([GOOD_JSON]), exemplarGuidance: [] });
    expect(r.status).toBe("COMPLETE");
    expect(db.encounters).toHaveLength(1);
    const row = db.encounters[0];
    expect(row.firmId).toBe("firm-1");
    expect(row.caseId).toBe("case-1");
    expect(row.sourceDocumentId).toBe("doc-1");
    // A fresh draft that survives the audit is labelled as such; either way it
    // is machine output, and the audit outcome is recorded on the row.
    expect(["AI_DRAFT", "AI_AUDIT_PASSED"]).toContain(row.status);
    expect(row.auditResult).toBeTruthy();
    expect(row.auditedAt).toBeTruthy();
    expect(row.sourceFingerprint).toBe(fingerprint(TEXT));
    expect(row.promptVersion).toBeTruthy();
    expect(row.schemaVersion).toBeTruthy();
  });
});

describe("review lineage across regeneration", () => {
  const humanRow = (over: Record<string, unknown> = {}) => ({
    id: "enc-human",
    status: "VERIFIED",
    encounterDate: new Date("2025-03-14T00:00:00Z"),
    provider: "Dana Rivers, MD",
    page: null,
    sourceFingerprint: fingerprint(TEXT),
    ...over,
  });

  it("a VERIFIED row over unchanged source is preserved and gets NO duplicate AI candidate", async () => {
    db.encounters.push(humanRow());
    const r = await processDocumentExtraction("doc-1", { provider: provider([GOOD_JSON]), exemplarGuidance: [] });
    expect(r.status).toBe("COMPLETE");
    const human = db.encounters.find((e) => e.id === "enc-human")!;
    expect(human.status).toBe("VERIFIED"); // untouched
    expect(db.encounters.filter((e) => ["AI_DRAFT", "AI_AUDIT_PASSED"].includes(e.status as string))).toHaveLength(0); // covered by human work
  });

  it("changed source marks reviewed content STALE and generates a fresh candidate for comparison", async () => {
    db.encounters.push(humanRow({ sourceFingerprint: "different-bytes" }));
    await processDocumentExtraction("doc-1", { provider: provider([GOOD_JSON]), exemplarGuidance: [] });
    const human = db.encounters.find((e) => e.id === "enc-human")!;
    expect(human.status).toBe("STALE"); // verification never carries to changed content
    expect(String(human.staleReason)).toMatch(/re-review required/);
    expect(db.encounters.filter((e) => ["AI_DRAFT", "AI_AUDIT_PASSED"].includes(e.status as string))).toHaveLength(1); // comparison candidate
  });

  it("prior AI drafts are SUPERSEDED, not silently deleted", async () => {
    db.encounters.push(humanRow({ id: "enc-old-draft", status: "AI_DRAFT", provider: "Someone Else, DO", sourceFingerprint: "old" }));
    await processDocumentExtraction("doc-1", { provider: provider([GOOD_JSON]), exemplarGuidance: [] });
    const old = db.encounters.find((e) => e.id === "enc-old-draft")!;
    expect(old.status).toBe("SUPERSEDED");
    expect(db.encounters.filter((e) => ["AI_DRAFT", "AI_AUDIT_PASSED"].includes(e.status as string))).toHaveLength(1);
  });

  it("HUMAN_EDITED rows are preserved exactly like verified ones", async () => {
    db.encounters.push(humanRow({ status: "HUMAN_EDITED" }));
    await processDocumentExtraction("doc-1", { provider: provider([GOOD_JSON]), exemplarGuidance: [] });
    expect(db.encounters.find((e) => e.id === "enc-human")!.status).toBe("HUMAN_EDITED");
    expect(db.encounters.filter((e) => ["AI_DRAFT", "AI_AUDIT_PASSED"].includes(e.status as string))).toHaveLength(0);
  });
});

describe("any-size processing: fault containment", () => {
  // A two-chunk document: the first section is good clinical text, the second
  // contains a marker the fake provider treats as a poison pill.
  const GOOD = [
    "Orthopedic Associates Progress Note. Date of Service: 03/14/2025.",
    "Provider: Dana Rivers, MD.",
    "Assessment: Lumbar radiculopathy.",
    "Plan: Continue physical therapy twice weekly.",
    ...Array.from({ length: 100 }, (_, i) => `Progress line ${i} of the same encounter with additional detail.`),
  ].join("\n");
  const BAD = ["POISON-SECTION", ...Array.from({ length: 100 }, (_, i) => `Later section line ${i} of the record.`)].join("\n");
  const BIG_TEXT = `${GOOD}\n${BAD}`;

  const contentAware = (onPoison: () => never): (LlmProvider & { calls: number }) => {
    const p = {
      name: "fake",
      calls: 0,
      async complete({ messages }: { messages: { content: string }[] }) {
        p.calls++;
        const user = messages[messages.length - 1]?.content ?? "";
        if (user.includes("POISON-SECTION")) onPoison();
        return GOOD_JSON;
      },
    };
    return p as LlmProvider & { calls: number };
  };

  beforeEach(() => {
    process.env.RECORD_CRITIC = "off";
    db.doc = doc({ extractedText: BIG_TEXT });
  });
  afterEach(() => {
    delete process.env.RECORD_CRITIC;
  });

  it("one failing section is disclosed and contained — the rest of the document survives", async () => {
    const p = contentAware(() => { throw new Error("kaput"); });
    const r = await processDocumentExtraction("doc-1", { provider: p, exemplarGuidance: [] });
    expect(r.status).toBe("COMPLETE");
    expect(r.accepted).toBeGreaterThan(0); // the good section extracted
    const run = db.runs.at(-1)!;
    expect(JSON.stringify(run.warnings)).toMatch(/could not be processed/);
    // Incomplete content can never present as a complete draft.
    expect(run.auditResult).toBe("EXTRACTION_INCOMPLETE");
    for (const e of db.encounters) expect(e.status).toBe("AI_DRAFT");
  });

  it("every section failing fails the document — a total loss is not a partial result", async () => {
    const p: LlmProvider = { name: "fake", complete: async () => { throw new Error("kaput"); } };
    const r = await processDocumentExtraction("doc-1", { provider: p, exemplarGuidance: [] });
    expect(r.status).toBe("EXTRACTION_FAILED");
    expect(r.error).toMatch(/No section of this document could be processed/);
    expect(db.encounters).toHaveLength(0);
  });

  it("transient provider errors retry with backoff and recover", async () => {
    let failures = 0;
    const p: LlmProvider & { calls: number } = {
      name: "fake",
      calls: 0,
      async complete() {
        p.calls++;
        if (failures < 3) { failures++; throw new Error("overloaded_error 529"); }
        return GOOD_JSON;
      },
    } as never;
    db.doc = doc(); // single-chunk doc keeps the retry path deterministic
    const r = await processDocumentExtraction("doc-1", { provider: p, exemplarGuidance: [] });
    expect(r.status).toBe("COMPLETE");
    expect(db.runs.at(-1)!.error ?? null).toBeNull();
    expect(JSON.stringify(db.runs.at(-1)!.warnings ?? [])).not.toMatch(/could not be processed/);
  }, 30_000);
});
