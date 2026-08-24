// The batch factual confirmation, driven through the REAL route handler.
//
// Behavioural, not source-string: each test runs the handler against a fake
// database and asserts what changed and what did not. The properties that
// matter are the ones a browser must not be trusted with — which records a
// single click covers, that every one of them was displayed as it stands now,
// that an exception is never swept in with them, and that a refusal changes
// nothing at all.
//
// Synthetic data only.
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => {
  const state = {
    rows: [] as Record<string, unknown>[],
    documents: [] as Record<string, unknown>[],
    findings: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
    extractions: [] as Record<string, unknown>[],
    audits: [] as Record<string, unknown>[],
    /** Simulate a concurrent writer: the compare-and-set matches nothing. */
    raceOn: null as string | null,
    txAborted: false,
  };
  const inList = (v: unknown, x: unknown) => Array.isArray((v as { in?: unknown[] })?.in) && (v as { in: unknown[] }).in.includes(x);
  const matchRow = (r: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    if (where.id && typeof where.id === "object") { if (!inList(where.id, r.id)) return false; }
    else if (where.id && r.id !== where.id) return false;
    if (where.caseId && r.caseId !== where.caseId) return false;
    if (where.firmId && r.firmId !== where.firmId) return false;
    if (where.updatedAt && (r.updatedAt as Date)?.getTime?.() !== (where.updatedAt as Date)?.getTime?.()) return false;
    if (where.status && typeof where.status === "object" && !inList(where.status, r.status)) return false;
    if (where.supersededById === null && r.supersededById != null) return false;
    return true;
  };
  const matchEvent = (e: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    if (where.id && typeof where.id === "object") { if (!inList(where.id, e.id)) return false; }
    else if (where.id && e.id !== where.id) return false;
    if (where.caseId && e.caseId !== where.caseId) return false;
    if (typeof where.reviewStatus === "string" && e.reviewStatus !== where.reviewStatus) return false;
    if (where.reviewStatus && typeof where.reviewStatus === "object") {
      const notIn = (where.reviewStatus as { notIn?: string[] }).notIn ?? [];
      if (notIn.includes(e.reviewStatus as string)) return false;
    }
    if (where.edited !== undefined && e.edited !== where.edited) return false;
    return true;
  };
  const prisma = {
    extractedEncounter: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => state.rows.filter((r) => matchRow(r, where)).map((r) => ({ ...r })),
      count: async ({ where }: { where: Record<string, unknown> }) => state.rows.filter((r) => matchRow(r, where)).length,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (state.raceOn && where.id === state.raceOn) return { count: 0 };
        const hit = state.rows.filter((r) => matchRow(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    },
    document: { findMany: async () => state.documents.map((d) => ({ ...d })) },
    recordExtraction: { findMany: async () => state.extractions.map((e) => ({ ...e })) },
    recordFinding: { findMany: async () => state.findings.map((f) => ({ ...f })) },
    sourcePage: { findMany: async () => [] },
    chronologyEvent: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => state.events.filter((e) => matchEvent(e, where)).map((e) => ({ ...e })),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (state.raceOn && where.id === state.raceOn) return { count: 0 };
        const hit = state.events.filter((e) => matchEvent(e, where));
        for (const e of hit) Object.assign(e, data);
        return { count: hit.length };
      },
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { state.audits.push(data); return data; } },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const rowsBefore = JSON.parse(JSON.stringify(state.rows, (k, v) => (v instanceof Date ? v.toISOString() : v)));
      const eventsBefore = JSON.parse(JSON.stringify(state.events, (k, v) => (v instanceof Date ? v.toISOString() : v)));
      const auditsBefore = state.audits.length;
      try {
        return await work(prisma);
      } catch (e) {
        // Roll the fake back, as a real transaction would.
        state.txAborted = true;
        state.rows = rowsBefore.map((r: Record<string, unknown>) => ({ ...r, updatedAt: new Date(r.updatedAt as string) }));
        state.events = eventsBefore.map((r: Record<string, unknown>) => ({ ...r, eventDate: new Date(r.eventDate as string) }));
        state.audits.length = auditsBefore;
        throw e;
      }
    },
  };
  return { state, prisma };
});

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));

const tenant = vi.hoisted(() => {
  class TenantError extends Error {
    constructor(message: string, readonly code = "FORBIDDEN", readonly status = 403) {
      super(message);
      this.name = "TenantError";
    }
  }
  return { denied: null as string | null, TenantError };
});
vi.mock("@/lib/tenant", () => ({
  // The real class, so `handleError` narrows on it and answers 403 rather than
  // the generic 400 an unrecognised throw would produce.
  TenantError: tenant.TenantError,
  requireApiContext: vi.fn(async () => ({ user: { id: "reviewer-1" }, firm: { id: "firm-1" } })),
  requireCanonicalPermission: vi.fn((_ctx: unknown, permission: string) => {
    if (tenant.denied === permission) throw new tenant.TenantError("Not permitted");
  }),
  requireCase: vi.fn(async () => ({ id: "case-1" })),
  audit: vi.fn(async (ctx: { firm: { id: string }; user: { id: string } }, action: string, target: Record<string, unknown>, sink?: { auditLog: { create: (a: unknown) => Promise<unknown> } }) => {
    await (sink ?? db.prisma).auditLog.create({
      data: { firmId: ctx.firm.id, userId: ctx.user.id, action, caseId: target?.caseId, meta: target?.meta },
    } as never);
  }),
}));

import { GET, POST } from "./confirm/route";
import { encounterContentHash } from "@/lib/records/verifiedContent";

const params = { params: Promise.resolve({ caseId: "case-1" }) };
const post = (body: unknown) =>
  POST(new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), params);

const makeRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  caseId: "case-1",
  firmId: "firm-1",
  sourceDocumentId: "doc-1",
  status: "AI_AUDIT_PASSED",
  supersededById: null,
  dateStatus: "DOCUMENTED",
  encounterDate: new Date("2025-03-14T00:00:00Z"),
  encounterDateEnd: null,
  provider: "A. Rivera, MD",
  providerCredentials: "MD",
  facility: "Northgate Clinic",
  encounterType: "Clinic visit",
  factualSummary: `Clinic visit ${id}.`,
  synthesis: null,
  substanceClass: "CLINICAL",
  substanceReason: null,
  analysisClass: "CLINICAL_ENCOUNTER",
  segmentKey: null,
  attributionName: null,
  attributionRole: null,
  claims: [{ field: "assessment", value: `Lumbar radiculopathy documented for ${id}`, excerpt: "Assessment: …", page: 1 }],
  page: 1,
  pageEnd: 1,
  ocrConfidence: 0.98,
  warnings: [],
  reviewedAt: null,
  verifiedAt: null,
  reviewedById: null,
  staleReason: null,
  corroboration: null,
  auditResult: "PASS",
  auditVersion: "2026-08-17.scoped-findings",
  unresolvedDisputes: 0,
  contradictedFields: [],
  editedFields: [],
  verifiedContentHash: null,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
  ...over,
});

const makeEvent = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  caseId: "case-1",
  reviewStatus: "AI_DRAFT",
  edited: false,
  sourceDocumentId: "doc-1",
  eventDate: new Date("2025-03-14T00:00:00Z"),
  sourceFingerprint: `fp-${id}`,
  reviewedById: null,
  reviewedAt: null,
  ...over,
});

/** The current plan, exactly as the browser would be shown it. */
const preview = async () => (await (await GET(new Request("http://localhost/api"), params)).json()) as Record<string, never>;

beforeEach(() => {
  db.state.rows = [makeRow("a"), makeRow("b"), makeRow("c")];
  db.state.documents = [
    { id: "doc-1", caseId: "case-1", firmId: "firm-1", filename: "records.pdf", type: "MEDICAL_RECORD", pageCount: 10, serviceDate: null, serviceDateEnd: null, ocrConfidence: 0.98, flags: null, createdAt: new Date("2026-07-01T00:00:00Z"), segments: [{ rowIds: ["a"] }, { rowIds: ["b"] }, { rowIds: ["c"] }] },
  ];
  db.state.events = [makeEvent("e1"), makeEvent("e2")];
  db.state.findings = [];
  db.state.extractions = [];
  db.state.audits = [];
  db.state.raceOn = null;
  db.state.txAborted = false;
  tenant.denied = null;
});

// ─────────────────────────────────────────────────────────────────────────────
describe("one click, the whole clean set", () => {
  it("shows the counts before anything is confirmed", async () => {
    const plan = await preview();
    expect(plan.counts).toMatchObject({ canonicalEncounters: 3, eligibleEncounters: 3, skippedEncounters: 0, rows: 3, events: 2 });
    expect(typeof plan.manifestHash).toBe("string");
    // Reading the plan changes nothing.
    expect(db.state.rows.every((r) => r.status === "AI_AUDIT_PASSED")).toBe(true);
    expect(db.state.events.every((e) => e.reviewStatus === "AI_DRAFT")).toBe(true);
  });

  it("confirms every clean record and chronology draft in ONE request", async () => {
    const plan = await preview();
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ rows: 3, events: 2 });
    expect(db.state.rows.map((r) => r.status)).toEqual(["REVIEWED", "REVIEWED", "REVIEWED"]);
    expect(db.state.events.map((e) => e.reviewStatus)).toEqual(["REVIEWED", "REVIEWED"]);
  });

  it("records REVIEWED, never VERIFIED, and never a verification hash", async () => {
    const plan = await preview();
    await post({ expectedManifestHash: plan.manifestHash });
    for (const row of db.state.rows) {
      expect(row.status).toBe("REVIEWED");
      expect(row.verifiedContentHash).toBeNull();
      expect(row.verifiedAt).toBeNull();
      expect(row.reviewedById).toBe("reviewer-1");
      expect(row.reviewedAt).toBeInstanceOf(Date);
    }
  });

  it("writes one detailed audit event naming exactly what was covered", async () => {
    const plan = await preview();
    await post({ expectedManifestHash: plan.manifestHash, note: "Case review complete." });
    expect(db.state.audits).toHaveLength(1);
    const entry = db.state.audits[0];
    expect(entry.action).toBe("records.batch_confirm");
    expect(entry.userId).toBe("reviewer-1");
    expect(entry.caseId).toBe("case-1");
    const meta = entry.meta as Record<string, never>;
    expect(meta.firmId).toBe("firm-1");
    expect(meta.decision).toBe("REVIEWED");
    expect(meta.attestation).toBe(false);
    expect(meta.manifestHash).toBe(plan.manifestHash);
    // The exact manifest: every row with the content hash it was confirmed at.
    expect((meta.rows as { id: string }[]).map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
    expect((meta.rows as { contentHash: string }[]).every((r) => typeof r.contentHash === "string")).toBe(true);
    expect((meta.events as string[]).sort()).toEqual(["e1", "e2"]);
    expect(meta.groupingBasis).toEqual({ PERSISTED_SEGMENT: 3 });
    expect(meta.cautionsByKind).toEqual({});
    expect(meta.skippedByReason).toEqual({});
    expect(meta.note).toBe("Case review complete.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("an exception is never swept in", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["a failed audit", { auditResult: "FAILED" }],
    ["a recorded source conflict", { auditResult: "SOURCE_CONFLICT" }],
    ["an unresolved dispute", { unresolvedDisputes: 2 }],
    ["a contradicted field", { contradictedFields: ["date"] }],
    ["stale human work", { status: "STALE" }],
    ["a generation-loss candidate", { status: "GENERATION_LOSS" }],
    ["a required date that is missing", { dateStatus: "UNKNOWN", encounterDate: null }],
  ];

  for (const [name, over] of cases) {
    it(`leaves ${name} for individual review, and confirms the rest`, async () => {
      db.state.rows = [makeRow("a"), makeRow("bad", over)];
      db.state.documents[0].segments = [{ rowIds: ["a"] }, { rowIds: ["bad"] }];
      const plan = await preview();
      expect(plan.counts).toMatchObject({ eligibleEncounters: 1, skippedEncounters: 1 });
      await post({ expectedManifestHash: plan.manifestHash });
      expect(db.state.rows.find((r) => r.id === "a")!.status).toBe("REVIEWED");
      // Untouched: same status, same everything.
      expect(db.state.rows.find((r) => r.id === "bad")!.status).toBe(over.status ?? "AI_AUDIT_PASSED");
      expect(db.state.rows.find((r) => r.id === "bad")!.reviewedById).toBeNull();
    });
  }

  it("leaves a record carrying an open blocking finding", async () => {
    db.state.rows = [makeRow("a"), makeRow("flagged")];
    db.state.documents[0].segments = [{ rowIds: ["a"] }, { rowIds: ["flagged"] }];
    db.state.findings = [
      { id: "f1", scope: "ENTRY", type: "UNSUPPORTED_CLAIM", severity: "BLOCKING", blocking: true, source: "DETERMINISTIC_VALIDATOR", detail: "no supporting excerpt", excerpt: null, field: null, pageStart: null, pageEnd: null, claimIndex: null, status: "OPEN", encounterId: "flagged", sourceDocumentId: "doc-1", canonicalNoteId: null, fingerprint: "fp1", sourceFingerprint: null },
    ];
    const plan = await preview();
    expect(plan.counts).toMatchObject({ eligibleEncounters: 1, skippedEncounters: 1 });
    await post({ expectedManifestHash: plan.manifestHash });
    expect(db.state.rows.find((r) => r.id === "flagged")!.status).toBe("AI_AUDIT_PASSED");
  });

  it("does not require the case to be perfect before confirming its clean part", async () => {
    db.state.rows = [makeRow("a"), makeRow("b"), makeRow("bad", { auditResult: "FAILED" })];
    db.state.documents[0].segments = [{ rowIds: ["a"] }, { rowIds: ["b"] }, { rowIds: ["bad"] }];
    const plan = await preview();
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(200);
    expect((await res.json()).rows).toBe(2);
    expect(db.state.audits[0].meta).toMatchObject({ skippedEncounters: 1, skippedByReason: { INTEGRITY_FAILURE: 1 } });
  });

  it("holds a chronology draft on a date whose record is still in question", async () => {
    db.state.rows = [makeRow("bad", { auditResult: "FAILED" })];
    db.state.documents[0].segments = [{ rowIds: ["bad"] }];
    db.state.events = [makeEvent("contested"), makeEvent("clear", { eventDate: new Date("2025-06-02T00:00:00Z") })];
    const plan = await preview();
    expect(plan.counts).toMatchObject({ events: 1, heldEvents: 1 });
    await post({ expectedManifestHash: plan.manifestHash });
    expect(db.state.events.find((e) => e.id === "contested")!.reviewStatus).toBe("AI_DRAFT");
    expect(db.state.events.find((e) => e.id === "clear")!.reviewStatus).toBe("REVIEWED");
  });

  it("refuses when nothing at all is eligible, and changes nothing", async () => {
    db.state.rows = [makeRow("bad", { auditResult: "FAILED" })];
    db.state.documents[0].segments = [{ rowIds: ["bad"] }];
    db.state.events = [];
    const plan = await preview();
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    expect(db.state.rows[0].status).toBe("AI_AUDIT_PASSED");
    expect(db.state.audits).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("human work is never overwritten", () => {
  it("leaves reviewed, verified and human-edited rows exactly as they are", async () => {
    db.state.rows = [
      makeRow("draft"),
      makeRow("verified", { status: "VERIFIED", verifiedAt: new Date("2026-07-15T00:00:00Z"), verifiedContentHash: "abc" }),
      makeRow("edited", { status: "HUMAN_EDITED", editedFields: ["factualSummary"] }),
    ];
    db.state.documents[0].segments = [{ rowIds: ["draft"] }, { rowIds: ["verified"] }, { rowIds: ["edited"] }];
    const plan = await preview();
    await post({ expectedManifestHash: plan.manifestHash });
    expect(db.state.rows.find((r) => r.id === "verified")!.status).toBe("VERIFIED");
    expect(db.state.rows.find((r) => r.id === "verified")!.verifiedContentHash).toBe("abc");
    expect(db.state.rows.find((r) => r.id === "edited")!.status).toBe("HUMAN_EDITED");
    expect(db.state.rows.find((r) => r.id === "draft")!.status).toBe("REVIEWED");
  });

  it("leaves an edited chronology draft alone", async () => {
    db.state.events = [makeEvent("touched", { edited: true }), makeEvent("fresh")];
    const plan = await preview();
    await post({ expectedManifestHash: plan.manifestHash });
    expect(db.state.events.find((e) => e.id === "touched")!.reviewStatus).toBe("AI_DRAFT");
    expect(db.state.events.find((e) => e.id === "fresh")!.reviewStatus).toBe("REVIEWED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("drift aborts the whole batch", () => {
  it("refuses a manifest the case has moved past", async () => {
    const plan = await preview();
    // Another reviewer corrects a record between the dialog and the click.
    db.state.rows[0].factualSummary = "Corrected by another reviewer.";
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changed after these counts were shown/);
    expect(db.state.rows.every((r) => r.status === "AI_AUDIT_PASSED")).toBe(true);
    expect(db.state.audits).toHaveLength(0);
  });

  it("refuses a manifest that was never this case's", async () => {
    const res = await post({ expectedManifestHash: "0".repeat(64) });
    expect(res.status).toBe(409);
    expect(db.state.rows.every((r) => r.status === "AI_AUDIT_PASSED")).toBe(true);
  });

  it("rolls back EVERYTHING when one row moves during the write", async () => {
    const plan = await preview();
    db.state.raceOn = "b";
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    expect(db.state.txAborted).toBe(true);
    // Not one row, not one event, not the audit entry.
    expect(db.state.rows.every((r) => r.status === "AI_AUDIT_PASSED")).toBe(true);
    expect(db.state.events.every((e) => e.reviewStatus === "AI_DRAFT")).toBe(true);
    expect(db.state.audits).toHaveLength(0);
  });

  it("rolls back EVERYTHING when one chronology draft moves during the write", async () => {
    const plan = await preview();
    db.state.raceOn = "e2";
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    expect(db.state.rows.every((r) => r.status === "AI_AUDIT_PASSED")).toBe(true);
    expect(db.state.events.every((e) => e.reviewStatus === "AI_DRAFT")).toBe(true);
    expect(db.state.audits).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("tenant scope and permission", () => {
  it("requires records.verify — the same capability an individual decision needs", async () => {
    tenant.denied = "records.verify";
    const res = await post({ expectedManifestHash: "0".repeat(64) });
    expect(res.status).toBe(403);
    expect(db.state.rows.every((r) => r.status === "AI_AUDIT_PASSED")).toBe(true);
    const read = await GET(new Request("http://localhost/api"), params);
    expect(read.status).toBe(403);
  });

  it("touches nothing outside this case and firm", async () => {
    db.state.rows.push(makeRow("other-case", { caseId: "case-2" }), makeRow("other-firm", { firmId: "firm-2" }));
    const plan = await preview();
    await post({ expectedManifestHash: plan.manifestHash });
    expect(db.state.rows.find((r) => r.id === "other-case")!.status).toBe("AI_AUDIT_PASSED");
    expect(db.state.rows.find((r) => r.id === "other-firm")!.status).toBe("AI_AUDIT_PASSED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("confirming does not change the extracted record", () => {
  // The acceptance property: this act may not improve, condense, deduplicate,
  // reclassify or drop extracted content in order to shrink a queue.
  const CONTENT_FIELDS = [
    "factualSummary", "synthesis", "claims", "encounterDate", "encounterDateEnd", "dateStatus",
    "provider", "providerCredentials", "facility", "encounterType", "analysisClass", "substanceClass",
    "substanceReason", "segmentKey", "page", "pageEnd", "ocrConfidence", "warnings", "auditResult",
    "auditVersion", "unresolvedDisputes", "contradictedFields",
  ];

  it("changes only review status and review metadata, row for row", async () => {
    const before = JSON.parse(JSON.stringify(db.state.rows));
    const beforeHashes = db.state.rows.map((r) => encounterContentHash(r as never));
    const plan = await preview();
    await post({ expectedManifestHash: plan.manifestHash });

    expect(db.state.rows).toHaveLength(before.length);
    db.state.rows.forEach((row, i) => {
      for (const field of CONTENT_FIELDS) {
        expect(JSON.stringify(row[field]), `${row.id}.${field}`).toBe(JSON.stringify(before[i][field]));
      }
      // The content hash is computed over exactly the facts a reader sees.
      expect(encounterContentHash(row as never)).toBe(beforeHashes[i]);
    });
  });

  it("changes only review status on chronology entries — no prose, no dates", async () => {
    const before = JSON.parse(JSON.stringify(db.state.events));
    const plan = await preview();
    await post({ expectedManifestHash: plan.manifestHash });
    expect(db.state.events).toHaveLength(before.length);
    db.state.events.forEach((event, i) => {
      for (const field of ["eventDate", "sourceDocumentId", "sourceFingerprint", "edited"]) {
        expect(JSON.stringify(event[field]), `${event.id}.${field}`).toBe(JSON.stringify(before[i][field]));
      }
    });
  });

  it("does not change the canonical grouping it confirmed", async () => {
    const beforePlan = await preview();
    const beforeGroups = (beforePlan.counts as Record<string, number>).canonicalEncounters;
    await post({ expectedManifestHash: beforePlan.manifestHash });
    const afterPlan = await preview();
    expect((afterPlan.counts as Record<string, number>).canonicalEncounters).toBe(beforeGroups);
    // Nothing is left eligible, because everything is now reviewed — not
    // because anything was dropped.
    expect((afterPlan.counts as Record<string, number>).alreadyReviewedEncounters).toBe(beforeGroups);
    expect((afterPlan.counts as Record<string, number>).skippedEncounters).toBe(0);
  });

  it("is idempotent: a second confirmation has nothing left to do", async () => {
    const plan = await preview();
    await post({ expectedManifestHash: plan.manifestHash });
    const second = await preview();
    const res = await post({ expectedManifestHash: second.manifestHash });
    expect(res.status).toBe(409);
    expect(db.state.audits).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("a hundred clean records are one request", () => {
  it("confirms a case of 100 extracted rows with a single click", async () => {
    // 100 fragments, 50 real encounters (each pair carries the same stored
    // note identity), ONE confirmation — not 100 decisions and not 50.
    db.state.rows = Array.from({ length: 100 }, (_, i) =>
      makeRow(`r${i}`, {
        segmentKey: `note-${Math.floor(i / 2)}`,
        encounterDate: new Date(`2025-03-${String(1 + (Math.floor(i / 2) % 28)).padStart(2, "0")}T00:00:00Z`),
        claims: [{ field: "assessment", value: `Documented assessment for encounter ${Math.floor(i / 2)}`, excerpt: "…", page: 1 + i }],
      }),
    );
    // The legacy ingest-time segment shape: no rowIds to resolve, so the
    // compatibility grouping decides membership.
    db.state.documents[0].segments = [
      { date: "2025-03-01", label: "03/01/2025", pageStart: 1, pageEnd: 1, offsetStart: 0, offsetEnd: 100, kind: "clinical", type: "CLINICAL_ENCOUNTER", category: null, bearsOnCare: true, provider: "A. Rivera, MD", facility: null, summary: "Clinic visit." },
    ];
    db.state.events = [];

    const plan = await preview();
    expect(plan.counts).toMatchObject({ canonicalEncounters: 50, eligibleEncounters: 50, skippedEncounters: 0, rows: 100 });

    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(200);
    expect((await res.json()).rows).toBe(100);
    expect(db.state.rows.every((r) => r.status === "REVIEWED")).toBe(true);
    // ONE decision recorded, over a manifest naming every row.
    expect(db.state.audits).toHaveLength(1);
    expect((db.state.audits[0].meta as { rows: unknown[] }).rows).toHaveLength(100);
    expect((db.state.audits[0].meta as { groupingBasis: unknown }).groupingBasis).toEqual({ COMPATIBILITY_FALLBACK: 50 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the final export gate, before and after", () => {
  const gate = async () => {
    const { factualReviewState } = await import("@/lib/records/structuredRecord");
    return factualReviewState("case-1", "firm-1");
  };

  it("fails before the confirmation, passes after it, and fails again while an exception remains", async () => {
    // BEFORE: audit-passed drafts nobody has reviewed.
    const before = await gate();
    expect(before.complete).toBe(false);
    expect(before.blockers.some((b) => /pending human review/.test(b))).toBe(true);

    // THE ONE ACT.
    const plan = await preview();
    expect((await post({ expectedManifestHash: plan.manifestHash })).status).toBe(200);

    // AFTER: the clean records and their chronology are reviewed, so the gate
    // that had no reachable exit now has one.
    const after = await gate();
    expect(after.blockers).toEqual([]);
    expect(after.complete).toBe(true);
  });

  it("still blocks while ONE unresolved exception sits beside the confirmed set", async () => {
    db.state.rows = [makeRow("a"), makeRow("bad", { auditResult: "FAILED" })];
    db.state.documents[0].segments = [{ rowIds: ["a"] }, { rowIds: ["bad"] }];
    const plan = await preview();
    await post({ expectedManifestHash: plan.manifestHash });
    const { complete, blockers } = await gate();
    expect(complete).toBe(false);
    expect(blockers.some((b) => /ended the factual audit as failed/.test(b))).toBe(true);
    // The chronology entries on that date were held back too — an exception
    // holds its own day — so they are still drafts.
    expect(db.state.events.every((e) => e.reviewStatus === "AI_DRAFT")).toBe(true);

    // The reviewer resolves the exception through the individual path…
    const bad = db.state.rows.find((r) => r.id === "bad")!;
    bad.status = "HUMAN_EDITED";
    bad.editedFields = ["factualSummary"];
    // …the machine grade is history, so the record no longer blocks…
    expect((await gate()).blockers.some((b) => /ended the factual audit/.test(b))).toBe(false);
    // …and the freed chronology entries are covered by confirming again.
    const second = await preview();
    expect(second.counts).toMatchObject({ events: 2, heldEvents: 0 });
    expect((await post({ expectedManifestHash: second.manifestHash })).status).toBe(200);
    expect((await gate()).complete).toBe(true);
  });

  it("still blocks on a document-scoped finding, counted once, whatever the batch confirmed", async () => {
    db.state.findings = [
      { id: "f1", fingerprint: "fp-doc", scope: "DOCUMENT", type: "MISSING_ENCOUNTER", severity: "BLOCKING", blocking: true, source: "PAGE_LEDGER", detail: "a dated note produced no entry", status: "OPEN", sourceDocumentId: "doc-1", canonicalNoteId: null, encounterId: null, excerpt: null, field: null, pageStart: null, pageEnd: null, claimIndex: null, sourceFingerprint: null },
    ];
    const plan = await preview();
    // A document-level problem is not multiplied across the clean records
    // inside it: all three are still eligible.
    expect(plan.counts).toMatchObject({ eligibleEncounters: 3, skippedEncounters: 0 });
    await post({ expectedManifestHash: plan.manifestHash });
    const { complete, blockers } = await gate();
    expect(complete).toBe(false);
    expect(blockers.filter((b) => /document-level finding/.test(b))).toHaveLength(1);
  });
});
