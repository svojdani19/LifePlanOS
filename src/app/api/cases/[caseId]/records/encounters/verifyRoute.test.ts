// Verification is a statement about content: the hash lands atomically with
// the status, stale payloads are refused, re-verification is idempotent, and
// editing verified content revokes the verification with a documented reason.
// Synthetic data only.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encounterContentHash } from "@/lib/records/verifiedContent";

const db = vi.hoisted(() => {
  const state = {
    row: null as Record<string, unknown> | null,
    updates: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
    audits: [] as { action: string; meta?: Record<string, unknown> }[],
    /** When true, simulate a concurrent writer: CAS updateMany matches nothing. */
    raceLoser: false,
  };
  const prisma = {
    extractedEncounter: {
      findFirst: async () => state.row,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.row!, data);
        return state.row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        state.updates.push({ where, data });
        if (state.raceLoser) return { count: 0 };
        Object.assign(state.row!, data, { updatedAt: new Date(Date.now() + 1000) });
        return { count: 1 };
      },
    },
    document: { findFirst: async () => ({ type: "PROGRESS_NOTE" }) },
    correctionExemplar: { create: async () => ({ id: "x" }) },
  };
  return { state, prisma };
});

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));
vi.mock("@/lib/tenant", () => ({
  requireApiContext: vi.fn(async () => ({ user: { id: "reviewer-1" }, firm: { id: "firm-1" } })),
  requireCanonicalPermission: vi.fn(),
  requireCase: vi.fn(async () => ({ id: "case-1" })),
  audit: vi.fn(async (_ctx: unknown, action: string, detail: { meta?: Record<string, unknown> }) => {
    db.state.audits.push({ action, meta: detail.meta });
  }),
}));
vi.mock("@/lib/llm/correctionExemplars", () => ({ recordCorrectionExemplar: vi.fn(async () => "ex-1") }));

// Downstream flows, observed rather than run: which review actions cause a
// derived refresh, and which go further and regenerate the plan.
const flow = vi.hoisted(() => ({
  refreshOutcome: { published: true, coalesced: false, attempts: 1, history: [] as unknown[], status: "Records updated." },
  refreshes: [] as string[],
  regenerated: [] as string[],
}));
vi.mock("@/lib/records/buildRecords", () => ({
  makeRecordStore: (x: unknown) => x,
  refreshCaseRecordsWithRecovery: vi.fn(async (_db: unknown, caseId: string) => {
    flow.refreshes.push(caseId);
    return flow.refreshOutcome;
  }),
}));
// The route regenerates through the ORCHESTRATOR now, not through
// `generatePlan` alone: the lease has to cover validation, reasoning and
// attestation refresh as well, or a coalesced final pass leaves them
// describing the plan before it. See engine/runPipeline.ts.
vi.mock("@/lib/engine/runPipeline", () => ({
  runCasePipeline: vi.fn(async (caseId: string) => {
    flow.regenerated.push(caseId);
    return { passes: 1, finalizerErrors: [] };
  }),
}));

import { POST, PATCH } from "./[encounterId]/route";

const params = { params: Promise.resolve({ caseId: "case-1", encounterId: "enc-1" }) };
const req = (body: unknown, method = "POST") =>
  new Request("http://localhost/api", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const baseRow = () => ({
  id: "enc-1",
  caseId: "case-1",
  firmId: "firm-1",
  sourceDocumentId: "doc-1",
  status: "AI_AUDIT_PASSED",
  dateStatus: "DOCUMENTED",
  encounterDate: new Date("2025-03-14T00:00:00Z"),
  provider: "Dana Rivers, MD",
  providerCredentials: null,
  facility: null,
  encounterType: "Clinic visit",
  factualSummary: "Clinic visit — Lumbar radiculopathy.",
  synthesis: null,
  claims: [{ field: "assessment", claimType: "DIAGNOSIS", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: 4 }],
  editedFields: [],
  reviewNote: null,
  verifiedById: null,
  verifiedAt: null,
  verifiedContentHash: null,
  updatedAt: new Date("2026-08-01T00:00:00Z"),
});

beforeEach(() => {
  db.state.row = baseRow();
  db.state.updates = [];
  db.state.audits = [];
  db.state.raceLoser = false;
  flow.refreshOutcome = { published: true, coalesced: false, attempts: 1, history: [], status: "Records updated." };
  flow.refreshes = [];
  flow.regenerated = [];
});

/** Let the fire-and-forget refresh → regeneration chain drain. */
const settled = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe("verify persists the hash atomically", () => {
  it("VERIFIED lands with the content hash, reviewer, and timestamp in ONE write", async () => {
    const res = await POST(req({ action: "verify" }), params);
    expect(res.status).toBe(200);
    const write = db.state.updates[0];
    expect(write.data.status).toBe("VERIFIED");
    expect(write.data.verifiedContentHash).toBe(encounterContentHash(baseRow()));
    expect(write.data.verifiedById).toBe("reviewer-1");
    expect(write.data.verifiedAt).toBeInstanceOf(Date);
    // The CAS predicate binds the write to the exact version that was read.
    expect(write.where.updatedAt).toEqual(baseRow().updatedAt);
  });

  it("a stale client payload is refused with 409", async () => {
    const res = await POST(req({ action: "verify", expectedContentHash: "0".repeat(64) }), params);
    expect(res.status).toBe(409);
    expect(db.state.updates).toHaveLength(0);
    const body = await res.json();
    expect(body.error).toMatch(/changed since it was displayed/);
  });

  it("a concurrent write between read and verify is refused with 409", async () => {
    db.state.raceLoser = true;
    const res = await POST(req({ action: "verify" }), params);
    expect(res.status).toBe(409);
  });

  it("re-verifying unchanged content is idempotent — no second write", async () => {
    await POST(req({ action: "verify" }), params);
    const writesAfterFirst = db.state.updates.length;
    const res = await POST(req({ action: "verify" }), params);
    expect(res.status).toBe(200);
    expect((await res.json()).idempotent).toBe(true);
    expect(db.state.updates.length).toBe(writesAfterFirst);
  });

  it("verification of edited-then-changed content produces a NEW hash", async () => {
    await POST(req({ action: "verify" }), params);
    const firstHash = db.state.row!.verifiedContentHash;
    db.state.row!.factualSummary = "Clinic visit — different content.";
    const res = await POST(req({ action: "verify" }), params);
    expect(res.status).toBe(200);
    expect(db.state.row!.verifiedContentHash).not.toBe(firstHash);
  });
});

describe("editing verified content revokes verification", () => {
  beforeEach(async () => {
    await POST(req({ action: "verify" }), params);
  });

  it("a material edit without a documented reason is refused", async () => {
    const res = await PATCH(req({ factualSummary: "Corrected summary text." }, "PATCH"), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/documented reason/);
    expect(db.state.row!.status).toBe("VERIFIED"); // untouched
  });

  it("a material edit with a reason revokes: HUMAN_EDITED, hash cleared, audited with the reason", async () => {
    const res = await PATCH(req({ factualSummary: "Corrected summary text.", reviewNote: "Provider name was wrong in the draft." }, "PATCH"), params);
    expect(res.status).toBe(200);
    expect(db.state.row!.status).toBe("HUMAN_EDITED");
    expect(db.state.row!.verifiedContentHash).toBeNull();
    const auditEntry = db.state.audits.find((a) => a.action === "records.encounter_edit");
    expect(auditEntry?.meta?.revokedVerification).toBe(true);
    expect(auditEntry?.meta?.reason).toMatch(/Provider name/);
  });

  it("a NOTE-ONLY edit is nonmaterial: status and hash survive", async () => {
    const res = await PATCH(req({ reviewNote: "Checked against the scan; all good." }, "PATCH"), params);
    expect(res.status).toBe(200);
    expect(db.state.row!.status).toBe("VERIFIED");
    expect(db.state.row!.verifiedContentHash).toBe(encounterContentHash(baseRow()));
  });

  it("a concurrent edit race is refused with 409 rather than applied blind", async () => {
    db.state.raceLoser = true;
    const res = await PATCH(req({ factualSummary: "Racing edit.", reviewNote: "reason" }, "PATCH"), params);
    expect(res.status).toBe(409);
  });
});

describe("review action", () => {
  it("REVIEWED never carries a verification hash — it is not verification", async () => {
    const res = await POST(req({ action: "review" }), params);
    expect(res.status).toBe(200);
    expect(db.state.row!.status).toBe("REVIEWED");
    expect(db.state.row!.verifiedContentHash).toBeNull();
  });
});

describe("which review actions invalidate the plan", () => {
  // One rule (PLAN_INPUT_FIELDS in the route): the plan regenerates when an
  // action changes its input set — membership of a row, or a field the
  // generator reads. Everything else refreshes derived output only.

  it("editing substanceClass regenerates — the plan filters on it", async () => {
    const res = await PATCH(req({ substanceClass: "ADMINISTRATIVE", reviewNote: "Misfiled paperwork." }, "PATCH"), params);
    expect(res.status).toBe(200);
    expect((await res.json()).regenerationTriggered).toBe(true);
    await settled();
    expect(flow.refreshes).toEqual(["case-1"]);
    expect(flow.regenerated).toEqual(["case-1"]);
  });

  it("editing only the factual summary refreshes derived output without regenerating", async () => {
    const res = await PATCH(req({ factualSummary: "Clinic visit — corrected wording.", reviewNote: "Wording." }, "PATCH"), params);
    expect(res.status).toBe(200);
    expect((await res.json()).regenerationTriggered).toBeUndefined();
    await settled();
    expect(flow.refreshes).toEqual(["case-1"]);
    expect(flow.regenerated).toEqual([]);
  });

  it("an edit that restores a lost row to the output regenerates whatever field it touched", async () => {
    db.state.row = { ...baseRow(), status: "GENERATION_LOSS", verifiedContentHash: null };
    const res = await PATCH(req({ factualSummary: "Confirmed against the source.", reviewNote: "Confirmed." }, "PATCH"), params);
    expect(res.status).toBe(200);
    expect((await res.json()).regenerationTriggered).toBe(true);
    await settled();
    expect(flow.regenerated).toEqual(["case-1"]);
  });

  it("rejecting an active row regenerates — it leaves the plan's input set", async () => {
    db.state.row = { ...baseRow(), verifiedContentHash: null };
    const res = await POST(req({ action: "reject", note: "Not this patient." }), params);
    expect(res.status).toBe(200);
    await settled();
    expect(flow.refreshes).toEqual(["case-1"]);
    expect(flow.regenerated).toEqual(["case-1"]);
  });

  it("rejecting a row the plan never used refreshes without regenerating", async () => {
    db.state.row = { ...baseRow(), status: "STALE", verifiedContentHash: null };
    const res = await POST(req({ action: "reject", note: "Superseded content." }), params);
    expect(res.status).toBe(200);
    await settled();
    expect(flow.refreshes).toEqual(["case-1"]);
    expect(flow.regenerated).toEqual([]);
  });

  it("confirming a GENERATION_LOSS row by review restores it and regenerates", async () => {
    db.state.row = { ...baseRow(), status: "GENERATION_LOSS", verifiedContentHash: null };
    const res = await POST(req({ action: "review" }), params);
    expect(res.status).toBe(200);
    await settled();
    expect(flow.regenerated).toEqual(["case-1"]);
  });

  it("reviewing an already-active row does not regenerate", async () => {
    const res = await POST(req({ action: "review" }), params);
    expect(res.status).toBe(200);
    await settled();
    expect(flow.refreshes).toEqual(["case-1"]);
    expect(flow.regenerated).toEqual([]);
  });

  it("a refresh that merely coalesced without publishing does NOT fire regeneration", async () => {
    // The round-2 sequencing fix gated on (published || coalesced); coalesced
    // meant the OTHER flight had not yet published, so regeneration read the
    // pre-correction chronology. The gate is publication, full stop.
    flow.refreshOutcome = { published: false, coalesced: true, attempts: 0, history: [], status: "..." };
    const res = await PATCH(req({ substanceClass: "ADMINISTRATIVE", reviewNote: "Misfiled." }, "PATCH"), params);
    expect(res.status).toBe(200);
    await settled();
    expect(flow.refreshes).toEqual(["case-1"]);
    expect(flow.regenerated).toEqual([]);
  });
});
