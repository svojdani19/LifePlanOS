// Retrieval truthfulness at the level where the claim is actually made.
//
// The generic reachability probe searches the word "medicine". It answers "is
// the internet up" and never "did we look for THIS patient's care", yet a
// producer that passed the probe and then had every real query rejected still
// reported NO_RESULTS — which the report renders as an absence of literature.
//
// Synthetic queries only — no PHI.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { outcomeFromAttempts, dominantFailure, retrievalFinding, type QueryAttempt } from "@/lib/engine/retrievalStatus";

const art = (key: string) => ({ source: "europepmc" as const, key, title: `Study ${key}`, authors: "A", journal: "J", year: "2020", url: "u" });

const mockSources = (impl: Record<string, () => Promise<unknown[]>>, ssEnabled = false) => {
  vi.doMock("@/lib/literature/europepmc", () => ({ search: impl.europepmc ?? (async () => []) }));
  vi.doMock("@/lib/literature/crossref", () => ({ search: impl.crossref ?? (async () => []) }));
  vi.doMock("@/lib/literature/semanticscholar", () => ({ search: impl.semanticscholar ?? (async () => []), enabled: () => ssEnabled }));
};

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.doUnmock("@/lib/literature/europepmc");
  vi.doUnmock("@/lib/literature/crossref");
  vi.doUnmock("@/lib/literature/semanticscholar");
});

describe("every source/query attempt is reported, not swallowed", () => {
  it("all fulfilled empty — two answers, no failures, no articles", async () => {
    mockSources({});
    const { searchCandidates } = await import("@/lib/literature");
    const r = await searchCandidates("knee arthroplasty");
    expect(r.articles).toHaveLength(0);
    const asked = r.attempts.filter((a) => a.status !== "SKIPPED");
    expect(asked).toHaveLength(2);
    expect(asked.every((a) => a.status === "FULFILLED")).toBe(true);
    expect(asked.every((a) => a.failure === null)).toBe(true);
  });

  it("one fulfilled empty plus one rejected — the rejection is visible", async () => {
    mockSources({ crossref: async () => { throw new Error("fetch failed"); } });
    const { searchCandidates } = await import("@/lib/literature");
    const r = await searchCandidates("knee arthroplasty");
    const byStatus = Object.fromEntries(r.attempts.filter((a) => a.status !== "SKIPPED").map((a) => [a.source, a.status]));
    expect(byStatus).toEqual({ europepmc: "FULFILLED", crossref: "REJECTED" });
    const rej = r.attempts.find((a) => a.status === "REJECTED")!;
    expect(rej.failure).toBe("UNREACHABLE");
    expect(rej.detail).toMatch(/fetch failed/i);
  });

  it("one successful results plus one rejected — the results still arrive", async () => {
    mockSources({ europepmc: async () => [art("a"), art("b")], crossref: async () => { throw new Error("429 Too Many Requests"); } });
    const { searchCandidates } = await import("@/lib/literature");
    const r = await searchCandidates("knee arthroplasty");
    expect(r.articles).toHaveLength(2);
    expect(r.attempts.find((a) => a.source === "crossref")!.failure).toBe("RATE_LIMITED");
    expect(r.attempts.find((a) => a.source === "europepmc")!.results).toBe(2);
  });

  it("all rejected with mixed causes — each cause is kept separately", async () => {
    mockSources({
      europepmc: async () => { throw new Error("getaddrinfo ENOTFOUND"); },
      crossref: async () => { throw Object.assign(new Error("nope"), { status: 401 }); },
    });
    const { searchCandidates } = await import("@/lib/literature");
    const r = await searchCandidates("knee arthroplasty");
    const causes = r.attempts.filter((a) => a.status === "REJECTED").map((a) => a.failure).sort();
    expect(causes).toEqual(["AUTH", "UNREACHABLE"]);
  });

  it("an unconfigured Semantic Scholar is SKIPPED, never asked, never a failure", async () => {
    // A source that is not configured is not evidence of absence and is not a
    // fault. Counting it either way would be a lie in one direction or other.
    mockSources({}, false);
    const { searchCandidates } = await import("@/lib/literature");
    const r = await searchCandidates("knee arthroplasty");
    const ss = r.attempts.find((a) => a.source === "semanticscholar")!;
    expect(ss.status).toBe("SKIPPED");
    expect(ss.failure).toBeNull();
  });

  it("a configured Semantic Scholar is asked like any other source", async () => {
    mockSources({ semanticscholar: async () => [art("s")] }, true);
    const { searchCandidates } = await import("@/lib/literature");
    const r = await searchCandidates("knee arthroplasty");
    expect(r.attempts.find((a) => a.source === "semanticscholar")!.status).toBe("FULFILLED");
    expect(r.articles).toHaveLength(1);
  });

  it("records the query text on every attempt, so the claim is traceable", async () => {
    mockSources({});
    const { searchCandidates } = await import("@/lib/literature");
    const r = await searchCandidates("cervical radiculopathy epidural");
    expect(r.attempts.every((a) => a.query === "cervical radiculopathy epidural")).toBe(true);
  });
});

describe("a source that answers is reachable, even when another rejects", () => {
  it("one rejection does not mark the whole producer offline", async () => {
    // The old probe required EVERY source to answer, so one flaky source
    // suppressed a search the other would have completed.
    mockSources({ crossref: async () => { throw new Error("fetch failed"); } });
    const { literatureReachability } = await import("@/lib/literature");
    const r = await literatureReachability();
    expect(r.reachable).toBe(true);
    expect(r.detail).toMatch(/1 rejected/i);
  });

  it("is unreachable only when nothing answered at all", async () => {
    mockSources({
      europepmc: async () => { throw new Error("fetch failed"); },
      crossref: async () => { throw new Error("fetch failed"); },
    });
    const { literatureReachability } = await import("@/lib/literature");
    expect((await literatureReachability()).reachable).toBe(false);
  });
});

describe("NO_RESULTS is earned, not assumed", () => {
  const a = (over: Partial<QueryAttempt>): QueryAttempt => ({
    source: "europepmc", query: "q", status: "FULFILLED", failure: null, detail: null, results: 0, ...over,
  });

  it("the generic probe passing then EVERY case query failing is FAILED, not NO_RESULTS", () => {
    // This is the exact sequence the old code turned into an absence claim.
    const r = outcomeFromAttempts(
      [a({ status: "REJECTED", failure: "UNREACHABLE" }), a({ source: "crossref", status: "REJECTED", failure: "TIMEOUT" })],
      0, 14, "nothing",
    );
    expect(r.status).toBe("FAILED");
    expect(r.failure).toBe("TIMEOUT"); // most actionable of the two
    expect(r.detail).toMatch(/every case-specific query failed/i);
  });

  it("every relevant query answered and nothing found is NO_RESULTS", () => {
    const r = outcomeFromAttempts([a({}), a({ source: "crossref" })], 0, 14, "Attached 0 of 14.");
    expect(r.status).toBe("NO_RESULTS");
    expect(r.failure).toBeNull();
    expect(r.sources).toEqual(["europepmc", "crossref"]);
  });

  it("nothing found while a source never answered is FAILED — absence cannot be asserted", () => {
    const r = outcomeFromAttempts([a({}), a({ source: "crossref", status: "REJECTED", failure: "RATE_LIMITED" })], 0, 14, "x");
    expect(r.status).toBe("FAILED");
    expect(r.failure).toBe("RATE_LIMITED");
    expect(r.detail).toMatch(/not every source answered/i);
  });

  it("partial success keeps the results AND is its own status", () => {
    // This asserted SUCCEEDED, which is precisely the defect: retrievalFinding
    // says nothing about a SUCCEEDED run, so a case where half the sources were
    // unreachable read as clean.
    const r = outcomeFromAttempts([a({ results: 3 }), a({ source: "crossref", status: "REJECTED", failure: "TIMEOUT" })], 3, 14, "Attached 3 of 14.");
    expect(r.status).toBe("PARTIAL");
    expect(r.produced).toBe(3);
    expect(r.failedSources).toEqual([{ source: "crossref", failure: "TIMEOUT" }]);
    expect(r.detail).toMatch(/crossref:TIMEOUT/);
  });

  it("a clean run is SUCCEEDED with no failed sources", () => {
    const r = outcomeFromAttempts([a({ results: 3 }), a({ source: "crossref", results: 1 })], 3, 14, "Attached 3 of 14.");
    expect(r.status).toBe("SUCCEEDED");
    expect(r.failedSources).toEqual([]);
  });

  it("counts one flaky source once, however many queries it failed", () => {
    // Eight failed queries against one outage is one gap, not eight. Inflating
    // it turns a single outage into an apparent pile of obligations.
    const many = Array.from({ length: 8 }, (_, i) => a({ source: "crossref", query: `q${i}`, status: "REJECTED" as const, failure: "TIMEOUT" as const }));
    const r = outcomeFromAttempts([a({ results: 2 }), ...many], 2, 14, "x");
    expect(r.status).toBe("PARTIAL");
    expect(r.failedSources).toHaveLength(1);
  });

  it("skipped sources are neither evidence of absence nor failure", () => {
    const r = outcomeFromAttempts(
      [a({}), a({ source: "semanticscholar", status: "SKIPPED", detail: "not configured" })],
      0, 5, "none",
    );
    expect(r.status).toBe("NO_RESULTS");
  });

  it("only skipped sources means nothing was attempted", () => {
    const r = outcomeFromAttempts([a({ source: "semanticscholar", status: "SKIPPED" })], 0, 5, "none");
    expect(r.status).toBe("NOT_ATTEMPTED");
  });

  it("no attempts at all is NOT_ATTEMPTED", () => {
    expect(outcomeFromAttempts([], 0, 5, "none").status).toBe("NOT_ATTEMPTED");
  });

  it("ranks failure causes by how actionable they are", () => {
    expect(dominantFailure(["UNREACHABLE", "AUTH"])).toBe("AUTH");
    expect(dominantFailure(["UNKNOWN", "UNREACHABLE"])).toBe("UNREACHABLE");
    expect(dominantFailure([])).toBe("UNKNOWN");
  });

  it("keeps the detail bounded and free of anything but source and cause", () => {
    const many = Array.from({ length: 40 }, (_, i) => a({ source: `s${i}`, status: "REJECTED" as const, failure: "UNKNOWN" as const }));
    const r = outcomeFromAttempts(many, 0, 1, "x");
    expect(r.detail.length).toBeLessThanOrEqual(300);
  });
});

describe("retries and isolation", () => {
  it("a retry that succeeds reports SUCCEEDED with no memory of the earlier failure", () => {
    const first = outcomeFromAttempts([{ source: "europepmc", query: "q", status: "REJECTED", failure: "TIMEOUT", detail: "t", results: 0 }], 0, 3, "x");
    expect(first.status).toBe("FAILED");
    const second = outcomeFromAttempts([{ source: "europepmc", query: "q", status: "FULFILLED", failure: null, detail: null, results: 2 }], 2, 3, "Attached 2 of 3.");
    expect(second.status).toBe("SUCCEEDED");
    expect(second.detail).not.toMatch(/failed/i);
  });

  it("attempts carry no tenant or patient identity — only source, query and cause", () => {
    // The detail string is persisted. Anything case-identifying here would
    // leak through the audit trail of every firm.
    const r = outcomeFromAttempts(
      [{ source: "europepmc", query: "total knee arthroplasty", status: "REJECTED", failure: "AUTH", detail: "401", results: 0 }],
      0, 1, "x",
    );
    // The aggregate detail names sources and causes and nothing else. The
    // query text is deliberately absent: clinical terms are not PHI, but
    // pinned to one case in an audit row they narrow it more than they help.
    expect(r.detail).not.toContain("total knee arthroplasty");
    expect(r.detail).not.toMatch(/\bpatient\b|\bmrn\b|\bdob\b|firmId|caseId/i);
    expect(Object.keys(r).sort()).toEqual(["considered", "detail", "failedSources", "failure", "produced", "sources", "status"]);
  });
});

describe("a partial run is disclosed, scoped, and not inflated", () => {
  const partial = {
    producer: "article-citations",
    status: "PARTIAL" as const,
    failure: "TIMEOUT" as const,
    detail: "Attached 3 of 14.",
    produced: 3,
    considered: 14,
    failedSources: [{ source: "crossref", failure: "TIMEOUT" as const }],
  };

  it("produces a finding at all — a SUCCEEDED run produced none", () => {
    const f = retrievalFinding(partial);
    expect(f).not.toBeNull();
    expect(f!.result).toBe("RETRIEVAL_PARTIAL:article-citations");
  });

  it("names exactly which source failed and why", () => {
    expect(retrievalFinding(partial)!.issue).toMatch(/crossref \(timeout\)/i);
  });

  it("says the retrieved results are still usable", () => {
    const issue = retrievalFinding(partial)!.issue;
    expect(issue).toMatch(/usable and is shown/i);
    expect(issue).toMatch(/not evidence that nothing further exists/i);
  });

  it("does not block the export — real results were obtained", () => {
    expect(retrievalFinding(partial)!.exportBlocking).toBe(false);
  });

  it("asks for no per-recommendation action, so it cannot inflate physician obligations", () => {
    const f = retrievalFinding(partial)!;
    expect(f.service).toBe("Case-wide");
    expect(f.suggestion).toMatch(/no per-recommendation action is required/i);
  });

  it("is one finding per producer, so two producers do not merge or duplicate", () => {
    const other = retrievalFinding({ ...partial, producer: "standard-of-care" })!;
    expect(other.result).toBe("RETRIEVAL_PARTIAL:standard-of-care");
    expect(other.result).not.toBe(retrievalFinding(partial)!.result);
  });
});
