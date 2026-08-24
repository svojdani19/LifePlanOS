// ─────────────────────────────────────────────────────────────────────────────
// The final factual-review gate, traced end to end.
//
// The defect: the gate asked one question of every current row — "did the
// machine's audit pass?" — and asked it of rows the machine no longer owned.
// An entry that failed extraction, was corrected by a reviewer and signed went
// on blocking a final export for ever, citing a failure that had already been
// fixed. The only escape was to reject corrected work.
//
// The correction must hold in BOTH directions, which is what these test:
//
//   • a corrected exception CAN clear the old machine grade — but only when no
//     live disagreement, drift or unresolved finding remains;
//   • an untouched machine draft with a failed or missing audit can NEVER pass,
//     and neither can a human status pasted over a live contradiction.
//
// And the gate must still be reachable: after the one human confirmation, a
// case whose exceptions have been resolved actually exports.
//
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => {
  const state = {
    rows: [] as Record<string, unknown>[],
    documents: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
    findings: [] as Record<string, unknown>[],
    pages: [] as Record<string, unknown>[],
    extractions: [] as Record<string, unknown>[],
  };
  const current = (r: Record<string, unknown>) =>
    ["AI_DRAFT", "AI_AUDIT_PASSED", "HUMAN_EDITED", "REVIEWED", "VERIFIED"].includes(r.status as string) && r.supersededById == null;
  const prisma = {
    document: { findMany: async () => state.documents.map((d) => ({ ...d })) },
    recordExtraction: { findMany: async () => state.extractions.map((e) => ({ ...e })) },
    extractedEncounter: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const wantsReviewScope = Array.isArray((where.status as { in?: string[] })?.in) && ((where.status as { in: string[] }).in ?? []).includes("STALE");
        return state.rows
          .filter((r) => (wantsReviewScope ? r.supersededById == null : current(r)))
          .map((r) => ({ ...r }));
      },
      count: async ({ where }: { where: Record<string, unknown> }) => {
        const wanted = (where.status as { in?: string[] })?.in ?? [];
        return state.rows.filter((r) => wanted.includes(r.status as string) && r.supersededById == null).length;
      },
    },
    chronologyEvent: { findMany: async () => state.events.map((e) => ({ ...e })) },
    sourcePage: { findMany: async () => state.pages.map((p) => ({ ...p })) },
    recordFinding: { findMany: async () => state.findings.map((f) => ({ ...f })) },
  };
  return { state, prisma };
});

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));

import { factualReviewState } from "@/lib/records/structuredRecord";

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  caseId: "case-1",
  firmId: "firm-1",
  sourceDocumentId: "doc-1",
  status: "REVIEWED",
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
  claims: [{ field: "assessment", value: `Lumbar radiculopathy documented for ${id}`, excerpt: "…", page: 1 }],
  page: 1,
  pageEnd: 1,
  ocrConfidence: 0.98,
  warnings: [],
  reviewedAt: new Date("2026-08-20T00:00:00Z"),
  verifiedAt: null,
  reviewedById: "reviewer-1",
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

const doc = { id: "doc-1", caseId: "case-1", firmId: "firm-1", filename: "records.pdf", type: "MEDICAL_RECORD", pageCount: 10, serviceDate: null, serviceDateEnd: null, ocrConfidence: 0.98, flags: null, createdAt: new Date("2026-07-01T00:00:00Z"), segments: [{ rowIds: ["a"] }] };

const gate = () => factualReviewState("case-1", "firm-1");
const mentions = (blockers: string[], re: RegExp) => blockers.some((b) => re.test(b));

beforeEach(() => {
  db.state.rows = [row("a")];
  db.state.documents = [{ ...doc }];
  db.state.events = [{ id: "e1", reviewStatus: "REVIEWED", edited: false }];
  db.state.findings = [];
  db.state.pages = [];
  db.state.extractions = [];
});

// ─────────────────────────────────────────────────────────────────────────────
describe("a corrected exception stops blocking the export", () => {
  it("passes when a reviewer corrected and signed a record the extraction failed on", async () => {
    // The trace: AI_DRAFT → audit FAILED → reviewer corrects it (HUMAN_EDITED,
    // editedFields recorded) → reviewer signs it (REVIEWED). The grade stays
    // stored as history; it is no longer the current verdict.
    db.state.rows = [row("a", { status: "REVIEWED", auditResult: "FAILED", editedFields: ["factualSummary"] })];
    const { complete, blockers } = await gate();
    expect(mentions(blockers, /ended the factual audit/)).toBe(false);
    expect(complete).toBe(true);
  });

  it("passes when a reviewer corrected the very field the source contradicted", async () => {
    // The card's own instruction is "open the cited page and set the date from
    // what the record actually says". Nothing read that back, so the record
    // stayed conflicted for ever and the instruction was a dead end.
    db.state.rows = [row("a", { status: "HUMAN_EDITED", contradictedFields: ["date"], editedFields: ["encounterDate"] })];
    const { complete, blockers } = await gate();
    expect(mentions(blockers, /the source contradicts/)).toBe(false);
    expect(complete).toBe(true);
  });

  it("passes for a human-reviewed record whose audit merely wanted a second pair of eyes", async () => {
    db.state.rows = [row("a", { status: "REVIEWED", auditResult: "NEEDS_HUMAN_REVIEW" })];
    expect((await gate()).complete).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("an untouched machine draft can never pass", () => {
  it("blocks a draft whose audit failed", async () => {
    db.state.rows = [row("a", { status: "AI_DRAFT", auditResult: "FAILED", reviewedAt: null, reviewedById: null })];
    const { complete, blockers } = await gate();
    expect(mentions(blockers, /ended the factual audit as failed/)).toBe(true);
    expect(complete).toBe(false);
  });

  it("blocks a draft that was never audited at all", async () => {
    db.state.rows = [row("a", { status: "AI_AUDIT_PASSED", auditResult: null, reviewedAt: null, reviewedById: null })];
    const { complete, blockers } = await gate();
    expect(mentions(blockers, /have not completed the factual audit/)).toBe(true);
    expect(complete).toBe(false);
  });

  it("blocks an audit-passed draft nobody has reviewed", async () => {
    db.state.rows = [row("a", { status: "AI_AUDIT_PASSED", reviewedAt: null, reviewedById: null })];
    const { complete, blockers } = await gate();
    expect(mentions(blockers, /pending human review/)).toBe(true);
    expect(complete).toBe(false);
  });

  it("does not let a human status paper over a LIVE disagreement", async () => {
    // A dispute nobody settled is still unsettled however the row is labelled.
    db.state.rows = [row("a", { status: "VERIFIED", unresolvedDisputes: 2, verifiedContentHash: "x" })];
    const { complete, blockers } = await gate();
    expect(mentions(blockers, /unresolved extraction disagreement/)).toBe(true);
    expect(complete).toBe(false);
  });

  it("does not let a human status paper over a contradiction nobody corrected", async () => {
    // Reviewed, but the corrected field is a DIFFERENT one from the contradicted one.
    db.state.rows = [row("a", { status: "REVIEWED", contradictedFields: ["date"], editedFields: ["facility"] })];
    const { complete, blockers } = await gate();
    expect(mentions(blockers, /field the source contradicts/)).toBe(true);
    expect(complete).toBe(false);
  });

  it("still blocks verified content that changed after it was verified", async () => {
    db.state.rows = [row("a", { status: "VERIFIED", verifiedAt: new Date("2026-08-20T00:00:00Z"), verifiedContentHash: "stale-hash" })];
    const { complete, blockers } = await gate();
    expect(mentions(blockers, /re-verified/)).toBe(true);
    expect(complete).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("scoped blockers stand at their own scope, once", () => {
  it("blocks on an unresolved document finding however many clean records sit inside it", async () => {
    db.state.rows = [row("a"), row("b"), row("c")];
    db.state.documents[0].segments = [{ rowIds: ["a"] }, { rowIds: ["b"] }, { rowIds: ["c"] }];
    db.state.findings = [
      { id: "f1", fingerprint: "fp-doc", scope: "DOCUMENT", type: "MISSING_ENCOUNTER", status: "OPEN", blocking: true, severity: "BLOCKING", source: "PAGE_LEDGER", detail: "a dated note produced no entry", sourceDocumentId: "doc-1", canonicalNoteId: null, encounterId: null, excerpt: null, field: null, pageStart: null, pageEnd: null, claimIndex: null, sourceFingerprint: null },
    ];
    const { complete, blockers } = await gate();
    expect(complete).toBe(false);
    // Once, at DOCUMENT scope — never once per record inside it.
    expect(blockers.filter((b) => /document-level finding/.test(b))).toHaveLength(1);
    expect(blockers.filter((b) => /document-level finding/.test(b))[0]).toMatch(/^1 unresolved/);
  });

  it("blocks on an unreadable page, and on a coverage gap", async () => {
    db.state.pages = [{ status: "UNREADABLE" }];
    expect(mentions((await gate()).blockers, /source page\(s\) are unreadable/)).toBe(true);

    db.state.pages = [];
    db.state.extractions = [{ sourceDocumentId: "doc-1", coverageGaps: 2, status: "COMPLETE", createdAt: new Date("2026-07-02T00:00:00Z"), warnings: [], truncated: false, model: "m", promptVersion: "v", error: null }];
    expect(mentions((await gate()).blockers, /produced no extracted encounter/)).toBe(true);
  });

  it("blocks while a chronology draft is unreviewed, and passes once it is", async () => {
    db.state.events = [{ id: "e1", reviewStatus: "AI_DRAFT", edited: false }];
    expect(mentions((await gate()).blockers, /chronology event\(s\) are unreviewed AI drafts/)).toBe(true);
    db.state.events = [{ id: "e1", reviewStatus: "REVIEWED", edited: false }];
    expect((await gate()).complete).toBe(true);
  });

  it("blocks while stale human work waits for re-review", async () => {
    db.state.rows = [row("a"), row("stale", { status: "STALE", staleReason: "the source changed" })];
    db.state.documents[0].segments = [{ rowIds: ["a"] }, { rowIds: ["stale"] }];
    const { complete, blockers } = await gate();
    expect(mentions(blockers, /stale after source changes/)).toBe(true);
    expect(complete).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the gate is actually reachable", () => {
  it("passes for a case whose clean records and chronology were confirmed and whose exceptions were resolved", async () => {
    // Exactly the end state the batch confirmation produces: every current row
    // REVIEWED by a person, every chronology draft REVIEWED, nothing open.
    db.state.rows = [row("a"), row("b"), row("c")];
    db.state.documents[0].segments = [{ rowIds: ["a"] }, { rowIds: ["b"] }, { rowIds: ["c"] }];
    db.state.events = [
      { id: "e1", reviewStatus: "REVIEWED", edited: false },
      { id: "e2", reviewStatus: "REVIEWED", edited: false },
    ];
    const { complete, blockers } = await gate();
    expect(blockers).toEqual([]);
    expect(complete).toBe(true);
  });

  it("still fails while ONE unresolved exception remains beside the confirmed set", async () => {
    db.state.rows = [row("a"), row("b"), row("bad", { status: "AI_DRAFT", auditResult: "FAILED", reviewedAt: null, reviewedById: null })];
    db.state.documents[0].segments = [{ rowIds: ["a"] }, { rowIds: ["b"] }, { rowIds: ["bad"] }];
    const { complete } = await gate();
    expect(complete).toBe(false);
  });
});
