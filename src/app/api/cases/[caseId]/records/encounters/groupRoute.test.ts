// One canonical note, one decision — enforced by the SERVER.
//
// Behavioural, not source-string: each test drives the real route handler
// against a fake database and asserts what changed. The properties that matter
// are the ones a browser must not be trusted with — which rows a decision
// covers, that every row was displayed as it stands now, and that a refusal
// changes nothing at all.
//
// Synthetic data only.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encounterContentHash } from "@/lib/records/verifiedContent";

const db = vi.hoisted(() => {
  const state = {
    rows: [] as Record<string, unknown>[],
    documents: [] as Record<string, unknown>[],
    findings: [] as Record<string, unknown>[],
    audits: [] as Record<string, unknown>[],
    /** Simulate a concurrent writer: CAS matches nothing for this row. */
    raceOn: null as string | null,
    txAborted: false,
  };
  const matchRow = (r: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    if (where.id && typeof where.id === "object" && "in" in (where.id as object)) {
      if (!((where.id as { in: string[] }).in ?? []).includes(r.id as string)) return false;
    } else if (where.id && r.id !== where.id) return false;
    if (where.caseId && r.caseId !== where.caseId) return false;
    if (where.firmId && r.firmId !== where.firmId) return false;
    if (where.updatedAt && (r.updatedAt as Date)?.getTime?.() !== (where.updatedAt as Date)?.getTime?.()) return false;
    if (where.status && typeof where.status === "object" && "in" in (where.status as object)) {
      if (!((where.status as { in: string[] }).in ?? []).includes(r.status as string)) return false;
    }
    if (where.supersededById === null && r.supersededById != null) return false;
    return true;
  };
  const encounter = {
    findMany: async ({ where }: { where: Record<string, unknown> }) => state.rows.filter((r) => matchRow(r, where)),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (state.raceOn && where.id === state.raceOn) return { count: 0 };
      const hit = state.rows.filter((r) => matchRow(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
  };
  const prisma = {
    extractedEncounter: encounter,
    document: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.documents.find((d) => d.id === where.id && d.caseId === where.caseId && d.firmId === where.firmId) ?? null,
    },
    recordFinding: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const ids = (where.encounterId as { in?: string[] })?.in ?? [];
        return state.findings.filter((f) => ids.includes(f.encounterId as string) && f.blocking === true);
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const ids = (where.encounterId as { in?: string[] })?.in ?? [];
        const scopes = (where.scope as { in?: string[] })?.in ?? [];
        const hit = state.findings.filter((f) => ids.includes(f.encounterId as string) && scopes.includes((f.scope as string) ?? "ENTRY"));
        for (const f of hit) Object.assign(f, data);
        return { count: hit.length };
      },
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { state.audits.push(data); return data; } },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const before = JSON.parse(JSON.stringify(state.rows, (k, v) => (v instanceof Date ? v.toISOString() : v)));
      const auditsBefore = state.audits.length;
      try {
        return await work(prisma);
      } catch (e) {
        // Roll the fake back, as a real transaction would.
        state.txAborted = true;
        state.rows = before.map((r: Record<string, unknown>) => ({ ...r, updatedAt: new Date(r.updatedAt as string) }));
        state.audits.length = auditsBefore;
        throw e;
      }
    },
  };
  return { state, prisma };
});

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));
vi.mock("@/lib/tenant", () => ({
  // handleError narrows on this class, so the error path needs it defined.
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
  refreshCaseRecordsWithRecovery: vi.fn(async () => ({ published: true, coalesced: false, attempts: 1, history: [], status: "ok" })),
}));
vi.mock("@/lib/engine/generate", () => ({ generatePlan: vi.fn(async () => ({})) }));

import { POST } from "./group/route";

const params = { params: Promise.resolve({ caseId: "case-1" }) };
const req = (body: unknown) => new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const makeRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  caseId: "case-1",
  firmId: "firm-1",
  sourceDocumentId: "doc-1",
  status: "AI_AUDIT_PASSED",
  supersededById: null,
  dateStatus: "DOCUMENTED",
  encounterDate: new Date("2025-03-14T00:00:00Z"),
  provider: "A. Rivera, MD",
  facility: null,
  encounterType: "Clinic visit",
  factualSummary: `Clinic visit ${id}.`,
  synthesis: null,
  claims: [{ field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: 1 }],
  verifiedContentHash: null,
  updatedAt: new Date("2026-08-01T00:00:00Z"),
  ...over,
});

const hashOf = (id: string) => encounterContentHash(db.state.rows.find((r) => r.id === id) as never);
const withHashes = (...ids: string[]) => ids.map((id) => ({ id, expectedContentHash: hashOf(id) }));
/** The note identifier as the records builder wrote it: document + its rows. */
const noteId = (documentId: string, ...rowIds: string[]) => `${documentId}:${[...rowIds].sort().join(",")}`;

beforeEach(() => {
  db.state.rows = [makeRow("a"), makeRow("b"), makeRow("c"), makeRow("outsider", { sourceDocumentId: "doc-2" })];
  db.state.documents = [
    { id: "doc-1", caseId: "case-1", firmId: "firm-1", segments: [{ rowIds: ["a", "b"] }, { rowIds: ["c"] }] },
    { id: "doc-2", caseId: "case-1", firmId: "firm-1", segments: [{ rowIds: ["outsider"] }] },
  ];
  db.state.findings = [];
  db.state.audits = [];
  db.state.raceOn = null;
  db.state.txAborted = false;
});

describe("one note, one decision", () => {
  it("verifies every row of the canonical note in one call", async () => {
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b") }), params);
    expect(res.status).toBe(200);
    expect(db.state.rows.filter((r) => r.status === "VERIFIED").map((r) => r.id)).toEqual(["a", "b"]);
    // Each row's hash is computed from its OWN content.
    expect(db.state.rows[0].verifiedContentHash).not.toBe(db.state.rows[1].verifiedContentHash);
  });

  it("commits the audit event with the row changes", async () => {
    await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b") }), params);
    expect(db.state.audits).toHaveLength(1);
    expect(db.state.audits[0].action).toBe("records.encounter_group_verify");
  });

  it("refuses a decision that covers only half the note", async () => {
    // The server derives {a,b} from the note id and refuses, because "b" was
    // never displayed. It does not quietly review half a record.
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a") }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).problems.some((p: { reason: string }) => /did not display/.test(p.reason))).toBe(true);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });
});

describe("membership comes from the note identifier, not from the request", () => {
  it("requires a canonical note id", async () => {
    const res = await POST(req({ action: "verify", rows: withHashes("a", "b") }), params);
    expect(res.status).toBe(422);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });

  it("rejects an identifier that is not a canonical note", async () => {
    const res = await POST(req({ action: "verify", canonicalNoteId: "not-a-note", rows: withHashes("a", "b") }), params);
    expect(res.status).toBe(422);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });

  it("refuses a note identifier naming another case's document", async () => {
    db.state.documents.push({ id: "doc-other", caseId: "case-2", firmId: "firm-1", segments: [{ rowIds: ["a"] }] });
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-other", "a"), rows: withHashes("a") }), params);
    expect(res.status).toBe(409);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });

  it("refuses an unrelated row smuggled into the note", async () => {
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "a", "b"), rows: [...withHashes("a", "b"), ...withHashes("c")] }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).problems[0].reason).toMatch(/not a member of this note/);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });

  it("refuses the same row named twice", async () => {
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "c"), rows: [...withHashes("c"), ...withHashes("c")] }), params);
    expect(res.status).toBe(409);
    expect(db.state.rows.find((r) => r.id === "c")!.status).toBe("AI_AUDIT_PASSED");
  });

  it("reviews an orphan row no segment claims — as a note of ONE", async () => {
    db.state.rows.push(makeRow("orphan"));
    db.state.documents[0].segments = [{ rowIds: ["a", "b"] }, { rowIds: ["c"] }];
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "orphan"), rows: withHashes("orphan") }), params);
    expect(res.status).toBe(200);
    expect(db.state.rows.find((r) => r.id === "orphan")!.status).toBe("VERIFIED");
  });

  it("never lets an orphan fallback carry a second row along with it", async () => {
    // The hole the old anchor logic left: a row belonging to no segment made
    // the server keep whatever list the client sent.
    db.state.rows.push(makeRow("orphan-1"), makeRow("orphan-2"));
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "orphan-1", "orphan-2"), rows: withHashes("orphan-1", "orphan-2") }), params);
    expect(res.status).toBe(409);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });
});

describe("what the server refuses", () => {
  it("rejects a request with no content hash at all", async () => {
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "a", "b"), rows: [{ id: "a" }, { id: "b" }] }), params);
    // 422 is this codebase's validation status; what matters is that the
    // request never reaches a write.
    expect(res.status).toBe(422);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });

  it("changes zero rows when one hash is stale", async () => {
    const rows = withHashes("a", "b");
    rows[1].expectedContentHash = "0".repeat(64);
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "a", "b"), rows }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).applied).toBe(0);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });

  it("cannot reach another case's rows", async () => {
    db.state.rows.push(makeRow("other-case", { caseId: "case-2" }));
    db.state.documents[0].segments = [{ rowIds: ["a", "b"] }, { rowIds: ["c"] }, { rowIds: ["other-case"] }];
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "other-case"), rows: [{ id: "other-case", expectedContentHash: "0".repeat(64) }] }), params);
    expect(res.status).toBe(409);
    expect(db.state.rows.find((r) => r.id === "other-case")!.status).toBe("AI_AUDIT_PASSED");
  });

  it("cannot reach another firm's rows", async () => {
    db.state.rows.push(makeRow("other-firm", { firmId: "firm-2" }));
    db.state.documents[0].segments = [{ rowIds: ["a", "b"] }, { rowIds: ["c"] }, { rowIds: ["other-firm"] }];
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "other-firm"), rows: [{ id: "other-firm", expectedContentHash: "0".repeat(64) }] }), params);
    expect(res.status).toBe(409);
    expect(db.state.rows.find((r) => r.id === "other-firm")!.status).toBe("AI_AUDIT_PASSED");
  });

  it("rolls the WHOLE note back when one row changes mid-write", async () => {
    db.state.raceOn = "b";
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b") }), params);
    expect(res.status).toBe(409);
    expect(db.state.txAborted).toBe(true);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
    expect(db.state.audits).toHaveLength(0); // no audit for a decision that did not happen
  });

  it("will not attest a note carrying an unresolved blocking finding", async () => {
    db.state.findings = [{ encounterId: "b", scope: "ENTRY", blocking: true, status: "OPEN", type: "CONTRADICTED_DATE" }];
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b") }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).problems[0].reason).toMatch(/unresolved finding/);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });

  it("still allows REJECT over a blocking finding — that is how it is disposed of", async () => {
    db.state.findings = [{ encounterId: "b", scope: "ENTRY", blocking: true, status: "OPEN", type: "CONTRADICTED_DATE" }];
    const res = await POST(req({ action: "reject", note: "not this patient", canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b") }), params);
    expect(res.status).toBe(200);
    expect(db.state.rows.filter((r) => r.status === "SUPERSEDED")).toHaveLength(2);
  });
});

describe("the server checks the row's own state, not the button's", () => {
  it("refuses to attest a row whose audit ended in source conflict", async () => {
    db.state.rows.find((r) => r.id === "b")!.auditResult = "SOURCE_CONFLICT";
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b") }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).problems[0].reason).toMatch(/source conflict/);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });

  it("refuses to attest a row whose audit failed outright", async () => {
    db.state.rows.find((r) => r.id === "a")!.auditResult = "FAILED";
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b") }), params);
    expect(res.status).toBe(409);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });

  it("refuses to attest over an unresolved extraction disagreement", async () => {
    db.state.rows.find((r) => r.id === "b")!.unresolvedDisputes = 2;
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b") }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).problems[0].reason).toMatch(/disagreement/);
  });

  it("refuses to attest over a field the source contradicts", async () => {
    db.state.rows.find((r) => r.id === "a")!.contradictedFields = ["date"];
    const res = await POST(req({ action: "verify", canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b") }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).problems[0].reason).toMatch(/contradicts date/);
  });

  it("still allows REJECT over any of those states", async () => {
    db.state.rows.find((r) => r.id === "a")!.auditResult = "FAILED";
    db.state.rows.find((r) => r.id === "b")!.unresolvedDisputes = 3;
    const res = await POST(req({ action: "reject", canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b") }), params);
    expect(res.status).toBe(200);
    expect(db.state.rows.filter((r) => r.status === "SUPERSEDED")).toHaveLength(2);
  });
});

describe("what a rejection resolves, and what it does not", () => {
  it("resolves the findings about the rejected entries", async () => {
    db.state.findings = [{ encounterId: "a", scope: "ENTRY", blocking: true, status: "OPEN", type: "CONTRADICTED_DATE" }];
    await POST(req({ action: "reject", canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b") }), params);
    expect(db.state.findings[0].status).toBe("RESOLVED");
  });

  it("leaves a document- or case-level completeness problem exactly where it was", async () => {
    // Deleting a row near a blocker does not answer the blocker.
    db.state.findings = [
      { encounterId: "a", scope: "DOCUMENT", blocking: true, status: "OPEN", type: "MISSING_ENCOUNTER" },
      { encounterId: null, scope: "CASE", blocking: true, status: "OPEN", type: "DOCUMENTS_STILL_PROCESSING" },
    ];
    await POST(req({ action: "reject", canonicalNoteId: noteId("doc-1", "a", "b"), rows: withHashes("a", "b") }), params);
    expect(db.state.findings.map((f) => f.status)).toEqual(["OPEN", "OPEN"]);
  });
});
