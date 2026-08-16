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
    document: { findFirst: async ({ where }: { where: Record<string, unknown> }) => state.documents.find((d) => d.id === where.id) ?? null },
    recordFinding: { findMany: async ({ where }: { where: Record<string, unknown> }) => {
      const ids = (where.encounterId as { in?: string[] })?.in ?? [];
      return state.findings.filter((f) => ids.includes(f.encounterId as string) && f.blocking === true);
    } },
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
    const res = await POST(req({ action: "verify", rows: withHashes("a", "b") }), params);
    expect(res.status).toBe(200);
    expect(db.state.rows.filter((r) => r.status === "VERIFIED").map((r) => r.id)).toEqual(["a", "b"]);
    // Each row's hash is computed from its OWN content.
    expect(db.state.rows[0].verifiedContentHash).not.toBe(db.state.rows[1].verifiedContentHash);
  });

  it("commits the audit event with the row changes", async () => {
    await POST(req({ action: "verify", rows: withHashes("a", "b") }), params);
    expect(db.state.audits).toHaveLength(1);
    expect(db.state.audits[0].action).toBe("records.encounter_group_verify");
  });

  it("derives the note's members server-side, covering a row the client omitted", async () => {
    // Asking about "a" alone must not silently review half a note: the server
    // derives {a,b} and refuses because "b" was never displayed.
    const res = await POST(req({ action: "verify", rows: withHashes("a") }), params);
    expect(res.status).toBe(409);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });
});

describe("what the server refuses", () => {
  it("rejects a request with no content hash at all", async () => {
    const res = await POST(req({ action: "verify", rows: [{ id: "a" }, { id: "b" }] }), params);
    // 422 is this codebase's validation status; what matters is that the
    // request never reaches a write.
    expect(res.status).toBe(422);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });

  it("changes zero rows when one hash is stale", async () => {
    const rows = withHashes("a", "b");
    rows[1].expectedContentHash = "0".repeat(64);
    const res = await POST(req({ action: "verify", rows }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).applied).toBe(0);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });

  it("refuses an unrelated row smuggled into the note", async () => {
    const res = await POST(req({ action: "verify", rows: [...withHashes("a", "b"), ...withHashes("c")] }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).problems[0].reason).toMatch(/not a member of this note/);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });

  it("cannot reach another case's rows", async () => {
    db.state.rows.push(makeRow("other-case", { caseId: "case-2" }));
    const res = await POST(req({ action: "verify", rows: [{ id: "other-case", expectedContentHash: "0".repeat(64) }] }), params);
    expect(res.status).toBe(409);
    expect(db.state.rows.find((r) => r.id === "other-case")!.status).toBe("AI_AUDIT_PASSED");
  });

  it("cannot reach another firm's rows", async () => {
    db.state.rows.push(makeRow("other-firm", { firmId: "firm-2" }));
    const res = await POST(req({ action: "verify", rows: [{ id: "other-firm", expectedContentHash: "0".repeat(64) }] }), params);
    expect(res.status).toBe(409);
    expect(db.state.rows.find((r) => r.id === "other-firm")!.status).toBe("AI_AUDIT_PASSED");
  });

  it("rolls the WHOLE note back when one row changes mid-write", async () => {
    db.state.raceOn = "b";
    const res = await POST(req({ action: "verify", rows: withHashes("a", "b") }), params);
    expect(res.status).toBe(409);
    expect(db.state.txAborted).toBe(true);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
    expect(db.state.audits).toHaveLength(0); // no audit for a decision that did not happen
  });

  it("will not attest a note carrying an unresolved blocking finding", async () => {
    db.state.findings = [{ encounterId: "b", blocking: true, status: "OPEN", type: "CONTRADICTED_DATE" }];
    const res = await POST(req({ action: "verify", rows: withHashes("a", "b") }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).problems[0].reason).toMatch(/unresolved finding/);
    expect(db.state.rows.every((r) => r.status !== "VERIFIED")).toBe(true);
  });

  it("still allows REJECT over a blocking finding — that is how it is disposed of", async () => {
    db.state.findings = [{ encounterId: "b", blocking: true, status: "OPEN", type: "CONTRADICTED_DATE" }];
    const res = await POST(req({ action: "reject", note: "not this patient", rows: withHashes("a", "b") }), params);
    expect(res.status).toBe(200);
    expect(db.state.rows.filter((r) => r.status === "SUPERSEDED")).toHaveLength(2);
  });
});
