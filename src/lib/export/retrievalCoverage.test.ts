// The report must say what it could not search — for every producer.
//
// It queried only the latest standard-of-care attempt and passed it to the
// per-item guideline paragraph. article-citations and evidence-graph recorded
// PARTIAL outcomes as persisted, non-blocking ValidationFindings, and no
// appendix printed them: Appendix F renders the separately computed integrity
// findings, Appendix G only blocking rows. A final report could go out with
// half the citation sources unreachable and say nothing at all.

import { describe, it, expect, vi, beforeEach } from "vitest";
import JSZip from "jszip";
import { coverageDisclosure, type AttemptRow } from "@/lib/export/retrievalCoverage";

const attempt = (over: Partial<AttemptRow>): AttemptRow => ({
  producer: "article-citations", status: "SUCCEEDED", failure: null, failedSources: [], produced: 3, considered: 14, ...over,
});

describe("one statement, for the whole case", () => {
  it("says nothing when every producer completed cleanly", () => {
    const r = coverageDisclosure([attempt({}), attempt({ producer: "standard-of-care" })]);
    expect(r.text).toBeNull();
    expect(r.degraded).toEqual([]);
  });

  it("names the producer and the source that did not answer", () => {
    const r = coverageDisclosure([attempt({ status: "PARTIAL", failedSources: ["crossref:TIMEOUT"] })]);
    expect(r.text).toContain("supporting-article citations");
    expect(r.text).toContain("crossref (timeout)");
    expect(r.degraded).toEqual(["article-citations"]);
  });

  it("keeps the retrieved results usable and says so", () => {
    const r = coverageDisclosure([attempt({ status: "PARTIAL", failedSources: ["crossref:TIMEOUT"] })]);
    expect(r.text).toMatch(/real and is relied upon/i);
    expect(r.text).toMatch(/not evidence that nothing further exists/i);
  });

  it("deduplicates a source that broke two different producers", () => {
    // One flaky source is one unreachable source, not two.
    const r = coverageDisclosure([
      attempt({ producer: "article-citations", status: "PARTIAL", failedSources: ["crossref:TIMEOUT"] }),
      attempt({ producer: "standard-of-care", status: "PARTIAL", failedSources: ["crossref:TIMEOUT"] }),
    ]);
    expect(r.text!.match(/crossref/g)).toHaveLength(1);
    expect(r.text).toContain("supporting-article citations and guideline analysis");
  });

  it("reports a wholly failed producer separately from a partial one", () => {
    const r = coverageDisclosure([
      attempt({ status: "PARTIAL", failedSources: ["crossref:TIMEOUT"] }),
      attempt({ producer: "standard-of-care", status: "FAILED", failure: "UNREACHABLE" }),
    ]);
    expect(r.text).toMatch(/did not complete for this plan/i);
    expect(r.text).toMatch(/No statement anywhere in this document about the absence/i);
    expect([...r.degraded].sort()).toEqual(["article-citations", "standard-of-care"]);
  });

  it("treats NOT_ATTEMPTED as a failure to search, not as an answer", () => {
    expect(coverageDisclosure([attempt({ status: "NOT_ATTEMPTED", failure: "AUTH" })]).text).toMatch(/did not complete/i);
  });

  it("says nothing for NO_RESULTS — a completed search that found nothing is an answer", () => {
    expect(coverageDisclosure([attempt({ status: "NO_RESULTS", produced: 0 })]).text).toBeNull();
  });
});

// ── Rendered ────────────────────────────────────────────────────────────────

const deps = vi.hoisted(() => ({ attempts: [] as unknown[] }));

vi.mock("@/lib/db", async () => {
  const { goldenCase, goldenAssessments, GOLDEN_CASE_ID } = await import("./goldenFixture");
  return {
    prisma: {
      case: { findUniqueOrThrow: async () => goldenCase(), findFirst: async () => ({ id: GOLDEN_CASE_ID, firmId: "firm-golden" }) },
      clinicalReasoningAssessment: { findMany: async () => goldenAssessments() },
      validationFinding: { findMany: async () => [], count: async () => 0 },
      futureCareItem: { findMany: async () => goldenCase().futureCareItems },
      condition: { findMany: async () => goldenCase().conditions },
      attestation: { findMany: async () => goldenCase().attestations },
      user: { findFirst: async () => ({ id: "user-golden-md", role: "PHYSICIAN_REVIEWER" }) },
      userRoleAssignment: { findFirst: async () => null },
      userCredential: { findMany: async () => [{ category: "PHYSICIAN", status: "ORG_VERIFIED", expiresAt: null }] },
      recommendationEvidence: { findMany: async () => [] },
      recommendationBasis: { findMany: async () => [] },
      retrievalAttempt: { findMany: async () => deps.attempts, findFirst: async () => null },
      economicAssumption: { findFirst: async () => null },
      vocationalEntry: { findMany: async () => [] },
      economicScenario: { findMany: async () => [] },
      reportApproval: { findFirst: async () => null },
      futureDamagesEvaluation: { findFirst: async () => null },
    },
  };
});

const renderedText = async (): Promise<string> => {
  const { buildReportDocx } = await import("./report");
  const { buffer } = await buildReportDocx("case-golden-lcp-0001", "PLAINTIFF");
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")!.async("string");
  return xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
};

beforeEach(() => { deps.attempts = []; });

describe("the rendered document discloses a partial article-citation run", () => {
  it("names the failed source and the limitation, exactly once", async () => {
    // One successful source, one failed — the case the review asked for.
    deps.attempts = [
      { producer: "article-citations", status: "PARTIAL", failure: "TIMEOUT", failedSources: ["crossref:TIMEOUT"], produced: 3, considered: 14 },
    ];
    const text = await renderedText();

    expect(text).toContain("Retrieval coverage");
    expect(text).toContain("supporting-article citations");
    expect(text).toContain("crossref (timeout)");
    expect(text).toMatch(/coverage is narrower than a complete search/i);

    // Once. Repeating it per recommendation would manufacture obligations a
    // physician then has to work through row by row.
    expect(text.match(/crossref \(timeout\)/g)).toHaveLength(1);
    expect(text.match(/Retrieval coverage/g)).toHaveLength(1);
  });

  it("says nothing when every producer completed", async () => {
    deps.attempts = [
      { producer: "article-citations", status: "SUCCEEDED", failure: null, failedSources: [], produced: 3, considered: 14 },
      { producer: "standard-of-care", status: "NO_RESULTS", failure: null, failedSources: [], produced: 0, considered: 2 },
    ];
    const text = await renderedText();
    expect(text).not.toContain("Retrieval coverage");
  });

  it("discloses a producer the per-item guideline paragraph never sees", async () => {
    // evidence-graph has no per-item paragraph at all; before this it could
    // only ever be a persisted finding nothing printed.
    deps.attempts = [
      { producer: "evidence-graph", status: "FAILED", failure: "UNKNOWN", failedSources: [], produced: 0, considered: 0 },
    ];
    const text = await renderedText();
    expect(text).toContain("evidence graph");
    expect(text).toMatch(/did not complete for this plan/i);
  });
});
