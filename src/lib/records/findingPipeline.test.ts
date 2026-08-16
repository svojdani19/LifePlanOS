// ─────────────────────────────────────────────────────────────────────────────
// The whole path a finding travels, end to end:
//
//   audit derives it → extraction persists it → the records query routes it to
//   the one scope it names → a reviewer answers it → the export gate reflects
//   the answer.
//
// Every link in that chain existed and the chain did not: the audit's scoped
// findings were computed and written nowhere, and the query that would have
// read them omitted the two target columns its own routing depended on, so
// the routing map was empty on every request. A case could carry blocking
// findings that no screen showed and no action could close.
//
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { auditFactualRecord, type AuditEncounter } from "@/lib/llm/factualAudit";
import { writeFindings, findingFingerprint, distinctOpen, type FindingDraft } from "@/lib/records/recordFindings";
import { routeScopedFindings, type RecordFindingView } from "@/lib/records/structuredRecord";
import { projectNotes } from "@/lib/records/noteProjection";

interface Row {
  id: string;
  fingerprint: string;
  caseId: string;
  firmId: string;
  scope: string;
  type: string;
  blocking: boolean;
  source: string;
  status: string;
  detail: string;
  sourceDocumentId: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  encounterId: string | null;
  canonicalNoteId: string | null;
  sourceFingerprint: string | null;
  [k: string]: unknown;
}

/** The two Prisma calls writeFindings makes, over an in-memory table. */
function makeStore() {
  const rows: Row[] = [];
  return {
    rows,
    recordFinding: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const wanted = (where.fingerprint as { in?: string[] })?.in;
        return rows.filter((r) => (!wanted || wanted.includes(r.fingerprint)) && (!where.caseId || r.caseId === where.caseId));
      },
      upsert: async ({ where, update, create }: { where: { caseId_fingerprint: { fingerprint: string } }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
        const hit = rows.find((r) => r.fingerprint === where.caseId_fingerprint.fingerprint);
        if (hit) Object.assign(hit, update);
        else rows.push({ id: `f${rows.length + 1}`, status: "OPEN", ...(create as unknown as Omit<Row, "id" | "status">) } as Row);
        return {};
      },
      updateMany: async () => ({ count: 0 }),
    },
  };
}

const encounter = (over: Partial<AuditEncounter> = {}): AuditEncounter => ({
  id: "0",
  sourceDocumentId: "doc-1",
  dateStatus: "DOCUMENTED",
  encounterDate: "2025-03-14",
  provider: "A. Rivera, MD",
  encounterType: "Clinic visit",
  factualSummary: "Clinic visit for lumbar radiculopathy.",
  claims: [{ field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: 1 }],
  page: 1,
  status: "AI_DRAFT",
  ...over,
});

/**
 * Persist an audit outcome the way the extraction path does: entry findings
 * resolved to real row ids, everything else at the scope it names.
 */
async function persistAudit(
  store: ReturnType<typeof makeStore>,
  outcome: ReturnType<typeof auditFactualRecord>,
  rowIdByIndex: Map<number, string>,
  sourceFingerprint = "sha-1",
) {
  const drafts: FindingDraft[] = [];
  for (const f of outcome.scoped) {
    const rowId = f.encounterIndex != null ? rowIdByIndex.get(f.encounterIndex) : undefined;
    if (f.encounterIndex != null && !rowId) continue;
    drafts.push({
      firmId: "firm-1",
      caseId: "case-1",
      scope: f.scope,
      type: f.type,
      blocking: f.blocking,
      source: "DETERMINISTIC_VALIDATOR",
      sourceDocumentId: f.scope === "CASE" ? null : "doc-1",
      pageStart: f.pageStart ?? null,
      pageEnd: f.pageEnd ?? null,
      encounterId: rowId ?? null,
      claimIndex: f.claimIndex ?? null,
      field: f.field ?? null,
      detail: f.detail,
      sourceFingerprint,
    });
  }
  await writeFindings(store, drafts);
  return drafts;
}

const asViews = (rows: Row[]): RecordFindingView[] => rows as unknown as RecordFindingView[];

describe("an audit's conclusions reach the review surface", () => {
  it("persists a document finding and routes it to its document, not to its notes", async () => {
    const store = makeStore();
    const outcome = auditFactualRecord({
      encounters: [encounter(), encounter({ id: "1", factualSummary: "Follow-up visit." })],
      pages: [{ pageNumber: 1, status: "READABLE", ocrConfidence: 0.98 }],
      failedExtractions: 0,
      coverageGaps: 2, // two dated headers produced no entry
      unresolvedDisputes: 0,
      allDocumentsProcessed: true,
    });
    await persistAudit(store, outcome, new Map([[0, "row-a"], [1, "row-b"]]));

    const missing = store.rows.filter((r) => r.type === "MISSING_ENCOUNTER");
    expect(missing).toHaveLength(1);
    expect(missing[0].scope).toBe("DOCUMENT");
    expect(missing[0].blocking).toBe(true);

    const routed = routeScopedFindings(asViews(store.rows), new Map());
    expect(routed.documentFindings.get("doc-1")).toHaveLength(1);
    // The two sound entries are NOT tarred with it.
    expect(routed.findingsByDoc.get("doc-1") ?? []).toHaveLength(0);
  });

  it("routes a page finding to its document's page section, once per page", async () => {
    const store = makeStore();
    const outcome = auditFactualRecord({
      encounters: [encounter()],
      pages: [
        { pageNumber: 1, status: "READABLE", ocrConfidence: 0.98 },
        { pageNumber: 7, status: "UNREADABLE", ocrConfidence: null },
        { pageNumber: 9, status: "UNREADABLE", ocrConfidence: null },
      ],
      failedExtractions: 0,
      unresolvedDisputes: 0,
      allDocumentsProcessed: true,
    });
    await persistAudit(store, outcome, new Map([[0, "row-a"]]));

    const routed = routeScopedFindings(asViews(store.rows), new Map());
    const pages = routed.pageFindings.get("doc-1") ?? [];
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.pageStart).sort()).toEqual([7, 9]);
    expect(routed.caseFindings).toHaveLength(0);
  });

  it("routes a case finding to case scope, where a document cannot hide it", async () => {
    const store = makeStore();
    const outcome = auditFactualRecord({
      encounters: [encounter()],
      pages: [{ pageNumber: 1, status: "READABLE", ocrConfidence: 0.98 }],
      failedExtractions: 0,
      unresolvedDisputes: 0,
      allDocumentsProcessed: false, // a sibling document is still processing
    });
    await persistAudit(store, outcome, new Map([[0, "row-a"]]));

    const routed = routeScopedFindings(asViews(store.rows), new Map());
    expect(routed.caseFindings.some((f) => f.type === "DOCUMENTS_STILL_PROCESSING" && f.blocking)).toBe(true);
    expect(routed.documentFindings.get("doc-1") ?? []).toHaveLength(0);
  });

  it("carries an entry finding all the way onto the note that owns the entry", async () => {
    const store = makeStore();
    const outcome = auditFactualRecord({
      encounters: [encounter({ contradictedFields: ["date"] }), encounter({ id: "1", factualSummary: "Follow-up visit." })],
      pages: [{ pageNumber: 1, status: "READABLE", ocrConfidence: 0.98 }],
      failedExtractions: 0,
      unresolvedDisputes: 0,
      allDocumentsProcessed: true,
    });
    await persistAudit(store, outcome, new Map([[0, "row-a"], [1, "row-b"]]));

    const routed = routeScopedFindings(asViews(store.rows), new Map());
    const forDoc = routed.findingsByDoc.get("doc-1") ?? [];
    expect(forDoc.length).toBeGreaterThan(0);

    // Two rows, two notes: only the note holding row-a is an exception.
    const rows = [
      { id: "row-a", sourceDocumentId: "doc-1", status: "AI_DRAFT", dateStatus: "DOCUMENTED", encounterDate: "2025-03-14", claims: [], contentHash: "h1" },
      { id: "row-b", sourceDocumentId: "doc-1", status: "AI_DRAFT", dateStatus: "DOCUMENTED", encounterDate: "2025-03-20", claims: [], contentHash: "h2" },
    ];
    const notes = projectNotes("doc-1", [{ rowIds: ["row-a"] }, { rowIds: ["row-b"] }], rows as never, forDoc as never);
    const flagged = notes.filter((n) => n.findings.length > 0);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].rowIds).toEqual(["row-a"]);
  });

  it("never drops a finding it cannot place precisely — it surfaces at case scope", () => {
    // An unplaceable finding that vanished would still block a final export,
    // with nothing on screen to explain why.
    const orphan: RecordFindingView = {
      id: "f-orphan", scope: "DOCUMENT", type: "SOURCE_CLIPPED", severity: "BLOCKING", blocking: true,
      source: "DETERMINISTIC_VALIDATOR", detail: "Clipped.", status: "OPEN", sourceDocumentId: null,
    };
    const routed = routeScopedFindings([orphan], new Map());
    expect(routed.caseFindings).toHaveLength(1);
  });
});

describe("what the export gate counts", () => {
  it("counts one document-level problem once, however many entries sit near it", async () => {
    const store = makeStore();
    const outcome = auditFactualRecord({
      encounters: Array.from({ length: 40 }, (_, i) => encounter({ id: String(i), factualSummary: `Visit ${i}.` })),
      pages: [{ pageNumber: 1, status: "READABLE", ocrConfidence: 0.98 }],
      failedExtractions: 0,
      coverageGaps: 3,
      unresolvedDisputes: 0,
      allDocumentsProcessed: true,
    });
    await persistAudit(store, outcome, new Map(Array.from({ length: 40 }, (_, i) => [i, `row-${i}`])));
    const blocking = distinctOpen(store.rows.filter((r) => r.blocking));
    expect(blocking.filter((f) => f.type === "MISSING_ENCOUNTER")).toHaveLength(1);
  });

  it("stops counting a finding once a reviewer answers it, and no sooner", async () => {
    const store = makeStore();
    const outcome = auditFactualRecord({
      encounters: [encounter()],
      pages: [{ pageNumber: 1, status: "READABLE", ocrConfidence: 0.98 }],
      failedExtractions: 0,
      coverageGaps: 1,
      unresolvedDisputes: 0,
      allDocumentsProcessed: true,
    });
    await persistAudit(store, outcome, new Map([[0, "row-a"]]));
    const target = store.rows.find((r) => r.type === "MISSING_ENCOUNTER")!;
    expect(distinctOpen(store.rows).some((f) => f.fingerprint === target.fingerprint)).toBe(true);

    // The disposition an authorized reviewer records.
    target.status = "RESOLVED";
    target.dispositionSourceFingerprint = "sha-1";
    expect(distinctOpen(store.rows).some((f) => f.fingerprint === target.fingerprint)).toBe(false);
  });

  it("reopens that answer when the source it was given over changes", async () => {
    const store = makeStore();
    const outcome = auditFactualRecord({
      encounters: [encounter()],
      pages: [{ pageNumber: 1, status: "READABLE", ocrConfidence: 0.98 }],
      failedExtractions: 0,
      coverageGaps: 1,
      unresolvedDisputes: 0,
      allDocumentsProcessed: true,
    });
    await persistAudit(store, outcome, new Map([[0, "row-a"]]), "sha-1");
    const target = store.rows.find((r) => r.type === "MISSING_ENCOUNTER")!;
    target.status = "DISMISSED";
    target.dispositionSourceFingerprint = "sha-1";

    // The document is re-extracted; its bytes are different now.
    await persistAudit(store, outcome, new Map([[0, "row-a"]]), "sha-2");
    expect(store.rows.find((r) => r.fingerprint === target.fingerprint)!.status).toBe("OPEN");
    expect(distinctOpen(store.rows).some((f) => f.fingerprint === target.fingerprint)).toBe(true);
  });

  it("gives an audit finding a stable identity across re-derivations", async () => {
    const base: FindingDraft = {
      firmId: "firm-1", caseId: "case-1", scope: "PAGE", type: "PAGE_UNREADABLE",
      source: "DETERMINISTIC_VALIDATOR", sourceDocumentId: "doc-1", pageStart: 7, pageEnd: 7,
      detail: "Could not be read.",
    };
    expect(findingFingerprint(base)).toBe(findingFingerprint({ ...base, detail: "Reworded." }));
    expect(findingFingerprint(base)).not.toBe(findingFingerprint({ ...base, pageStart: 9, pageEnd: 9 }));
  });
});
