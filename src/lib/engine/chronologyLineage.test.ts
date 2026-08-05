// buildChronologyFromRecords — review lineage and the no-template guarantee.
//   • Zero extractable events NEVER creates specialty-template chronology; an
//     explicit review finding is raised instead (handleEmptyChronology).
//   • Regeneration preserves human-edited/reviewed/verified events; source
//     changes mark them STALE; only AI drafts are replaced.
//   • Extracted encounters with UNKNOWN dates never enter the dated timeline.
// Synthetic records only.
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => {
  const state = {
    caseRow: {} as Record<string, unknown>,
    docs: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
    extractionRuns: [] as Record<string, unknown>[],
    extractedEncounters: [] as Record<string, unknown>[],
    attentionItems: [] as Record<string, unknown>[],
    created: [] as Record<string, unknown>[],
    deletedWhere: [] as Record<string, unknown>[],
    reset() {
      state.caseRow = {
        id: "case-1",
        firmId: "firm-1",
        diagnosis: "Lumbar radiculopathy",
        clientName: "Synthetic Client",
        dateOfInjury: new Date("2025-01-10T00:00:00Z"),
        createdAt: new Date("2025-02-01T00:00:00Z"),
      };
      state.docs = [];
      state.events = [];
      state.extractionRuns = [];
      state.extractedEncounters = [];
      state.attentionItems = [];
      state.created = [];
      state.deletedWhere = [];
    },
  };
  const prisma = {
    case: { findUniqueOrThrow: async () => state.caseRow },
    document: { findMany: async () => state.docs },
    condition: { findMany: async () => [] },
    futureCareItem: { findMany: async () => [] },
    recordExtraction: { findMany: async () => state.extractionRuns },
    extractedEncounter: { findMany: async () => state.extractedEncounters },
    chronologyEvent: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.OR) {
          return state.events.filter(
            (e) => e.edited === true || ["HUMAN_EDITED", "REVIEWED", "VERIFIED", "STALE"].includes(e.reviewStatus as string),
          );
        }
        return state.events;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.events.find((e) => e.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        state.deletedWhere.push(where);
        return { count: 0 };
      },
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        state.created.push(...data);
        return { count: data.length };
      },
    },
    attentionItem: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.attentionItems.push(data);
        return { id: "att-1", ...data };
      },
    },
    $transaction: async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
  };
  return { ...state, prisma, state };
});

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));

import { buildChronologyFromRecords, handleEmptyChronology } from "./chronology";

const CLINICAL_DOC = {
  id: "doc-1",
  caseId: "case-1",
  firmId: "firm-1",
  type: "PROGRESS_NOTE",
  filename: "synthetic-note.pdf",
  flags: "",
  serviceDate: null,
  serviceDateEnd: null,
  extractedText: [
    "DATE OF SERVICE: 03/14/2025",
    "Provider: Dana Rivers, MD",
    "Subjective: Persistent low back pain radiating to the left leg.",
    "Assessment: Lumbar radiculopathy.",
    "Plan: Continue physical therapy twice weekly.",
  ].join("\n"),
};

beforeEach(() => db.state.reset());

describe("no template fallback (spec: zero events never fabricates a timeline)", () => {
  it("an undatable document produces ZERO events — the timeline stays empty", async () => {
    db.state.docs = [
      { ...CLINICAL_DOC, extractedText: "Illegible scan fragment with no service date and no dated content whatsoever." },
    ];
    const r = await buildChronologyFromRecords("case-1");
    expect(r.kept).toBe(0);
    expect(db.state.created).toHaveLength(0); // nothing invented
  });

  it("handleEmptyChronology raises a review finding instead of template events", async () => {
    await handleEmptyChronology("case-1");
    expect(db.state.attentionItems).toHaveLength(1);
    const item = db.state.attentionItems[0];
    expect(item.validationRuleId).toBe("chronology.empty");
    expect(String(item.summary)).toMatch(/left empty rather than filled with template content/);
    expect(db.state.created).toHaveLength(0);
  });
});

describe("regeneration preserves human work", () => {
  const humanEvent = (over: Record<string, unknown> = {}) => ({
    id: "ev-human",
    caseId: "case-1",
    eventDate: new Date("2025-03-14T00:00:00Z"),
    provider: "Dana Rivers, MD",
    sourceDocumentId: "doc-1",
    edited: false,
    reviewStatus: "VERIFIED",
    sourceFingerprint: "original-fingerprint",
    ...over,
  });

  it("verified events are never deleted; only AI drafts are cleared and re-created", async () => {
    db.state.docs = [CLINICAL_DOC];
    db.state.events = [humanEvent()];
    await buildChronologyFromRecords("case-1");
    // The delete targets ONLY unedited AI drafts / superseded rows.
    expect(db.state.deletedWhere[0]).toMatchObject({ edited: false, reviewStatus: { in: ["AI_DRAFT", "SUPERSEDED"] } });
    // No duplicate draft is created for the encounter the human row covers.
    const dupes = db.state.created.filter(
      (r) => (r.eventDate as Date).toISOString().slice(0, 10) === "2025-03-14" && r.sourceDocumentId === "doc-1",
    );
    expect(dupes).toHaveLength(0);
  });

  it("a changed source document marks the reviewed event STALE (verification never carries over)", async () => {
    db.state.docs = [CLINICAL_DOC];
    db.state.events = [humanEvent()]; // fingerprint no longer matches the doc text
    await buildChronologyFromRecords("case-1");
    expect(db.state.events[0].reviewStatus).toBe("STALE");
    expect(String(db.state.events[0].staleReason)).toMatch(/re-review required/);
  });

  it("fresh AI drafts enter as UNCLEAR relatedness AI_DRAFT rows with real source pages (never page-1 defaults)", async () => {
    db.state.docs = [CLINICAL_DOC];
    await buildChronologyFromRecords("case-1");
    expect(db.state.created.length).toBeGreaterThan(0);
    for (const r of db.state.created) {
      expect(r.relatedness).toBe("UNCLEAR"); // relatedness is a human/gated judgment
      expect(r.reviewStatus).toBe("AI_DRAFT");
      expect(r.sourcePage === null || typeof r.sourcePage === "number").toBe(true);
    }
  });
});

describe("extracted encounters drive the timeline when extraction is COMPLETE", () => {
  it("uses validated encounters; UNKNOWN-date encounters stay OFF the dated timeline", async () => {
    db.state.docs = [CLINICAL_DOC];
    db.state.extractionRuns = [{ id: "run-1", sourceDocumentId: "doc-1" }];
    db.state.extractedEncounters = [
      {
        id: "enc-1",
        sourceDocumentId: "doc-1",
        status: "AI_DRAFT",
        dateStatus: "DOCUMENTED",
        encounterDate: new Date("2025-03-14T00:00:00Z"),
        encounterDateEnd: null,
        provider: "Dana Rivers, MD",
        providerCredentials: "MD",
        facility: null,
        encounterType: "Clinic visit",
        factualSummary: "Clinic visit — Assessment: Lumbar radiculopathy. Treatment: Continue physical therapy twice weekly.",
        claims: [
          { field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy.", page: 2, confidence: 0.95 },
        ],
        page: 2,
        pageEnd: 2,
      },
      {
        id: "enc-undated",
        sourceDocumentId: "doc-1",
        status: "AI_DRAFT",
        dateStatus: "UNKNOWN",
        encounterDate: null,
        encounterDateEnd: null,
        provider: null,
        providerCredentials: null,
        facility: null,
        encounterType: null,
        factualSummary: "Undated fragment.",
        claims: [],
        page: null,
        pageEnd: null,
      },
    ];
    await buildChronologyFromRecords("case-1");
    expect(db.state.created).toHaveLength(1);
    const row = db.state.created[0];
    expect(row.summary).toMatch(/^Clinic visit — Assessment/); // the FACTUAL summary leads
    expect(row.sourcePage).toBe(2);
    expect((row.eventDate as Date).toISOString().slice(0, 10)).toBe("2025-03-14");
  });
});

describe("one real-world encounter = one chronology entry", () => {
  const enc = (over: Record<string, unknown>) => ({
    id: `e${Math.round(Number(over.n ?? 0))}`,
    sourceDocumentId: "doc-1",
    status: "AI_DRAFT",
    dateStatus: "DOCUMENTED",
    encounterDate: new Date("2023-05-29T00:00:00Z"),
    encounterDateEnd: null,
    provider: null,
    providerCredentials: null,
    facility: null,
    encounterType: "Emergency Department",
    factualSummary: "Emergency Department — Contusions.",
    claims: [],
    page: 1,
    pageEnd: 1,
    ...over,
  });

  beforeEach(() => {
    db.state.docs = [CLINICAL_DOC];
    db.state.extractionRuns = [{ id: "run-1", sourceDocumentId: "doc-1" }];
  });

  it("merges the same ER visit documented in a billing record and a chart record", () => {
    // Same day, same event type, provider spelled two ways + one unnamed copy.
    db.state.extractedEncounters = [
      enc({ n: 1, provider: "Paul English, MD", factualSummary: "Emergency Department — Contusions." }),
      enc({ n: 2, provider: "ENGLISH, PAUL W", encounterType: "Emergency", factualSummary: "Emergency — Contusion of left knee." }),
      enc({ n: 3, provider: null, encounterType: "Emergency", factualSummary: "Emergency — Patient taken to X-ray." }),
    ];
    return buildChronologyFromRecords("case-1").then(() => {
      expect(db.state.created).toHaveLength(1);
      expect(db.state.created[0].provider).toMatch(/English/i);
    });
  });

  it("keeps two genuinely different clinicians on the same day distinct", () => {
    db.state.extractedEncounters = [
      enc({ n: 1, provider: "Paul English, MD" }),
      enc({ n: 2, provider: "Alexis Chen, MD" }),
    ];
    return buildChronologyFromRecords("case-1").then(() => {
      expect(db.state.created).toHaveLength(2);
    });
  });
});
