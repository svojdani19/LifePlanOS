import { describe, it, expect, vi } from "vitest";
import {
  classifyRetrievalFailure,
  retrievalDetail,
  runRetrieval,
  retrievalFinding,
  recordRetrievalAttempts,
  notAttempted,
  nothingToDo,
  retrieved,
  RETRIEVAL_FINDING_PREFIX,
  RETRIEVAL_VERSION,
  type RecordedAttempt,
} from "@/lib/engine/retrievalStatus";

describe("the three ways of producing nothing stay apart", () => {
  // This is the whole point of the module. `.catch(() => {})` plus a numeric
  // return collapsed all three into 0, and the report renders an absence
  // statement that only one of them supports.
  it("never queried is NOT_ATTEMPTED with a reason", () => {
    const o = notAttempted("UNREACHABLE", "getaddrinfo ENOTFOUND", 14);
    expect(o.status).toBe("NOT_ATTEMPTED");
    expect(o.failure).toBe("UNREACHABLE");
    expect(o.considered).toBe(14); // 14 items existed; none were searched
  });

  it("queried and empty is NO_RESULTS with no failure", () => {
    const o = retrieved(0, 14, ["europepmc"], "nothing cleared the gates");
    expect(o.status).toBe("NO_RESULTS");
    expect(o.failure).toBeNull();
  });

  it("queried and productive is SUCCEEDED", () => {
    expect(retrieved(3, 14, ["europepmc"], "").status).toBe("SUCCEEDED");
  });

  it("nothing to do is not a failure", () => {
    const o = nothingToDo("No conditions on the case.");
    expect(o.status).toBe("NOT_ATTEMPTED");
    expect(o.failure).toBeNull();
    expect(retrievalFinding({ ...o, producer: "standard-of-care" })).toBeNull();
  });

  it("0 produced out of 0 considered is not the same row as 0 out of 14", () => {
    expect(nothingToDo("x").considered).toBe(0);
    expect(notAttempted("TIMEOUT", "x", 14).considered).toBe(14);
  });
});

describe("failure classification is specific or honest, never plausible", () => {
  it.each([
    [{ status: 429 }, "RATE_LIMITED"],
    [{ status: 401 }, "AUTH"],
    [{ status: 403 }, "AUTH"],
    [{ status: 504 }, "TIMEOUT"],
    [Object.assign(new Error("x"), { name: "AbortError" }), "CANCELLED"],
    [new SyntaxError("Unexpected token < in JSON"), "MALFORMED"],
    [new Error("fetch failed"), "UNREACHABLE"],
    [new Error("getaddrinfo EAI_AGAIN eutils.ncbi.nlm.nih.gov"), "UNREACHABLE"],
    [new Error("request to https://x timed out"), "TIMEOUT"],
    [new Error("429 Too Many Requests"), "RATE_LIMITED"],
    [new Error("Invalid API key"), "AUTH"],
  ])("classifies %o", (err, expected) => {
    expect(classifyRetrievalFailure(err)).toBe(expected);
  });

  it("refuses to guess: an unrecognised error is UNKNOWN, not the nearest bucket", () => {
    // A wrong category sends someone to debug the wrong system, which costs
    // more than no category.
    expect(classifyRetrievalFailure(new Error("the flux capacitor disagreed"))).toBe("UNKNOWN");
    expect(classifyRetrievalFailure(null)).toBe("UNKNOWN");
    expect(classifyRetrievalFailure("just a string")).toBe("UNKNOWN");
  });

  it("keeps the detail short and single-line for the audit trail", () => {
    const d = retrievalDetail(new Error(`line one\n   line two ${"x".repeat(500)}`));
    expect(d).not.toContain("\n");
    expect(d.length).toBeLessThanOrEqual(300);
  });
});

describe("runRetrieval keeps generation alive without eating the fact", () => {
  it("does not throw when the producer throws, and records why", async () => {
    const r = await runRetrieval("article-citations", RETRIEVAL_VERSION, async () => {
      throw new Error("fetch failed");
    });
    expect(r.status).toBe("FAILED");
    expect(r.failure).toBe("UNREACHABLE");
    expect(r.producer).toBe("article-citations");
    expect(r.producerVersion).toBe(RETRIEVAL_VERSION);
  });

  it("passes an outcome through unchanged", async () => {
    const r = await runRetrieval("standard-of-care", RETRIEVAL_VERSION, async () => notAttempted("AUTH", "no key"));
    expect(r.status).toBe("NOT_ATTEMPTED");
    expect(r.failure).toBe("AUTH");
  });
});

describe("the finding is proportionate to what actually happened", () => {
  const f = (over: Partial<RecordedAttempt> & { producer: string }) =>
    retrievalFinding({ status: "FAILED", failure: "UNREACHABLE", detail: "d", produced: 0, considered: 3, ...over });

  it("says nothing when the step succeeded", () => {
    expect(f({ producer: "standard-of-care", status: "SUCCEEDED", failure: null, produced: 2 })).toBeNull();
  });

  it("discloses an empty literature search WITHOUT blocking", () => {
    // "We looked and found nothing" is a legitimate state for a plan to be in,
    // and a real answer about the medicine. Blocking it would punish honesty.
    const r = f({ producer: "article-citations", status: "NO_RESULTS", failure: null })!;
    expect(r.exportBlocking).toBe(false);
    expect(r.severity).toBe("Low");
    expect(r.issue).toMatch(/search ran/i);
  });

  it("BLOCKS a final export when nothing was ever searched", () => {
    // The plan's absence statements are unfounded, and a final plan asserting
    // them is asserting something nobody established.
    const r = f({ producer: "standard-of-care", status: "NOT_ATTEMPTED" })!;
    expect(r.exportBlocking).toBe(true);
    expect(r.severity).toBe("High");
    expect(r.issue).toMatch(/unfounded/i);
    expect(r.issue).toMatch(/could not be reached/i);
  });

  it("names the consequence, not just the mechanism", () => {
    // "Citations failed" leaves the reader to guess whether the plan is still
    // safe to read; the answer differs by producer.
    expect(f({ producer: "article-citations" })!.issue).toMatch(/no supporting literature when in fact none was searched/i);
    expect(f({ producer: "disclosure:temporally-excluded" })!.issue).toMatch(/no line and no explanation/i);
  });

  it("treats an empty DISCLOSURE write as a failure, not as an answer", () => {
    // A disclosure producer that returns nothing has not learned something
    // about the world; it has failed to say something it was told to say.
    const r = f({ producer: "disclosure:unsupported-template", status: "NO_RESULTS", failure: null })!;
    expect(r.exportBlocking).toBe(true);
    expect(r.issue).toMatch(/produced nothing when it should have/i);
  });

  it("treats an empty EVIDENCE GRAPH as a legitimate answer", () => {
    // A case with nothing to link correctly has no edges. Blocking that would
    // make an empty case unexportable.
    expect(f({ producer: "evidence-graph", status: "NO_RESULTS", failure: null })!.exportBlocking).toBe(false);
  });

  it("distinguishes the failure category in the finding's identity", () => {
    // Two different causes are two different findings, so resolving one does
    // not silently dispose of the other.
    const a = f({ producer: "standard-of-care", failure: "RATE_LIMITED" })!;
    const b = f({ producer: "standard-of-care", failure: "AUTH" })!;
    expect(a.result).not.toBe(b.result);
    expect(a.result.startsWith(RETRIEVAL_FINDING_PREFIX)).toBe(true);
  });
});

describe("persistence records the attempt and republishes its findings", () => {
  const store = (prior: { service: string; result: string; status: string }[] = []) => {
    const upserts: Record<string, unknown>[] = [];
    const created: Record<string, unknown>[] = [];
    const deletes: unknown[] = [];
    return {
      upserts,
      created,
      deletes,
      db: {
        retrievalAttempt: { upsert: async (a: Record<string, unknown>) => void upserts.push(a) },
        validationFinding: {
          findMany: async () => prior,
          deleteMany: async (a: unknown) => (deletes.push(a), { count: 0 }),
          createMany: async (a: { data: Record<string, unknown>[] }) => (created.push(...a.data), { count: a.data.length }),
        },
      },
    };
  };
  const attempt = (over: Partial<RecordedAttempt> = {}): RecordedAttempt => ({
    producer: "article-citations",
    producerVersion: RETRIEVAL_VERSION,
    status: "FAILED",
    failure: "UNREACHABLE",
    detail: "fetch failed",
    produced: 0,
    considered: 5,
    sources: [],
    failedSources: [],
    ...over,
  });

  it("upserts one row per producer, keyed so the latest attempt wins", async () => {
    const s = store();
    await recordRetrievalAttempts(s.db, "case-1", "firm-1", [attempt()]);
    expect(s.upserts).toHaveLength(1);
    expect(s.upserts[0]).toMatchObject({ where: { caseId_producer: { caseId: "case-1", producer: "article-citations" } } });
  });

  it("clears last run's failure when this run succeeds", async () => {
    // A stale "retrieval failed" standing over a plan that now HAS its
    // citations is a false statement the export gate would act on.
    const s = store();
    await recordRetrievalAttempts(s.db, "case-1", "firm-1", [attempt({ status: "SUCCEEDED", failure: null, produced: 4 })]);
    expect(s.deletes).toHaveLength(1);
    expect(s.created).toHaveLength(0);
  });

  it("carries an author's disposition across the republish", async () => {
    // An author who resolved "issuing without literature" must not have that
    // decision undone by the next generation.
    const result = retrievalFinding({ ...attempt(), producer: "article-citations" })!.result;
    const s = store([{ service: "Case-wide", result, status: "RESOLVED_AS_IS" }]);
    await recordRetrievalAttempts(s.db, "case-1", "firm-1", [attempt()]);
    expect(s.created[0]).toMatchObject({ status: "RESOLVED_AS_IS" });
  });

  it("reopens when the CAUSE changes, because that is a new fact", async () => {
    const oldResult = retrievalFinding({ ...attempt(), failure: "UNREACHABLE" })!.result;
    const s = store([{ service: "Case-wide", result: oldResult, status: "RESOLVED_AS_IS" }]);
    await recordRetrievalAttempts(s.db, "case-1", "firm-1", [attempt({ failure: "AUTH" })]);
    expect(s.created[0]).toMatchObject({ status: "OPEN" });
  });

  it("does nothing at all when there were no attempts", async () => {
    const s = store();
    await recordRetrievalAttempts(s.db, "case-1", "firm-1", []);
    expect(s.upserts).toHaveLength(0);
    expect(s.deletes).toHaveLength(0);
  });
});

describe("the reachability probe says WHY, not just no", () => {
  it("reports the failure category when both sources reject", async () => {
    vi.resetModules();
    vi.doMock("@/lib/literature/europepmc", () => ({ search: async () => { throw new Error("fetch failed"); } }));
    vi.doMock("@/lib/literature/crossref", () => ({ search: async () => { throw new Error("fetch failed"); } }));
    vi.doMock("@/lib/literature/semanticscholar", () => ({ search: async () => [], enabled: () => false }));
    const { literatureReachability } = await import("@/lib/literature");
    const r = await literatureReachability();
    expect(r.reachable).toBe(false);
    expect(r.failure).toBe("UNREACHABLE");
    vi.doUnmock("@/lib/literature/europepmc");
    vi.doUnmock("@/lib/literature/crossref");
    vi.doUnmock("@/lib/literature/semanticscholar");
  });

  it("prefers the most actionable category — an auth answer beats a generic outage", async () => {
    vi.resetModules();
    vi.doMock("@/lib/literature/europepmc", () => ({ search: async () => { throw new Error("fetch failed"); } }));
    vi.doMock("@/lib/literature/crossref", () => ({ search: async () => { throw Object.assign(new Error("nope"), { status: 401 }); } }));
    vi.doMock("@/lib/literature/semanticscholar", () => ({ search: async () => [], enabled: () => false }));
    const { literatureReachability } = await import("@/lib/literature");
    expect((await literatureReachability()).failure).toBe("AUTH");
    vi.doUnmock("@/lib/literature/europepmc");
    vi.doUnmock("@/lib/literature/crossref");
    vi.doUnmock("@/lib/literature/semanticscholar");
  });

  it("calls a source that ANSWERS with nothing reachable", async () => {
    // The old probe returned false here, so producers reported "offline" for a
    // network that was working perfectly and a query that had no hits.
    vi.resetModules();
    vi.doMock("@/lib/literature/europepmc", () => ({ search: async () => [] }));
    vi.doMock("@/lib/literature/crossref", () => ({ search: async () => [] }));
    vi.doMock("@/lib/literature/semanticscholar", () => ({ search: async () => [], enabled: () => false }));
    const { literatureReachability } = await import("@/lib/literature");
    const r = await literatureReachability();
    expect(r.reachable).toBe(true);
    expect(r.failure).toBeNull();
    vi.doUnmock("@/lib/literature/europepmc");
    vi.doUnmock("@/lib/literature/crossref");
    vi.doUnmock("@/lib/literature/semanticscholar");
  });
});
