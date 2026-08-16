// Answering a finding is a professional act, and the SERVER decides whether
// the answer is admissible: the right firm, the right case, a legal
// transition, the content the reviewer actually saw, and — for a blocker — a
// reason someone will stand behind.
//
// Synthetic data only.
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => {
  const state = {
    findings: [] as Record<string, unknown>[],
    audits: [] as Record<string, unknown>[],
    /** Simulate a second reviewer: CAS matches nothing. */
    raceOn: null as string | null,
  };
  const matches = (r: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    for (const key of ["id", "caseId", "firmId", "status"]) {
      if (where[key] !== undefined && r[key] !== where[key]) return false;
    }
    return true;
  };
  const prisma = {
    recordFinding: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => state.findings.find((f) => matches(f, where)) ?? null,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (state.raceOn && where.id === state.raceOn) return { count: 0 };
        const hit = state.findings.filter((f) => matches(f, where));
        for (const f of hit) Object.assign(f, data);
        return { count: hit.length };
      },
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { state.audits.push(data); return data; } },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
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

import { POST } from "./route";

const params = { params: Promise.resolve({ caseId: "case-1" }) };
const req = (body: unknown) => new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const makeFinding = (over: Record<string, unknown> = {}) => ({
  id: "find-1",
  caseId: "case-1",
  firmId: "firm-1",
  scope: "DOCUMENT",
  type: "MISSING_ENCOUNTER",
  blocking: true,
  status: "OPEN",
  fingerprint: "fp-1",
  sourceFingerprint: "sha-1",
  sourceDocumentId: "doc-1",
  canonicalNoteId: null,
  encounterId: null,
  pageStart: null,
  pageEnd: null,
  dispositionReason: null,
  reviewedById: null,
  reviewedAt: null,
  dispositionSourceFingerprint: null,
  dispositionHistory: null,
  ...over,
});

const body = (over: Record<string, unknown> = {}) => ({
  findingId: "find-1",
  action: "resolve",
  expectedFingerprint: "fp-1",
  expectedSourceFingerprint: "sha-1",
  reason: "the missing note was located and extracted",
  ...over,
});

beforeEach(() => {
  db.state.findings = [makeFinding()];
  db.state.audits = [];
  db.state.raceOn = null;
});

describe("a reviewer can answer a finding", () => {
  it("records a resolution with the reviewer, the reason, and the source it was given over", async () => {
    const res = await POST(req(body()), params);
    expect(res.status).toBe(200);
    const f = db.state.findings[0];
    expect(f.status).toBe("RESOLVED");
    expect(f.reviewedById).toBe("reviewer-1");
    expect(f.dispositionReason).toMatch(/located and extracted/);
    // Binds the decision to the content it covers, so a later source change
    // reopens it instead of carrying it forward.
    expect(f.dispositionSourceFingerprint).toBe("sha-1");
  });

  it("commits an audit event carrying the prior and new status", async () => {
    await POST(req(body()), params);
    expect(db.state.audits).toHaveLength(1);
    const meta = db.state.audits[0].meta as Record<string, unknown>;
    expect(db.state.audits[0].action).toBe("records.finding_resolve");
    expect(meta.priorStatus).toBe("OPEN");
    expect(meta.newStatus).toBe("RESOLVED");
    expect(meta.fingerprint).toBe("fp-1");
  });

  it("keeps a prior disposition as history rather than overwriting it", async () => {
    db.state.findings = [makeFinding({ status: "DISMISSED", dispositionReason: "looked fine", reviewedById: "reviewer-0", dispositionSourceFingerprint: "sha-1" })];
    await POST(req(body({ action: "confirm", reason: undefined })), params);
    const history = db.state.findings[0].dispositionHistory as { status: string; byId: string }[];
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("DISMISSED");
    expect(history[0].byId).toBe("reviewer-0");
  });

  it("confirms a finding without demanding a reason — the blocker stays up", async () => {
    const res = await POST(req(body({ action: "confirm", reason: undefined })), params);
    expect(res.status).toBe(200);
    expect(db.state.findings[0].status).toBe("CONFIRMED");
  });
});

describe("what the server refuses", () => {
  it("refuses to close a blocking finding with no reason", async () => {
    const res = await POST(req(body({ reason: "   " })), params);
    expect(res.status).toBe(422);
    expect(db.state.findings[0].status).toBe("OPEN");
    expect(db.state.audits).toHaveLength(0);
  });

  it("refuses when the finding changed since it was displayed", async () => {
    const res = await POST(req(body({ expectedFingerprint: "fp-STALE" })), params);
    expect(res.status).toBe(409);
    expect(db.state.findings[0].status).toBe("OPEN");
  });

  it("refuses when the source content changed since it was displayed", async () => {
    const res = await POST(req(body({ expectedSourceFingerprint: "sha-OLD" })), params);
    expect(res.status).toBe(409);
    expect(db.state.findings[0].status).toBe("OPEN");
  });

  it("refuses an illegal transition", async () => {
    db.state.findings = [makeFinding({ status: "RESOLVED" })];
    const res = await POST(req(body({ action: "dismiss" })), params);
    expect(res.status).toBe(409);
    expect(db.state.findings[0].status).toBe("RESOLVED");
  });

  it("cannot reach another firm's finding", async () => {
    db.state.findings = [makeFinding({ firmId: "firm-2" })];
    const res = await POST(req(body()), params);
    expect(res.status).toBe(404);
    expect(db.state.findings[0].status).toBe("OPEN");
  });

  it("cannot reach another case's finding", async () => {
    db.state.findings = [makeFinding({ caseId: "case-2" })];
    const res = await POST(req(body()), params);
    expect(res.status).toBe(404);
    expect(db.state.findings[0].status).toBe("OPEN");
  });

  it("changes nothing when another reviewer answered it first", async () => {
    db.state.raceOn = "find-1";
    const res = await POST(req(body()), params);
    expect(res.status).toBe(409);
    expect(db.state.findings[0].status).toBe("OPEN");
    expect(db.state.audits).toHaveLength(0); // no audit for a decision that did not happen
  });
});
