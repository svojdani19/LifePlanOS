// A physician's citation is attached only when it RESOLVES to a real article.
//
// Every citation in a plan has to be a record that exists, with text that can
// be quoted verbatim — the same standard the automated literature pass is held
// to. A pasted reference nobody can look up is refused rather than printed.
//
// Synthetic data only.
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => {
  const state = {
    items: [] as Record<string, unknown>[],
    evidence: [] as Record<string, unknown>[],
    audits: [] as Record<string, unknown>[],
  };
  const prisma = {
    futureCareItem: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.items.find((i) => i.id === where.id && i.caseId === where.caseId) ?? null,
    },
    recommendationEvidence: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `ev-${state.evidence.length + 1}`, ...data };
        state.evidence.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const hit = state.evidence.filter(
          (e) => e.id === where.id && e.caseId === where.caseId && e.firmId === where.firmId && e.addedById != null,
        );
        for (const h of hit) state.evidence.splice(state.evidence.indexOf(h), 1);
        return { count: hit.length };
      },
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { state.audits.push(data); return data; } },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
  };
  return { state, prisma };
});

const lit = vi.hoisted(() => ({ candidates: [] as Record<string, unknown>[] }));

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));
vi.mock("@/lib/literature", () => ({ findCandidates: vi.fn(async () => lit.candidates) }));
vi.mock("@/lib/tenant", () => ({
  TenantError: class TenantError extends Error {
    status = 403;
  },
  requireApiContext: vi.fn(async () => ({ user: { id: "dr-1" }, firm: { id: "firm-1" } })),
  requireCanonicalPermission: vi.fn(),
  requireCase: vi.fn(async () => ({ id: "case-1" })),
}));

import { POST, DELETE } from "./evidence/route";

const params = { params: Promise.resolve({ caseId: "case-1", itemId: "item-1" }) };
const req = (body: unknown) =>
  new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const ARTICLE = {
  source: "europepmc",
  key: "doi:10.1000/abc",
  title: "Epidural steroid injection cadence in lumbar radiculopathy",
  journal: "Spine",
  year: "2024",
  doi: "10.1000/abc",
  pmid: "12345678",
  url: "https://example.org/abc",
  abstract: "Injections were repeated up to three times per year in the reviewed cohorts.",
};

beforeEach(() => {
  db.state.items = [{ id: "item-1", caseId: "case-1", conditionId: "c-1", service: "Lumbar epidural steroid injection", supersededAt: null }];
  db.state.evidence = [];
  db.state.audits = [];
  lit.candidates = [ARTICLE];
});

describe("attaching a physician's citation", () => {
  it("resolves the article and stores it against the claim it answers", async () => {
    const res = await POST(req({ reference: "10.1000/abc", claim: "FREQUENCY" }), params);
    expect(res.status).toBe(200);
    const row = db.state.evidence[0];
    expect(row.claim).toBe("FREQUENCY");
    expect(row.citationTitle).toBe(ARTICLE.title);
    expect(row.citationDoi).toBe("10.1000/abc");
    expect(row.strength).toBe("LITERATURE");
    // The physician's id is what protects it from the next generation.
    expect(row.addedById).toBe("dr-1");
  });

  it("quotes the physician's own note when they gave one", async () => {
    const res = await POST(req({ reference: "10.1000/abc", claim: "FREQUENCY", note: "Supports three injections per year in this presentation." }), params);
    expect(res.status).toBe(200);
    expect(db.state.evidence[0].quote).toMatch(/three injections per year/);
  });

  it("records an audit event naming the claim and the article", async () => {
    await POST(req({ reference: "10.1000/abc", claim: "NECESSITY" }), params);
    expect(db.state.audits).toHaveLength(1);
    expect(db.state.audits[0].action).toBe("futurecare.evidence_added");
    expect((db.state.audits[0].meta as { doi: string }).doi).toBe("10.1000/abc");
  });

  it("can record evidence that argues AGAINST the recommendation", async () => {
    await POST(req({ reference: "10.1000/abc", claim: "NECESSITY", stance: "OPPOSES" }), params);
    expect(db.state.evidence[0].stance).toBe("OPPOSES");
  });
});

describe("what the server refuses", () => {
  it("refuses a reference that resolves to nothing, rather than printing it", async () => {
    lit.candidates = [];
    const res = await POST(req({ reference: "some half-remembered paper", claim: "NECESSITY" }), params);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/could not be resolved/);
    expect(db.state.evidence).toHaveLength(0);
  });

  it("refuses a claim outside the vocabulary", async () => {
    const res = await POST(req({ reference: "10.1000/abc", claim: "VIBES" }), params);
    expect(res.status).toBe(422);
    expect(db.state.evidence).toHaveLength(0);
  });

  it("cannot attach evidence to another case's recommendation", async () => {
    db.state.items = [{ id: "item-1", caseId: "case-2", conditionId: null, service: "x", supersededAt: null }];
    const res = await POST(req({ reference: "10.1000/abc", claim: "NECESSITY" }), params);
    expect(res.status).toBe(404);
    expect(db.state.evidence).toHaveLength(0);
  });

  it("writes no audit event when nothing was attached", async () => {
    lit.candidates = [];
    await POST(req({ reference: "unresolvable", claim: "NECESSITY" }), params);
    expect(db.state.audits).toHaveLength(0);
  });
});

describe("removing a citation", () => {
  it("removes a physician's own row and audits it", async () => {
    await POST(req({ reference: "10.1000/abc", claim: "NECESSITY" }), params);
    const id = db.state.evidence[0].id as string;
    const res = await DELETE(new Request(`http://localhost/api?evidenceId=${id}`, { method: "DELETE" }), params);
    expect(res.status).toBe(200);
    expect(db.state.evidence).toHaveLength(0);
    expect(db.state.audits.some((a) => a.action === "futurecare.evidence_removed")).toBe(true);
  });

  it("will not remove a machine-derived row through this route", async () => {
    db.state.evidence = [{ id: "derived", caseId: "case-1", firmId: "firm-1", futureCareItemId: "item-1", addedById: null }];
    const res = await DELETE(new Request("http://localhost/api?evidenceId=derived", { method: "DELETE" }), params);
    expect(res.status).toBe(404);
    expect(db.state.evidence).toHaveLength(1);
  });
});
