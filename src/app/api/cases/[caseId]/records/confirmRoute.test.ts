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
    /**
     * A committed change by SOMEBODY ELSE, injected at the moment the
     * transaction takes its row locks — i.e. after the outer recheck and
     * before any write. The deterministic stand-in for a real interleaving.
     */
    raceAtLock: null as (() => void) | null,
    /** Every raw statement the transaction issued, so the locks are testable. */
    rawCalls: [] as string[],
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
    // The advisory lock. Recorded, not executed.
    $executeRawUnsafe: async (sql: string) => {
      state.rawCalls.push(sql);
      return 0;
    },
    // `SELECT … FOR UPDATE`. In a real database this blocks concurrent
    // writers until commit; here it is the point at which a concurrent write
    // is injected, because that is the last instant one could still land.
    $queryRawUnsafe: async (sql: string) => {
      state.rawCalls.push(sql);
      const race = state.raceAtLock;
      state.raceAtLock = null;
      race?.();
      return [];
    },
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
import { CHRONOLOGY_CONTENT_FIELDS } from "@/lib/records/chronologyContent";

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
  // Real content in the fields the retention job and a reviewer actually
  // touch. A fixture whose hashed fields are all absent cannot tell a purge
  // from a no-op — the hash reads an absent field and a nulled one alike.
  summary: `Follow-up visit ${id}; conservative care continued.`,
  sourceQuote: `verbatim excerpt behind ${id}`,
  sourcePage: 4,
  // Exact lineage, as the current builder writes it. Eligibility is decided
  // from THIS, not from source document plus service date — that key could not
  // tell two same-day encounters in one document apart, so confirming either
  // swept in the events of both.
  sourceRowIds: ["a"],
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
  db.state.raceAtLock = null;
  db.state.rawCalls = [];
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
    db.state.rows = [
      makeRow("bad", { auditResult: "FAILED" }),
      makeRow("good", { encounterDate: new Date("2025-06-02T00:00:00Z") }),
    ];
    db.state.documents[0].segments = [{ rowIds: ["bad"] }, { rowIds: ["good"] }];
    db.state.events = [
      makeEvent("contested", { sourceRowIds: ["bad"] }),
      makeEvent("clear", { eventDate: new Date("2025-06-02T00:00:00Z"), sourceRowIds: ["good"] }),
    ];
    const plan = await preview();
    expect(plan.counts).toMatchObject({ events: 1, heldEvents: 1 });
    expect(plan.heldEventsByReason).toEqual({ RECORD_IN_QUESTION: 1 });
    await post({ expectedManifestHash: plan.manifestHash });
    expect(db.state.events.find((e) => e.id === "contested")!.reviewStatus).toBe("AI_DRAFT");
    expect(db.state.events.find((e) => e.id === "clear")!.reviewStatus).toBe("REVIEWED");
  });

  it("releases a RECORD_IN_QUESTION entry automatically once its record is settled", async () => {
    // The claim the panel makes about these: no separate chronology review is
    // needed, the next confirmation covers them. That has to be true.
    db.state.rows = [makeRow("bad", { auditResult: "FAILED" })];
    db.state.documents[0].segments = [{ rowIds: ["bad"] }];
    db.state.events = [makeEvent("waiting", { sourceRowIds: ["bad"] })];

    const first = await preview();
    expect(first.counts).toMatchObject({ events: 0, heldEvents: 1 });
    expect(first.heldEventsByReason).toEqual({ RECORD_IN_QUESTION: 1 });

    // The reviewer resolves the RECORD, through the individual path. They do
    // nothing at all to the chronology entry.
    const bad = db.state.rows[0];
    bad.status = "HUMAN_EDITED";
    bad.editedFields = ["factualSummary"];

    const second = await preview();
    expect(second.counts).toMatchObject({ events: 1, heldEvents: 0 });
    expect((await post({ expectedManifestHash: second.manifestHash })).status).toBe(200);
    expect(db.state.events[0].reviewStatus).toBe("REVIEWED");
  });

  it("holds a chronology draft nothing in the records supports", async () => {
    db.state.events = [
      makeEvent("supported"),
      // A legacy event, or one the regex path produced: nothing names a row.
      makeEvent("orphan", { sourceDocumentId: null, sourceRowIds: null }),
      // Names a row this case does not confirm.
      makeEvent("floating", { eventDate: new Date("2031-01-01T00:00:00Z"), sourceRowIds: ["row-nobody-confirmed"] }),
    ];
    const plan = await preview();
    expect(plan.counts).toMatchObject({ events: 1, heldEvents: 2 });
    expect(plan.heldEventsByReason).toEqual({ NO_EXACT_LINEAGE: 1, NO_CONFIRMED_RECORD: 1 });
    await post({ expectedManifestHash: plan.manifestHash });
    expect(db.state.events.find((e) => e.id === "supported")!.reviewStatus).toBe("REVIEWED");
    expect(db.state.events.find((e) => e.id === "orphan")!.reviewStatus).toBe("AI_DRAFT");
    expect(db.state.events.find((e) => e.id === "floating")!.reviewStatus).toBe("AI_DRAFT");
  });

  it("leaves an entry the factual audit never graded for individual review", async () => {
    db.state.rows = [makeRow("a"), makeRow("ungraded", { auditResult: null, auditVersion: null })];
    db.state.documents[0].segments = [{ rowIds: ["a"] }, { rowIds: ["ungraded"] }];
    const plan = await preview();
    expect(plan.counts).toMatchObject({ eligibleEncounters: 1, skippedEncounters: 1 });
    expect(plan.skippedByReason).toEqual({ UNAUDITED: 1 });
    await post({ expectedManifestHash: plan.manifestHash });
    expect(db.state.rows.find((r) => r.id === "ungraded")!.status).toBe("AI_AUDIT_PASSED");
    expect(db.state.rows.find((r) => r.id === "a")!.status).toBe("REVIEWED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("an ambiguity cluster is held whole, and released by one decision", () => {
  /** Four fragments the identity rules can neither join nor separate. */
  const seedCluster = () => {
    db.state.rows = Array.from({ length: 4 }, (_, i) =>
      makeRow(`u${i}`, {
        claims: [{ field: "subjective", value: `Interval note paragraph number ${i} describing the encounter`, excerpt: "…", page: 4 }],
      }),
    );
    // Ingest-time segments: no rowIds, so the compatibility path decides.
    db.state.documents[0].segments = [
      { date: "2025-03-14", label: "03/14/2025", pageStart: 1, pageEnd: 1, offsetStart: 0, offsetEnd: 900, kind: "clinical", type: "CLINICAL_ENCOUNTER", category: null, bearsOnCare: true, provider: "A. Rivera, MD", facility: null, summary: "Clinic visit." },
    ];
    db.state.events = [];
  };

  it("confirms none of the four while the one question is open", async () => {
    seedCluster();
    const plan = await preview();
    expect(plan.counts).toMatchObject({ canonicalEncounters: 4, eligibleEncounters: 0, skippedEncounters: 1, heldEncounters: 3 });
    expect(plan.skippedByReason).toEqual({ AMBIGUOUS_ASSIGNMENT: 1 });
    expect(plan.heldByReason).toEqual({ AWAITING_ASSIGNMENT_DECISION: 3 });
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    expect(db.state.rows.every((r) => r.status === "AI_AUDIT_PASSED")).toBe(true);
  });

  it("releases the other three once the anchor is explicitly reviewed as separate", async () => {
    seedCluster();
    // The reviewer answers the one question through the individual path.
    // (`u0` anchors: `groupByIdentity` orders by id when no span is known.)
    db.state.rows.find((r) => r.id === "u0")!.status = "REVIEWED";

    const plan = await preview();
    expect(plan.counts).toMatchObject({ eligibleEncounters: 3, skippedEncounters: 0, heldEncounters: 0, alreadyReviewedEncounters: 1 });
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(200);
    expect((await res.json()).rows).toBe(3);
    expect(db.state.rows.map((r) => r.status)).toEqual(["REVIEWED", "REVIEWED", "REVIEWED", "REVIEWED"]);
  });

  it("is NOT released by a correction to the anchor", async () => {
    seedCluster();
    db.state.rows.find((r) => r.id === "u0")!.status = "HUMAN_EDITED";
    const plan = await preview();
    expect(plan.counts).toMatchObject({ eligibleEncounters: 0, skippedEncounters: 1 });
    expect(plan.skippedByReason).toEqual({ AMBIGUOUS_ASSIGNMENT: 1 });
  });

  it("keeps the final gate shut until the decision is made, then opens with the batch", async () => {
    const { factualReviewState } = await import("@/lib/records/structuredRecord");
    seedCluster();
    // Unresolved: four machine drafts nobody has reviewed.
    expect((await factualReviewState("case-1", "firm-1")).complete).toBe(false);

    // The one decision, through the individual path…
    db.state.rows.find((r) => r.id === "u0")!.status = "REVIEWED";
    // …still shut, because three records remain unreviewed…
    expect((await factualReviewState("case-1", "firm-1")).complete).toBe(false);

    // …and the batch, now unblocked, closes them in one act.
    const plan = await preview();
    expect((await post({ expectedManifestHash: plan.manifestHash })).status).toBe(200);
    expect((await factualReviewState("case-1", "firm-1")).complete).toBe(true);
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

  it("refuses when a chronology entry's PROSE changed and its status did not", async () => {
    // The case the id/status/date manifest could not see: an event has no
    // `updatedAt` to compare against, and `sourceFingerprint` fingerprints the
    // claims it was generated from, not the sentence a reader sees.
    const plan = await preview();
    db.state.events[0].summary = "A materially different sentence about this visit.";
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    expect(db.state.rows.every((r) => r.status === "AI_AUDIT_PASSED")).toBe(true);
    expect(db.state.events.every((e) => e.reviewStatus === "AI_DRAFT")).toBe(true);
    expect(db.state.audits).toHaveLength(0);
  });

  it("refuses when the GROUPING changed but the row set did not", async () => {
    // Same rows, same content, same statuses — one canonical encounter instead
    // of three. A completely different dialog.
    const plan = await preview();
    db.state.documents[0].segments = [{ rowIds: ["a", "b", "c"] }];
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changed after these counts were shown/);
    expect(db.state.rows.every((r) => r.status === "AI_AUDIT_PASSED")).toBe(true);
  });

  it("refuses when a record moved from eligible to skipped", async () => {
    const plan = await preview();
    db.state.rows[1].auditResult = "FAILED";
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    expect(db.state.rows.every((r) => r.status === "AI_AUDIT_PASSED")).toBe(true);
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

  it("changes only review status on chronology entries — every rendered field intact", async () => {
    // Seeded with real content in every field the Medical Chronology renders,
    // so "unchanged" means unchanged, not "the three fields the fixture had".
    db.state.events = [
      makeEvent("e1", {
        eventDateEnd: new Date("2025-05-01T00:00:00Z"),
        dateInferred: false,
        eventType: "CLINIC_VISIT",
        recordType: "CLINICAL_ENCOUNTER",
        specialty: "Orthopaedics",
        provider: "A. Rivera, MD",
        facility: "Northgate Clinic",
        summary: "Follow-up for lumbar radiculopathy; conservative care continued.",
        subjective: "Reports low back pain radiating to the left leg.",
        pastMedicalHistory: "Hypertension.",
        objectiveFindings: "Straight leg raise positive at forty degrees.",
        diagnosis: "Lumbar radiculopathy",
        treatment: "Continue physical therapy.",
        procedure: null,
        disposition: "Return in four weeks.",
        imagingFindings: null,
        medications: "Gabapentin 300mg.",
        restrictions: "No lifting over ten pounds.",
        workStatus: "Light duty.",
        functionalStatus: "Ambulates independently.",
        impairmentRating: null,
        clinicalSignificance: "Grounds the future-care recommendation.",
        sourcePage: 4,
        sourceQuote: "straight leg raise positive on the right",
        extractionId: "run-1",
        relevanceScore: 50,
        relatedness: "UNCLEAR",
        seriesMembers: [{ date: "2025-03-14", documentId: "doc-1", page: 4 }],
      }),
    ];
    const before = JSON.parse(JSON.stringify(db.state.events));
    const plan = await preview();
    await post({ expectedManifestHash: plan.manifestHash });

    expect(db.state.events).toHaveLength(before.length);
    // Everything the hash covers except the two review fields the act writes.
    const content = CHRONOLOGY_CONTENT_FIELDS.filter((f) => f !== "reviewStatus" && f !== "edited");
    db.state.events.forEach((event, i) => {
      for (const field of content) {
        expect(JSON.stringify(event[field]), `${event.id}.${field}`).toBe(JSON.stringify(before[i][field]));
      }
      expect(event.reviewStatus).toBe("REVIEWED");
      expect(event.edited).toBe(false);
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
    // One entry per record, each naming the record it was built from. Under
    // the old document-plus-date key these were indistinguishable, and the
    // failed record held BOTH; exact lineage separates them, which is the
    // point — a broken record holds its own entry, not its neighbour's.
    db.state.events = [makeEvent("e-good", { sourceRowIds: ["a"] }), makeEvent("e-bad", { sourceRowIds: ["bad"] })];
    const plan = await preview();
    expect(plan.counts).toMatchObject({ events: 1, heldEvents: 1 });
    await post({ expectedManifestHash: plan.manifestHash });
    const { complete, blockers } = await gate();
    // The exception still blocks the final export, which is the invariant this
    // test exists for.
    expect(complete).toBe(false);
    expect(blockers.some((b) => /ended the factual audit as failed/.test(b))).toBe(true);
    // The entry built from the failed record was NOT confirmed…
    expect(db.state.events.find((e) => e.id === "e-bad")!.reviewStatus).toBe("AI_DRAFT");
    // …and the one built from the clean record was.
    expect(db.state.events.find((e) => e.id === "e-good")!.reviewStatus).toBe("REVIEWED");

    // The reviewer resolves the exception through the individual path…
    const bad = db.state.rows.find((r) => r.id === "bad")!;
    bad.status = "HUMAN_EDITED";
    bad.editedFields = ["factualSummary"];
    // …the machine grade is history, so the record no longer blocks…
    expect((await gate()).blockers.some((b) => /ended the factual audit/.test(b))).toBe(false);
    // …and the freed chronology entry is covered by confirming again.
    const second = await preview();
    expect(second.counts).toMatchObject({ events: 1, heldEvents: 0 });
    expect((await post({ expectedManifestHash: second.manifestHash })).status).toBe(200);
    expect(db.state.events.find((e) => e.id === "e-bad")!.reviewStatus).toBe("REVIEWED");
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

// ─────────────────────────────────────────────────────────────────────────────
describe("a shared row is vetoed by ANY exception appearance of it", () => {
  it("does not confirm a cross-document row through its clean appearance", async () => {
    db.state.rows = [makeRow("r-primary", { sourceDocumentId: "doc-primary" }), makeRow("r-copy", { sourceDocumentId: "doc-copy" })];
    db.state.documents = [
      { ...db.state.documents[0], id: "doc-primary", segments: [{ rowIds: ["r-primary", "r-copy"] }] },
      { ...db.state.documents[0], id: "doc-copy", segments: [{ rowIds: ["r-copy"] }] },
    ];
    // The COPY's own card carries a blocking finding; the primary's does not.
    db.state.findings = [
      { id: "f1", scope: "ENTRY", type: "UNSUPPORTED_CLAIM", severity: "BLOCKING", blocking: true, source: "DETERMINISTIC_VALIDATOR", detail: "no supporting excerpt", excerpt: null, field: null, pageStart: null, pageEnd: null, claimIndex: null, status: "OPEN", encounterId: "r-copy", sourceDocumentId: "doc-copy", canonicalNoteId: null, fingerprint: "fp1", sourceFingerprint: null },
    ];
    db.state.events = [];

    const plan = await preview();
    expect(plan.counts).toMatchObject({ eligibleEncounters: 0, skippedEncounters: 1, heldEncounters: 1 });
    expect(plan.heldByReason).toEqual({ ROW_BLOCKED_ELSEWHERE: 1 });

    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    expect(db.state.rows.every((r) => r.status === "AI_AUDIT_PASSED")).toBe(true);
  });

  it("confirms it once every appearance is clean", async () => {
    db.state.rows = [makeRow("r-primary", { sourceDocumentId: "doc-primary" }), makeRow("r-copy", { sourceDocumentId: "doc-copy" })];
    db.state.documents = [
      { ...db.state.documents[0], id: "doc-primary", segments: [{ rowIds: ["r-primary", "r-copy"] }] },
      { ...db.state.documents[0], id: "doc-copy", segments: [{ rowIds: ["r-copy"] }] },
    ];
    db.state.events = [];
    const plan = await preview();
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(200);
    // One decision, both rows, no row named twice.
    expect((await res.json()).rows).toBe(2);
    expect(db.state.rows.every((r) => r.status === "REVIEWED")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("a race between the check and the write changes nothing", () => {
  // The hole this closes: the manifest was recomputed BEFORE the transaction,
  // and the write's own predicate could only test review state. A
  // `ChronologyEvent` has no `updatedAt`, and `scripts/enforce-retention.ts`
  // rewrites `sourceQuote` without touching `reviewStatus` or `edited` — so a
  // quote purged in that window would have been signed as the one displayed.
  //
  // `raceAtLock` fires when the transaction takes its row locks: the last
  // instant a concurrent write could still land.
  const nothingWasWritten = () => {
    expect(db.state.rows.every((r) => r.status === "AI_AUDIT_PASSED")).toBe(true);
    expect(db.state.rows.every((r) => r.reviewedById == null)).toBe(true);
    expect(db.state.events.every((e) => e.reviewStatus === "AI_DRAFT")).toBe(true);
    expect(db.state.audits).toHaveLength(0);
  };

  it("locks the case and the exact rows it is about to write", async () => {
    const plan = await preview();
    expect((await post({ expectedManifestHash: plan.manifestHash })).status).toBe(200);
    expect(db.state.rawCalls.some((q) => /pg_advisory_xact_lock/.test(q))).toBe(true);
    expect(db.state.rawCalls.some((q) => /"ChronologyEvent".*FOR UPDATE/s.test(q))).toBe(true);
    expect(db.state.rawCalls.some((q) => /"ExtractedEncounter".*FOR UPDATE/s.test(q))).toBe(true);
  });

  it("refuses when a chronology sourceQuote is purged after the recheck", async () => {
    const plan = await preview();
    // Exactly what the retention job does: content only, review state
    // untouched — invisible to the write's own predicate.
    db.state.raceAtLock = () => {
      for (const e of db.state.events) e.sourceQuote = null;
    };
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    expect((await res.json()).stale).toBe(true);
    nothingWasWritten();
  });

  it("refuses when a chronology summary is rewritten after the recheck", async () => {
    const plan = await preview();
    db.state.raceAtLock = () => {
      db.state.events[0].summary = "A materially different sentence about this visit.";
    };
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    nothingWasWritten();
  });

  it("refuses when a blocking finding is raised after the recheck", async () => {
    const plan = await preview();
    db.state.raceAtLock = () => {
      db.state.findings.push({
        id: "f-late", scope: "ENTRY", type: "UNSUPPORTED_CLAIM", severity: "BLOCKING", blocking: true,
        source: "DETERMINISTIC_VALIDATOR", detail: "no supporting excerpt", excerpt: null, field: null,
        pageStart: null, pageEnd: null, claimIndex: null, status: "OPEN", encounterId: "b",
        sourceDocumentId: "doc-1", canonicalNoteId: null, fingerprint: "fp-late", sourceFingerprint: null,
      });
    };
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    expect((await res.json()).stale).toBe(true);
    // Not even the two records the late finding does not touch.
    nothingWasWritten();
  });

  it("refuses when the GROUPING changes after the recheck", async () => {
    const plan = await preview();
    db.state.raceAtLock = () => {
      db.state.documents[0].segments = [{ rowIds: ["a", "b", "c"] }];
    };
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    nothingWasWritten();
  });

  it("refuses when a record's own content is corrected after the recheck", async () => {
    const plan = await preview();
    db.state.raceAtLock = () => {
      db.state.rows[0].factualSummary = "Corrected by another reviewer.";
    };
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    nothingWasWritten();
  });

  it("refuses when a record becomes an exception after the recheck", async () => {
    const plan = await preview();
    db.state.raceAtLock = () => {
      db.state.rows[1].auditResult = "FAILED";
    };
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    nothingWasWritten();
  });

  it("refuses when another reviewer decides one of the records first", async () => {
    const plan = await preview();
    db.state.raceAtLock = () => {
      db.state.rows[2].status = "VERIFIED";
    };
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    expect(db.state.rows.filter((r) => r.status === "REVIEWED")).toHaveLength(0);
    expect(db.state.audits).toHaveLength(0);
  });

  it("re-derives the plan INSIDE the transaction, not only before it", async () => {
    // Proof the in-transaction derivation is real: the outer checks all pass
    // (the mutation lands after them), and the request is still refused.
    const plan = await preview();
    let recheckPassed = false;
    db.state.raceAtLock = () => {
      recheckPassed = true;
      db.state.events[0].workStatus = "Off work six weeks.";
    };
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(recheckPassed).toBe(true);
    expect(res.status).toBe(409);
    nothingWasWritten();
  });

  it("still confirms when nothing races", async () => {
    const plan = await preview();
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(200);
    expect(db.state.rows.every((r) => r.status === "REVIEWED")).toBe(true);
    expect(db.state.events.every((e) => e.reviewStatus === "REVIEWED")).toBe(true);
  });

  it("records the content each confirmed chronology entry held", async () => {
    const plan = await preview();
    await post({ expectedManifestHash: plan.manifestHash });
    const meta = db.state.audits[0].meta as { eventContentHashes: { id: string; contentHash: string }[] };
    expect(meta.eventContentHashes.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
    expect(meta.eventContentHashes.every((e) => /^[0-9a-f]{32}$/.test(e.contentHash))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ITEMIZED MANIFEST
//
// The panel used to show counts and a button — "23 canonical encounters and 41
// chronology entries are clean" — and `humanAuthoritative()` then treats every
// row written by that click as something a person read. An aggregate cannot
// establish human authority over items nobody displayed.
// ─────────────────────────────────────────────────────────────────────────────
describe("the reviewer is shown exactly what they are confirming", () => {
  it("returns one manifest line per record, not just a count", async () => {
    const plan = await preview();
    expect(plan.manifestRecords).toHaveLength((plan.counts as Record<string, number>).eligibleEncounters);
    expect(plan.manifestEvents).toHaveLength((plan.counts as Record<string, number>).events);
  });

  it("each line carries the summary and the citation needed to check it", async () => {
    const plan = await preview();
    for (const line of plan.manifestRecords as { documentId: string; filename: string; rows: { summary: string; filename: string; contentHash: string }[] }[]) {
      expect(line.documentId).toBe("doc-1");
      expect(line.filename).toBe("records.pdf");
      // The ASSERTION is per row, because a row is what gets written.
      expect(line.rows.length).toBeGreaterThan(0);
      for (const row of line.rows) {
        expect(typeof row.summary).toBe("string");
        expect(row.summary.length).toBeGreaterThan(0);
        expect(row.filename).toBe("records.pdf");
        expect(row.contentHash.length).toBeGreaterThan(0);
      }
    }
  });

  it("the itemized rows are EXACTLY the rows the write touches", async () => {
    const plan = await preview();
    const listed = (plan.manifestRecords as { rows: { rowId: string }[] }[]).flatMap((r) => r.rows.map((row) => row.rowId)).sort();
    await post({ expectedManifestHash: plan.manifestHash });
    const written = db.state.rows.filter((r) => r.status === "REVIEWED").map((r) => r.id).sort();
    expect(written).toEqual(listed);
  });

  it("the itemized events are EXACTLY the events the write touches", async () => {
    const plan = await preview();
    const listed = (plan.manifestEvents as { eventId: string }[]).map((e) => e.eventId).sort();
    await post({ expectedManifestHash: plan.manifestHash });
    const written = db.state.events.filter((e) => e.reviewStatus === "REVIEWED").map((e) => e.id).sort();
    expect(written).toEqual(listed);
  });

  it("lists nothing, and confirms nothing, when nothing is eligible", async () => {
    db.state.rows = [makeRow("bad", { auditResult: "FAILED" })];
    db.state.documents[0].segments = [{ rowIds: ["bad"] }];
    db.state.events = [];
    const plan = await preview();
    expect(plan.manifestRecords).toEqual([]);
    expect(plan.manifestEvents).toEqual([]);
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).not.toBe(200);
    expect(db.state.rows[0].status).toBe("AI_AUDIT_PASSED");
    expect(db.state.audits).toHaveLength(0);
  });

  it("a stale manifest is refused, and the refusal returns the NEW list", async () => {
    const plan = await preview();
    // A record is corrected between the list being drawn and the click.
    db.state.rows.find((r) => r.id === "b")!.factualSummary = "Corrected after the list was drawn.";
    const res = await post({ expectedManifestHash: plan.manifestHash });
    expect(res.status).toBe(409);
    expect(db.state.rows.every((r) => r.status === "AI_AUDIT_PASSED")).toBe(true);
    expect(db.state.audits).toHaveLength(0);
    // The reviewer can see the corrected line before deciding again.
    const fresh = await preview();
    expect(fresh.manifestHash).not.toBe(plan.manifestHash);
    const correctedRow = (fresh.manifestRecords as { rows: { rowId: string; summary: string }[] }[])
      .flatMap((r) => r.rows)
      .find((row) => row.rowId === "b");
    expect(correctedRow!.summary).toBe("Corrected after the list was drawn.");
  });

  it("requires records.verify to read the manifest at all", async () => {
    tenant.denied = "records.verify";
    const res = await GET(new Request("http://localhost/api"), params);
    expect(res.status).toBe(403);
  });

  it("never lists a record from another case or firm", async () => {
    db.state.rows.push(makeRow("other-case", { caseId: "case-2" }), makeRow("other-firm", { firmId: "firm-2" }));
    const plan = await preview();
    const listedRows = (plan.manifestRecords as { rows: { rowId: string }[] }[]).flatMap((r) => r.rows.map((row) => row.rowId));
    expect(listedRows).not.toContain("other-case");
    expect(listedRows).not.toContain("other-firm");
  });

  it("writes an audit event whose counts match the list that was displayed", async () => {
    const plan = await preview();
    await post({ expectedManifestHash: plan.manifestHash });
    expect(db.state.audits).toHaveLength(1);
    // The audit records the rows and events themselves, so the ledger names
    // exactly what the reviewer was shown rather than a count of it.
    const meta = db.state.audits[0].meta as { rows: { id: string }[]; events: string[] };
    expect(meta.rows.map((r) => r.id).sort()).toEqual(
      (plan.manifestRecords as { rows: { rowId: string }[] }[]).flatMap((r) => r.rows.map((row) => row.rowId)).sort(),
    );
    expect([...meta.events].sort()).toEqual((plan.manifestEvents as { eventId: string }[]).map((e) => e.eventId).sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("a caution is never confirmed by the clean batch", () => {
  it("excludes a cautioned record and confirms only the genuinely clean ones", async () => {
    db.state.rows = [makeRow("clean"), makeRow("caution", { auditResult: "EXTRACTION_INCOMPLETE" })];
    db.state.documents[0].segments = [{ rowIds: ["clean"] }, { rowIds: ["caution"] }];
    db.state.events = [];
    const plan = await preview();
    expect((plan.counts as Record<string, number>).cautionEncounters).toBe(1);
    expect((plan.manifestRecords as { rows: { rowId: string }[] }[]).flatMap((r) => r.rows.map((row) => row.rowId))).toEqual(["clean"]);
    await post({ expectedManifestHash: plan.manifestHash });
    expect(db.state.rows.find((r) => r.id === "clean")!.status).toBe("REVIEWED");
    // The cautioned record keeps its machine state: nobody has read it.
    expect(db.state.rows.find((r) => r.id === "caution")!.status).toBe("AI_AUDIT_PASSED");
  });

  it("holds a chronology entry built from a cautioned record", async () => {
    db.state.rows = [makeRow("clean"), makeRow("caution", { auditResult: "EXTRACTION_INCOMPLETE" })];
    db.state.documents[0].segments = [{ rowIds: ["clean"] }, { rowIds: ["caution"] }];
    db.state.events = [makeEvent("e-caution", { sourceRowIds: ["caution"] })];
    const plan = await preview();
    expect((plan.counts as Record<string, number>).events).toBe(0);
    await post({ expectedManifestHash: plan.manifestHash });
    expect(db.state.events[0].reviewStatus).toBe("AI_DRAFT");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A CAUTION IS WORK, BUT IT IS NOT AN EXCEPTION
//
// Cautions were pushed into `reasons`, so they landed in `skippedEncounters`
// and `skippedByReason`. The panel then reported the same records twice — "N
// cautions" and "N exceptions" — and the zero-eligible state called them
// exceptions outright, inflating the apparent review burden by exactly the
// number of cautions.
// ─────────────────────────────────────────────────────────────────────────────
describe("cautions are reported apart from exceptions", () => {
  const withCaution = () => {
    db.state.rows = [makeRow("clean"), makeRow("caution", { auditResult: "EXTRACTION_INCOMPLETE" })];
    db.state.documents[0].segments = [{ rowIds: ["clean"] }, { rowIds: ["caution"] }];
    db.state.events = [];
  };

  it("does not count a caution among the exceptions", async () => {
    withCaution();
    const plan = await preview();
    const counts = plan.counts as Record<string, number>;
    expect(counts.cautionEncounters).toBe(1);
    // The number that was double-counted.
    expect(counts.skippedEncounters).toBe(0);
    expect(plan.skippedByReason).toEqual({});
  });

  it("reports the caution on its own channel, with its own requirement", async () => {
    withCaution();
    const plan = await preview();
    expect(plan.cautionsByReason).toEqual({ DOCUMENT_INCOMPLETE: 1 });
    expect(plan.cautionsByKind).toEqual({ DOCUMENT_INCOMPLETE: 1 });
  });

  it("still excludes the caution from the clean batch", async () => {
    withCaution();
    const plan = await preview();
    await post({ expectedManifestHash: plan.manifestHash });
    expect(db.state.rows.find((r) => r.id === "clean")!.status).toBe("REVIEWED");
    expect(db.state.rows.find((r) => r.id === "caution")!.status).toBe("AI_AUDIT_PASSED");
  });

  it("records the split in the audit, so a ledger reader is not misled either", async () => {
    withCaution();
    const plan = await preview();
    await post({ expectedManifestHash: plan.manifestHash });
    const meta = db.state.audits[0].meta as Record<string, unknown>;
    expect(meta.cautionEncounters).toBe(1);
    expect(meta.cautionsByReason).toEqual({ DOCUMENT_INCOMPLETE: 1 });
    expect(meta.skippedEncounters).toBe(0);
    expect(meta.skippedByReason).toEqual({});
  });

  it("keeps a true exception counted as an exception", async () => {
    db.state.rows = [makeRow("clean"), makeRow("bad", { auditResult: "FAILED" })];
    db.state.documents[0].segments = [{ rowIds: ["clean"] }, { rowIds: ["bad"] }];
    db.state.events = [];
    const plan = await preview();
    const counts = plan.counts as Record<string, number>;
    expect(counts.skippedEncounters).toBe(1);
    expect(counts.cautionEncounters).toBe(0);
  });

  it("counts a record carrying BOTH as an exception, once, not twice", async () => {
    // An exception outranks a caution: it is the stronger statement, and
    // reporting the record under both headings is the inflation being removed.
    db.state.rows = [makeRow("both", { auditResult: "FAILED" }), makeRow("clean")];
    db.state.documents[0].segments = [{ rowIds: ["both"] }, { rowIds: ["clean"] }];
    db.state.events = [];
    const plan = await preview();
    const counts = plan.counts as Record<string, number>;
    expect(counts.skippedEncounters + counts.cautionEncounters).toBe(1);
  });

  it("no click on this endpoint can mark a cautioned record reviewed", async () => {
    withCaution();
    const plan = await preview();
    // The cautioned record appears nowhere in the manifest, so the aggregate
    // action cannot reach it at all. The only path to it is the per-document
    // surface, which shows its own requirement, its source page and its own
    // review action — see the caution-bucket assertions in
    // src/components/accessibility.test.ts.
    const listed = (plan.manifestRecords as { rows: { rowId: string }[] }[]).flatMap((r) => r.rows.map((x) => x.rowId));
    expect(listed).not.toContain("caution");
    expect(plan.rowIds ?? []).not.toContain("caution");
    await post({ expectedManifestHash: plan.manifestHash });
    expect(db.state.rows.find((r) => r.id === "caution")!.status).toBe("AI_AUDIT_PASSED");
    expect(db.state.rows.find((r) => r.id === "caution")!.reviewedById ?? null).toBeNull();
  });
});
