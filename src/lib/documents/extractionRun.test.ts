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
    pages: new Map<string, Record<string, unknown>>(),
    reset() {
      state.runs.length = 0;
      state.pages.clear();
      encounters.length = 0;
      runSeq = 0;
      encSeq = 0;
    },
    prisma: {
      document: {
        findUniqueOrThrow: async () => state.doc,
        // Case-level completeness is derived from the case's documents...
        findMany: async () => [state.doc],
      },
      recordExtraction: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (data.lockKey && state.runs.some((r) => r.sourceDocumentId === data.sourceDocumentId && r.lockKey === data.lockKey)) {
            throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
          }
          const row = { id: `run-${++runSeq}`, createdAt: new Date(), ...data };
          state.runs.push(row);
          return row;
        },
        // ...and their latest runs. Newest first, matching the real query.
        findMany: async () => [...state.runs].reverse().map((r) => ({ sourceDocumentId: r.sourceDocumentId, status: r.status })),
        // The run lock and the idempotency check both read through findFirst.
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          state.runs.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = state.runs.find((r) => r.id === where.id)!;
          for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
          return row;
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const hit = state.runs.filter((r) =>
            Object.entries(where).every(([k, v]) => (v instanceof Date ? (r[k] as Date | null)?.getTime() === v.getTime() : r[k] === v)),
          );
          for (const row of hit) Object.assign(row, data);
          return { count: hit.length };
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
      // Per-page source rows written by the ledger. Persistence is an upsert
      // keyed on (document, page), so a re-run rewrites rather than duplicates.
      sourcePage: {
        findMany: async () => [...state.pages.values()],
        upsert: async ({ where, create, update }: { where: { sourceDocumentId_pageNumber: { sourceDocumentId: string; pageNumber: number } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
          const k = `${where.sourceDocumentId_pageNumber.sourceDocumentId}#${where.sourceDocumentId_pageNumber.pageNumber}`;
          const prior = state.pages.get(k);
          const row = prior ? { ...prior, ...update } : { ...create };
          state.pages.set(k, row);
          return row;
        },
      },
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
    type: "MEDICAL_RECORD",
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

describe("run lifecycle", () => {
  // A two-chunk document, so a chunk budget of 1 forces a pause.
  const TWO_CHUNK = [
    "Orthopedic Associates Progress Note. Date of Service: 03/14/2025.",
    "Provider: Dana Rivers, MD.",
    "Assessment: Lumbar radiculopathy.",
    "Plan: Continue physical therapy twice weekly.",
    ...Array.from({ length: 100 }, (_, i) => `Progress line ${i} of the same encounter with additional detail.`),
    ...Array.from({ length: 100 }, (_, i) => `Later section line ${i} of the record with additional detail.`),
  ].join("\n");

  beforeEach(() => {
    process.env.RECORD_CRITIC = "off";
  });
  afterEach(() => {
    delete process.env.RECORD_CRITIC;
    delete process.env.RECORD_CHUNK_BUDGET;
  });

  it("the run row exists as RUNNING before any model call, and is only COMPLETE once its output is persisted", async () => {
    const seen: string[] = [];
    const p: LlmProvider = {
      name: "fake",
      async complete() {
        // Observed mid-run: the run is already recorded, and recorded as live.
        seen.push(String(db.runs.at(-1)?.status));
        return GOOD_JSON;
      },
    };
    await processDocumentExtraction("doc-1", { provider: p, exemplarGuidance: [] });
    expect(seen[0]).toBe("RUNNING");
    const run = db.runs.at(-1)!;
    expect(run.status).toBe("COMPLETE");
    expect(run.lockKey).toBeNull();
    expect(run.startedAt).toBeTruthy();
    expect(run.finishedAt).toBeTruthy();
  });

  it("a second run while one is in flight is refused — duplicate drafts are how records get double-counted", async () => {
    db.runs.push({ id: "run-live", sourceDocumentId: "doc-1", caseId: "case-1", firmId: "firm-1", status: "RUNNING", lockKey: "ACTIVE", sourceFingerprint: fingerprint(TEXT), heartbeatAt: new Date(), createdAt: new Date() });
    const p = provider([GOOD_JSON]);
    const r = await processDocumentExtraction("doc-1", { provider: p, exemplarGuidance: [] });
    expect(r.status).toBe("BUSY");
    expect(p.calls).toBe(0);
    expect(db.encounters).toHaveLength(0);
  });

  it("re-running identical work reuses the prior run instead of burning tokens", async () => {
    const first = provider([GOOD_JSON]);
    const a = await processDocumentExtraction("doc-1", { provider: first, exemplarGuidance: [] });
    expect(a.status).toBe("COMPLETE");
    const second = provider([GOOD_JSON]);
    const b = await processDocumentExtraction("doc-1", { provider: second, exemplarGuidance: [] });
    expect(b).toMatchObject({ status: "COMPLETE", idempotent: true, extractionId: a.extractionId });
    expect(second.calls).toBe(0);
    expect(db.encounters).toHaveLength(1); // no second set of drafts
  });

  it("force re-runs the same work when a reviewer asks for it", async () => {
    await processDocumentExtraction("doc-1", { provider: provider([GOOD_JSON]), exemplarGuidance: [] });
    const forced = provider([GOOD_JSON]);
    const r = await processDocumentExtraction("doc-1", { provider: forced, exemplarGuidance: [], force: true });
    expect(r.idempotent).toBeUndefined();
    expect(forced.calls).toBeGreaterThan(0);
  });

  it("a run that hits its chunk budget pauses with a cursor and keeps the lock", async () => {
    db.doc = doc({ extractedText: TWO_CHUNK });
    process.env.RECORD_CHUNK_BUDGET = "1";
    const r = await processDocumentExtraction("doc-1", { provider: provider([GOOD_JSON]), exemplarGuidance: [] });
    expect(r.status).toBe("PAUSED");
    expect(r.resumeFrom).toBe(1);
    const run = db.runs.at(-1)!;
    expect(run.status).toBe("PAUSED");
    expect(run.lockKey).toBe("ACTIVE"); // still owns the document
    expect(run.resumeState).toEqual({ nextChunkIndex: 1 });
    // Incomplete work can never present as a finished draft.
    expect(run.auditResult).not.toBe("PASS");
    for (const e of db.encounters) expect(e.status).toBe("AI_DRAFT");
  });

  it("resuming finishes the document without duplicating what the first pass already wrote", async () => {
    db.doc = doc({ extractedText: TWO_CHUNK });
    process.env.RECORD_CHUNK_BUDGET = "1";
    const first = await processDocumentExtraction("doc-1", { provider: provider([GOOD_JSON]), exemplarGuidance: [] });
    expect(first.status).toBe("PAUSED");
    const afterPause = db.encounters.length;

    let r = first;
    for (let i = 0; i < 10 && r.status === "PAUSED"; i++) {
      r = await processDocumentExtraction("doc-1", { provider: provider([GOOD_JSON]), exemplarGuidance: [] });
    }
    expect(r.status).toBe("COMPLETE");
    expect(r.extractionId).toBe(first.extractionId); // one run, continued
    expect(db.runs).toHaveLength(1);
    expect(db.encounters).toHaveLength(afterPause); // the same encounter, not a copy per instalment
    expect(db.encounters.every((e) => e.status !== "SUPERSEDED")).toBe(true); // a resume never supersedes its own output
    expect(db.runs[0].chunksDone).toBe(db.runs[0].chunksTotal);
  });

  it("telemetry carries operational counters and no record content", async () => {
    await processDocumentExtraction("doc-1", { provider: provider([GOOD_JSON]), exemplarGuidance: [] });
    const t = db.runs.at(-1)!.telemetry as Record<string, unknown>;
    expect(t.chunksProcessed).toBe(1);
    expect(typeof t.elapsedMs).toBe("number");
    const serialized = JSON.stringify(t);
    expect(serialized).not.toMatch(/Dana Rivers|radiculopathy|03\/14\/2025/i);
  });
});

describe("page accounting", () => {
  const PAGINATED = [
    "Page 1 of 2",
    "Orthopedic Associates Progress Note. Date of Service: 03/14/2025.",
    "Provider: Dana Rivers, MD.",
    "Assessment: Lumbar radiculopathy.",
    "Plan: Continue physical therapy twice weekly.",
    "Page 2 of 2",
    "Continued discussion of the treatment plan and follow-up interval for this patient.",
  ].join("\n");

  it("every page of a paginated document gets a durable row, and the run counts them", async () => {
    db.doc = doc({ extractedText: PAGINATED });
    await processDocumentExtraction("doc-1", { provider: provider([GOOD_JSON]), exemplarGuidance: [] });
    const pages = [...db.pages.values()];
    expect(pages.map((p) => p.pageNumber).sort()).toEqual([1, 2]);
    for (const p of pages) {
      expect(p.firmId).toBe("firm-1"); // server-owned tenancy
      expect(p.caseId).toBe("case-1");
      expect(p.contentHash).toBeTruthy();
    }
    const run = db.runs.at(-1)!;
    expect(run.pagesTotal).toBe(2);
    expect(run.pagesReadable).toBe(2);
  });

  it("a document with no page boundaries gets no invented page rows", async () => {
    await processDocumentExtraction("doc-1", { provider: provider([GOOD_JSON]), exemplarGuidance: [] });
    expect(db.pages.size).toBe(0);
    expect(db.runs.at(-1)!.pagesTotal).toBe(0);
  });
});
