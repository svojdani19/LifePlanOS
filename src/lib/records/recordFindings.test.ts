// ─────────────────────────────────────────────────────────────────────────────
// A machine pass may close a problem it proved is gone. It may not close a
// person's answer, and it may not close a problem it never looked at.
//
// Both failures were live: supersession ran case-wide whenever any subset of
// documents was re-audited, and it swept CONFIRMED — a human saying "yes, this
// is real" — into RESOLVED. A dismissal also carried forward across source
// changes, so a reviewer's decision about one version of a page silenced a
// finding about content they had never seen.
//
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, beforeEach } from "vitest";
import { writeFindings, findingFingerprint, dispositionOutlivedItsSource, type FindingDraft } from "@/lib/records/recordFindings";

interface Row {
  fingerprint: string;
  caseId: string;
  sourceDocumentId: string | null;
  source: string;
  status: string;
  dispositionReason?: string | null;
  reviewedById?: string | null;
  reviewedAt?: Date | null;
  dispositionSourceFingerprint?: string | null;
  dispositionHistory?: unknown;
  [k: string]: unknown;
}

/** A fake store that behaves like the two Prisma calls this service makes. */
function makeStore(seed: Row[] = []) {
  const rows = [...seed];
  const matches = (r: Row, where: Record<string, unknown>): boolean => {
    if (where.caseId && r.caseId !== where.caseId) return false;
    if (where.source && typeof where.source === "object" && "in" in (where.source as object)) {
      if (!((where.source as { in: string[] }).in ?? []).includes(r.source)) return false;
    }
    if (typeof where.status === "string" && r.status !== where.status) return false;
    if (where.fingerprint && typeof where.fingerprint === "object") {
      const f = where.fingerprint as { in?: string[]; notIn?: string[] };
      if (f.in && !f.in.includes(r.fingerprint)) return false;
      if (f.notIn && f.notIn.includes(r.fingerprint)) return false;
    }
    if (Array.isArray(where.OR)) {
      const ok = (where.OR as Record<string, unknown>[]).some((clause) => {
        if ("sourceDocumentId" in clause) {
          const v = clause.sourceDocumentId;
          if (v === null) return r.sourceDocumentId === null;
          if (v && typeof v === "object" && "in" in (v as object)) {
            return r.sourceDocumentId != null && ((v as { in: string[] }).in ?? []).includes(r.sourceDocumentId);
          }
        }
        return false;
      });
      if (!ok) return false;
    }
    return true;
  };
  return {
    rows,
    recordFinding: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)),
      upsert: async ({ where, update, create }: { where: { caseId_fingerprint: { caseId: string; fingerprint: string } }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
        const hit = rows.find((r) => r.fingerprint === where.caseId_fingerprint.fingerprint && r.caseId === where.caseId_fingerprint.caseId);
        if (hit) Object.assign(hit, update);
        // A created row gets the schema's default status, as Prisma would.
        else rows.push({ status: "OPEN", ...(create as unknown as Omit<Row, "status">) } as Row);
        return {};
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    },
  };
}

const draft = (over: Partial<FindingDraft> = {}): FindingDraft => ({
  firmId: "firm-1",
  caseId: "case-1",
  scope: "DOCUMENT",
  type: "MISSING_ENCOUNTER",
  blocking: true,
  source: "DETERMINISTIC_VALIDATOR",
  sourceDocumentId: "doc-1",
  detail: "A dated note header produced no entry.",
  ...over,
});

const persisted = (d: FindingDraft, over: Partial<Row> = {}): Row => ({
  fingerprint: findingFingerprint(d),
  caseId: d.caseId,
  sourceDocumentId: d.sourceDocumentId ?? null,
  source: d.source,
  status: "OPEN",
  ...over,
});

let store: ReturnType<typeof makeStore>;
beforeEach(() => {
  store = makeStore();
});

describe("supersession closes only what this pass proved is gone", () => {
  it("resolves a machine finding the current derivation no longer produces", async () => {
    const stale = draft({ type: "SOURCE_CLIPPED" });
    store = makeStore([persisted(stale)]);
    const out = await writeFindings(store, [draft()], {
      caseId: "case-1",
      sources: ["DETERMINISTIC_VALIDATOR"],
      evaluatedDocumentIds: ["doc-1"],
      evaluatedWholeCase: true,
    });
    expect(out.resolved).toBe(1);
    expect(store.rows.find((r) => r.fingerprint === findingFingerprint(stale))!.status).toBe("RESOLVED");
  });

  it("never resolves a CONFIRMED finding — a human said the problem is real", async () => {
    const confirmed = draft({ type: "SOURCE_CLIPPED" });
    store = makeStore([persisted(confirmed, { status: "CONFIRMED" })]);
    const out = await writeFindings(store, [draft()], {
      caseId: "case-1",
      sources: ["DETERMINISTIC_VALIDATOR"],
      evaluatedDocumentIds: ["doc-1"],
      evaluatedWholeCase: true,
    });
    expect(out.resolved).toBe(0);
    expect(store.rows.find((r) => r.fingerprint === findingFingerprint(confirmed))!.status).toBe("CONFIRMED");
  });

  it("leaves DISMISSED and already-RESOLVED findings alone", async () => {
    const a = draft({ type: "SOURCE_CLIPPED" });
    const b = draft({ type: "PAGE_TRUNCATED" });
    store = makeStore([persisted(a, { status: "DISMISSED" }), persisted(b, { status: "RESOLVED" })]);
    await writeFindings(store, [draft()], {
      caseId: "case-1",
      sources: ["DETERMINISTIC_VALIDATOR"],
      evaluatedDocumentIds: ["doc-1"],
      evaluatedWholeCase: true,
    });
    expect(store.rows.map((r) => r.status).sort()).toContain("DISMISSED");
    expect(store.rows.find((r) => r.fingerprint === findingFingerprint(a))!.status).toBe("DISMISSED");
  });

  it("never resolves a HUMAN_REVIEW finding, even when a caller asks for it", async () => {
    const raised = draft({ type: "UNSUPPORTED_CLAIM", source: "HUMAN_REVIEW" });
    store = makeStore([persisted(raised)]);
    const out = await writeFindings(store, [draft()], {
      caseId: "case-1",
      // A caller naming HUMAN_REVIEW is refused it, not obeyed.
      sources: ["DETERMINISTIC_VALIDATOR", "HUMAN_REVIEW"],
      evaluatedDocumentIds: ["doc-1"],
      evaluatedWholeCase: true,
    });
    expect(out.resolved).toBe(0);
    expect(store.rows.find((r) => r.fingerprint === findingFingerprint(raised))!.status).toBe("OPEN");
  });
});

describe("supersession reaches only the scope the pass evaluated", () => {
  it("does not touch another document's findings", async () => {
    const other = draft({ sourceDocumentId: "doc-2", type: "SOURCE_CLIPPED" });
    store = makeStore([persisted(other)]);
    const out = await writeFindings(store, [draft()], {
      caseId: "case-1",
      sources: ["DETERMINISTIC_VALIDATOR"],
      evaluatedDocumentIds: ["doc-1"],
      evaluatedWholeCase: false,
    });
    expect(out.resolved).toBe(0);
    expect(store.rows[0].status).toBe("OPEN");
  });

  it("leaves case-scope findings open when only some documents were evaluated", async () => {
    // "Not every document has finished processing" is exactly the finding a
    // partial pass must not clear.
    const caseWide = draft({ scope: "CASE", type: "DOCUMENTS_STILL_PROCESSING", sourceDocumentId: null });
    store = makeStore([persisted(caseWide)]);
    const out = await writeFindings(store, [draft()], {
      caseId: "case-1",
      sources: ["DETERMINISTIC_VALIDATOR"],
      evaluatedDocumentIds: ["doc-1"],
      evaluatedWholeCase: false,
    });
    expect(out.resolved).toBe(0);
    expect(store.rows[0].status).toBe("OPEN");
  });

  it("may clear a case-scope finding once every document was evaluated", async () => {
    const caseWide = draft({ scope: "CASE", type: "DOCUMENTS_STILL_PROCESSING", sourceDocumentId: null });
    store = makeStore([persisted(caseWide)]);
    const out = await writeFindings(store, [draft()], {
      caseId: "case-1",
      sources: ["DETERMINISTIC_VALIDATOR"],
      evaluatedDocumentIds: ["doc-1"],
      evaluatedWholeCase: true,
    });
    expect(out.resolved).toBe(1);
  });

  it("supersedes nothing when the pass evaluated no document at all", async () => {
    store = makeStore([persisted(draft({ type: "SOURCE_CLIPPED" }))]);
    const out = await writeFindings(store, [], {
      caseId: "case-1",
      sources: ["DETERMINISTIC_VALIDATOR"],
      evaluatedDocumentIds: [],
      evaluatedWholeCase: false,
    });
    expect(out.resolved).toBe(0);
  });
});

describe("a disposition covers the content it was given over", () => {
  it("reopens a dismissal when the source fingerprint changed underneath it", async () => {
    const d = draft({ sourceFingerprint: "sha-NEW" });
    store = makeStore([
      persisted(d, {
        status: "DISMISSED",
        dispositionReason: "checked the scan; the page is fine",
        reviewedById: "reviewer-1",
        reviewedAt: new Date("2026-08-01T00:00:00Z"),
        dispositionSourceFingerprint: "sha-OLD",
      }),
    ]);
    const out = await writeFindings(store, [d]);
    expect(out.reopened).toBe(1);
    const row = store.rows[0];
    expect(row.status).toBe("OPEN");
    expect(row.dispositionReason).toBeNull();
    // The human's decision is preserved as history, not erased.
    const history = row.dispositionHistory as { status: string; byId: string; reason: string }[];
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("DISMISSED");
    expect(history[0].byId).toBe("reviewer-1");
    expect(history[0].reason).toMatch(/checked the scan/);
  });

  it("keeps a dismissal when the source is unchanged", async () => {
    const d = draft({ sourceFingerprint: "sha-SAME" });
    store = makeStore([persisted(d, { status: "DISMISSED", dispositionSourceFingerprint: "sha-SAME" })]);
    const out = await writeFindings(store, [d]);
    expect(out.reopened).toBe(0);
    expect(store.rows[0].status).toBe("DISMISSED");
  });

  it("does not reopen when no fingerprint was recorded — absent evidence is not evidence of change", async () => {
    const d = draft({ sourceFingerprint: "sha-NEW" });
    store = makeStore([persisted(d, { status: "DISMISSED", dispositionSourceFingerprint: null })]);
    const out = await writeFindings(store, [d]);
    expect(out.reopened).toBe(0);
    expect(store.rows[0].status).toBe("DISMISSED");
  });

  it("never reopens a CONFIRMED finding — it is already open and stays open", () => {
    expect(
      dispositionOutlivedItsSource({ fingerprint: "fp", status: "CONFIRMED", dispositionSourceFingerprint: "sha-OLD" }, "sha-NEW"),
    ).toBe(false);
  });

  it("refreshes wording and provenance on a re-derivation without changing status", async () => {
    const first = draft({ detail: "original wording", sourceFingerprint: "sha-1", producerVersion: "v1" });
    await writeFindings(store, [first]);
    await writeFindings(store, [{ ...first, detail: "reworded explanation", producerVersion: "v2" }]);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].detail).toBe("reworded explanation");
    expect(store.rows[0].producerVersion).toBe("v2");
    expect(store.rows[0].status).toBe("OPEN");
  });
});
