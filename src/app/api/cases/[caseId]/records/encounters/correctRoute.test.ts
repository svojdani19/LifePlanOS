// A structural correction describes the whole note, so it lands on all of it
// or none of it.
//
// The browser used to loop a PATCH per fragment, discard every response, and
// fire a case rebuild per row. A three-fragment note could end up corrected
// twice, report success, and rebuild the case three times over a state that
// disagreed with itself.
//
// Synthetic data only.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encounterContentHash } from "@/lib/records/verifiedContent";

const db = vi.hoisted(() => {
  const state = {
    rows: [] as Record<string, unknown>[],
    documents: [] as Record<string, unknown>[],
    audits: [] as Record<string, unknown>[],
    rebuilds: 0,
    raceOn: null as string | null,
    txAborted: false,
  };
  const matchRow = (r: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    if (where.id && typeof where.id === "object" && "in" in (where.id as object)) {
      if (!((where.id as { in: string[] }).in ?? []).includes(r.id as string)) return false;
    } else if (where.id && r.id !== where.id) return false;
    if (where.caseId && r.caseId !== where.caseId) return false;
    if (where.firmId && r.firmId !== where.firmId) return false;
    if (where.sourceDocumentId && r.sourceDocumentId !== where.sourceDocumentId) return false;
    if (where.updatedAt && (r.updatedAt as Date)?.getTime?.() !== (where.updatedAt as Date)?.getTime?.()) return false;
    if (where.status && typeof where.status === "object" && "in" in (where.status as object)) {
      if (!((where.status as { in: string[] }).in ?? []).includes(r.status as string)) return false;
    }
    if (where.supersededById === null && r.supersededById != null) return false;
    return true;
  };
  const prisma = {
    extractedEncounter: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => state.rows.filter((r) => matchRow(r, where)),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (state.raceOn && where.id === state.raceOn) return { count: 0 };
        const hit = state.rows.filter((r) => matchRow(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    },
    document: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.documents.find((d) => d.id === where.id && d.caseId === where.caseId && d.firmId === where.firmId) ?? null,
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { state.audits.push(data); return data; } },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const before = JSON.parse(JSON.stringify(state.rows, (k, v) => (v instanceof Date ? v.toISOString() : v)));
      const auditsBefore = state.audits.length;
      try {
        return await work(prisma);
      } catch (e) {
        state.txAborted = true;
        state.rows = before.map((r: Record<string, unknown>) => ({
          ...r,
          updatedAt: new Date(r.updatedAt as string),
          encounterDate: r.encounterDate ? new Date(r.encounterDate as string) : null,
        }));
        state.audits.length = auditsBefore;
        throw e;
      }
    },
  };
  return { state, prisma };
});

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));
vi.mock("@/lib/tenant", () => ({
  TenantError: class TenantError extends Error {
    status = 403;
  },
  requireApiContext: vi.fn(async () => ({ user: { id: "reviewer-1" }, firm: { id: "firm-1" } })),
  requireCanonicalPermission: vi.fn(),
  requireCase: vi.fn(async () => ({ id: "case-1" })),
  audit: vi.fn(async () => {}),
}));
vi.mock("@/lib/records/buildRecords", () => ({
  makeRecordStore: (x: unknown) => x,
  refreshCaseRecordsWithRecovery: vi.fn(async () => {
    db.state.rebuilds++;
    return { published: true, coalesced: false, attempts: 1, history: [], status: "ok" };
  }),
}));
vi.mock("@/lib/engine/generate", () => ({ generatePlan: vi.fn(async () => ({})) }));

import { POST } from "./group/correct/route";

const params = { params: Promise.resolve({ caseId: "case-1" }) };
const req = (body: unknown) => new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const makeRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  caseId: "case-1",
  firmId: "firm-1",
  sourceDocumentId: "doc-1",
  status: "AI_DRAFT",
  supersededById: null,
  dateStatus: "UNKNOWN",
  encounterDate: null,
  provider: "A. Rivera, MD",
  facility: null,
  encounterType: "Clinic visit",
  factualSummary: `Clinic visit ${id}.`,
  synthesis: null,
  claims: [{ field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: 1 }],
  analysisClass: null,
  substanceClass: "CLINICAL",
  editedFields: [],
  verifiedContentHash: null,
  updatedAt: new Date("2026-08-01T00:00:00Z"),
  ...over,
});

const hashOf = (id: string) => encounterContentHash(db.state.rows.find((r) => r.id === id) as never);
const withHashes = (...ids: string[]) => ids.map((id) => ({ id, expectedContentHash: hashOf(id) }));
const noteId = (documentId: string, ...rowIds: string[]) => `${documentId}:${[...rowIds].sort().join(",")}`;

beforeEach(() => {
  db.state.rows = [makeRow("a"), makeRow("b"), makeRow("c")];
  db.state.documents = [{ id: "doc-1", caseId: "case-1", firmId: "firm-1", segments: [{ rowIds: ["a", "b"] }, { rowIds: ["c"] }] }];
  db.state.audits = [];
  db.state.rebuilds = 0;
  db.state.raceOn = null;
  db.state.txAborted = false;
});

describe("a note-wide correction reaches every fragment", () => {
  it("dates every fragment of the note in one call", async () => {
    const res = await POST(req({ canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b"), encounterDate: "2025-03-14" }), params);
    expect(res.status).toBe(200);
    const dated = db.state.rows.filter((r) => r.dateStatus === "DOCUMENTED");
    expect(dated.map((r) => r.id)).toEqual(["a", "b"]);
    // The fragment in a different note is untouched.
    expect(db.state.rows.find((r) => r.id === "c")!.dateStatus).toBe("UNKNOWN");
  });

  it("reclassifies every fragment and re-derives each one's substance", async () => {
    const res = await POST(req({ canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b"), analysisClass: "FINANCIAL" }), params);
    expect(res.status).toBe(200);
    for (const id of ["a", "b"]) {
      const row = db.state.rows.find((r) => r.id === id)!;
      expect(row.analysisClass).toBe("FINANCIAL");
      expect(row.classificationMethod).toBe("REVIEWER_ASSIGNED");
      expect(row.substanceReason).toMatch(/Reclassified by reviewer/);
    }
  });

  it("writes ONE audit event for the whole note, and one rebuild", async () => {
    await POST(req({ canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b"), encounterDate: "2025-03-14" }), params);
    expect(db.state.audits).toHaveLength(1);
    expect(db.state.audits[0].action).toBe("records.note_correct");
    expect((db.state.audits[0].meta as { rows: string[] }).rows.sort()).toEqual(["a", "b"]);
    // One rebuild for the note, not one per fragment.
    await new Promise((r) => setTimeout(r, 0));
    expect(db.state.rebuilds).toBe(1);
  });

  it("marks every corrected fragment as human-edited", async () => {
    await POST(req({ canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b"), substanceClass: "ADMINISTRATIVE" }), params);
    expect(db.state.rows.filter((r) => r.status === "HUMAN_EDITED").map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("all of it or none of it", () => {
  it("changes nothing when one fragment's content moved since it was displayed", async () => {
    const rows = withHashes("a", "b");
    rows[1].expectedContentHash = "0".repeat(64);
    const res = await POST(req({ canonicalNoteId: noteId("doc-1", "a", "b"), rows, encounterDate: "2025-03-14" }), params);
    expect(res.status).toBe(409);
    expect(db.state.rows.every((r) => r.dateStatus === "UNKNOWN")).toBe(true);
    expect(db.state.audits).toHaveLength(0);
  });

  it("rolls the whole note back when one fragment changes mid-write", async () => {
    db.state.raceOn = "b";
    const res = await POST(req({ canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b"), encounterDate: "2025-03-14" }), params);
    expect(res.status).toBe(409);
    expect(db.state.txAborted).toBe(true);
    expect(db.state.rows.every((r) => r.dateStatus === "UNKNOWN")).toBe(true);
    expect(db.state.audits).toHaveLength(0);
  });

  it("refuses a partial submission of the note", async () => {
    const res = await POST(req({ canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a"), encounterDate: "2025-03-14" }), params);
    expect(res.status).toBe(409);
    expect(db.state.rows.every((r) => r.dateStatus === "UNKNOWN")).toBe(true);
  });

  it("refuses a row smuggled in from another note", async () => {
    const res = await POST(req({ canonicalNoteId: noteId("doc-1", "a", "b"), rows: [...withHashes("a", "b"), ...withHashes("c")], encounterDate: "2025-03-14" }), params);
    expect(res.status).toBe(409);
    expect(db.state.rows.every((r) => r.dateStatus === "UNKNOWN")).toBe(true);
  });

  it("cannot reach another firm's rows", async () => {
    db.state.rows = [makeRow("x", { firmId: "firm-2" })];
    db.state.documents[0].segments = [{ rowIds: ["x"] }];
    const res = await POST(req({ canonicalNoteId: noteId("doc-1", "x"), rows: [{ id: "x", expectedContentHash: "0".repeat(64) }], encounterDate: "2025-03-14" }), params);
    expect(res.status).toBe(409);
    expect(db.state.rows[0].dateStatus).toBe("UNKNOWN");
  });
});

describe("what belongs on the note and what does not", () => {
  it("refuses a request that carries no note-wide field", async () => {
    // A factual summary is about ONE fragment's exact content and stays on the
    // per-row endpoint, beside the excerpt that supports it.
    const res = await POST(req({ canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b"), factualSummary: "rewritten" }), params);
    expect(res.status).toBe(422);
    expect(db.state.audits).toHaveLength(0);
  });

  it("refuses to revoke a verification without a documented reason", async () => {
    db.state.rows = [makeRow("a", { status: "VERIFIED" }), makeRow("b")];
    const res = await POST(req({ canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b"), encounterDate: "2025-03-14" }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).problems[0].reason).toMatch(/documented reason/);
    expect(db.state.rows[0].status).toBe("VERIFIED");
  });

  it("revokes the verification and clears its hash when a reason is given", async () => {
    db.state.rows = [makeRow("a", { status: "VERIFIED", verifiedContentHash: "x".repeat(64) }), makeRow("b")];
    const res = await POST(
      req({ canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b"), encounterDate: "2025-03-14", reviewNote: "date was read off the wrong header" }),
      params,
    );
    expect(res.status).toBe(200);
    expect(db.state.rows[0].status).toBe("HUMAN_EDITED");
    expect(db.state.rows[0].verifiedContentHash).toBeNull();
    expect((db.state.audits[0].meta as { revokedVerification: boolean }).revokedVerification).toBe(true);
  });
});
