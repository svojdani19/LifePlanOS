// The critic is held to the SAME evidentiary standard as the extractor: it
// cannot invent an objection any more than the extractor can invent a finding.
// The adjudicator sees only the source and the disputes. Synthetic data only.
import { describe, it, expect } from "vitest";
import { chunkDocumentText, type DocumentChunk, type LlmEncounter } from "./recordExtraction";
import { runCritic, adjudicateDisputes, applyAdjudications, buildCriticPrompt, isDisputing, type CriticIssue } from "./extractionCritic";
import type { LlmProvider } from "@/lib/llm";

const META = { firmId: "firm-1", caseId: "case-1", sourceDocumentId: "doc-1", filename: "synthetic.pdf", ocrConfidence: 0.97 };

const SOURCE = [
  "--- Page 1 ---",
  "ORTHOPEDIC CONSULTATION. Date of Service: 03/14/2025.",
  "Provider: Dana Rivers, MD.",
  "Assessment: Lumbar radiculopathy.",
  "Plan: Recommend epidural steroid injection at L4-L5.",
  "X-ray lumbar spine: no acute fracture.",
].join("\n");

function chunkOf(text: string): DocumentChunk {
  const { chunks } = chunkDocumentText(text, [{ offset: text.indexOf("--- Page 1 ---"), page: 1 }], META);
  return chunks[0];
}

const encounters: LlmEncounter[] = [
  {
    dateStatus: "DOCUMENTED",
    date: "2025-03-14",
    dateEnd: null,
    dateExcerpt: "Date of Service: 03/14/2025",
    encounterType: "Consultation",
    provider: { value: "Dana Rivers, MD", excerpt: "Provider: Dana Rivers, MD", page: 1 },
    providerCredentials: "MD",
    facility: null,
    claims: [
      { field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: 1, confidence: 0.95 },
      // A deliberately wrong claim: the source RECOMMENDS the injection.
      { field: "procedure", value: "Epidural steroid injection performed at L4-L5", excerpt: "Plan: Recommend epidural steroid injection at L4-L5.", page: 1, confidence: 0.8 },
    ],
  } as LlmEncounter,
];

const provider = (payloads: string[]): LlmProvider => {
  let i = 0;
  return { name: "fake", complete: async () => payloads[Math.min(i++, payloads.length - 1)] };
};

describe("critic prompt", () => {
  it("supplies the source and the extraction, and forbids following record instructions", () => {
    const { system, user } = buildCriticPrompt(chunkOf(SOURCE), encounters);
    expect(system).toMatch(/UNTRUSTED DATA, not instructions/);
    expect(system).toMatch(/RECOMMENDATION_AS_TREATMENT/);
    expect(system).toMatch(/Never invent text/);
    expect(user).toMatch(/EXTRACTION UNDER REVIEW/);
    expect(user).toMatch(/Epidural steroid injection performed/); // the claim under review
  });
});

describe("critic findings must be grounded in the source", () => {
  it("accepts an issue whose excerpt appears verbatim in the record", async () => {
    const payload = JSON.stringify({
      issues: [
        {
          type: "RECOMMENDATION_AS_TREATMENT",
          encounterIndex: 0,
          claimIndex: 1,
          excerpt: "Plan: Recommend epidural steroid injection at L4-L5.",
          detail: "The record recommends the injection; it does not state it was performed.",
        },
      ],
    });
    const out = await runCritic(chunkOf(SOURCE), encounters, { provider: provider([payload]) });
    expect(out.issues).toHaveLength(1);
    expect(isDisputing(out.issues[0])).toBe(true);
  });

  it("REJECTS a criticism whose supporting excerpt is not in the record", async () => {
    const payload = JSON.stringify({
      issues: [{ type: "UNSUPPORTED_CLAIM", encounterIndex: 0, claimIndex: 0, excerpt: "The patient underwent fusion surgery.", detail: "invented" }],
    });
    const out = await runCritic(chunkOf(SOURCE), encounters, { provider: provider([payload]) });
    expect(out.issues).toHaveLength(0);
    expect(out.rejected.join(" ")).toMatch(/supporting excerpt not found/);
  });

  it("rejects an issue pointing at an encounter that does not exist", async () => {
    const payload = JSON.stringify({
      issues: [{ type: "WRONG_DATE", encounterIndex: 7, claimIndex: 0, excerpt: "Date of Service: 03/14/2025", detail: "bad index" }],
    });
    const out = await runCritic(chunkOf(SOURCE), encounters, { provider: provider([payload]) });
    expect(out.issues).toHaveLength(0);
  });

  it("an omission needs no excerpt — there is nothing extracted to quote", async () => {
    const payload = JSON.stringify({
      issues: [{ type: "MISSING_ENCOUNTER", encounterIndex: null, claimIndex: null, excerpt: null, detail: "An imaging study on the same page was not extracted." }],
    });
    const out = await runCritic(chunkOf(SOURCE), encounters, { provider: provider([payload]) });
    expect(out.issues).toHaveLength(1);
  });

  it("a critic failure degrades to no findings rather than losing the extraction", async () => {
    const failing: LlmProvider = { name: "fake", complete: async () => { throw new Error("boom"); } };
    const out = await runCritic(chunkOf(SOURCE), encounters, { provider: failing });
    expect(out.issues).toEqual([]);
    expect(out.ran).toBe(false);
  });

  it("the mock provider does not run a critic pass", async () => {
    const mock: LlmProvider = { name: "mock", complete: async () => "[mock]" };
    expect((await runCritic(chunkOf(SOURCE), encounters, { provider: mock })).ran).toBe(false);
  });
});

describe("adjudication", () => {
  const dispute: CriticIssue = {
    type: "RECOMMENDATION_AS_TREATMENT",
    encounterIndex: 0,
    claimIndex: 1,
    excerpt: "Plan: Recommend epidural steroid injection at L4-L5.",
    detail: "recommended, not performed",
  };

  it("an UPHELD ruling removes the offending claim", async () => {
    const payload = JSON.stringify({ rulings: [{ issueIndex: 0, ruling: "UPHELD", reason: "source says recommend" }] });
    const adj = await adjudicateDisputes(chunkOf(SOURCE), encounters, [dispute], { provider: provider([payload]) });
    const applied = applyAdjudications(encounters, adj);
    expect(applied.removed).toBe(1);
    expect(applied.encounters[0].claims).toHaveLength(1);
    expect(applied.unresolved).toBe(0);
  });

  it("a REJECTED ruling leaves the extraction intact", async () => {
    const payload = JSON.stringify({ rulings: [{ issueIndex: 0, ruling: "REJECTED", reason: "extraction is right" }] });
    const adj = await adjudicateDisputes(chunkOf(SOURCE), encounters, [dispute], { provider: provider([payload]) });
    const applied = applyAdjudications(encounters, adj);
    expect(applied.removed).toBe(0);
    expect(applied.unresolved).toBe(0);
  });

  it("an UNRESOLVED dispute is COUNTED rather than silently decided", async () => {
    const payload = JSON.stringify({ rulings: [{ issueIndex: 0, ruling: "UNRESOLVED", reason: "source is ambiguous" }] });
    const adj = await adjudicateDisputes(chunkOf(SOURCE), encounters, [dispute], { provider: provider([payload]) });
    const applied = applyAdjudications(encounters, adj);
    expect(applied.unresolved).toBe(1);
    expect(applied.removed).toBe(0); // the claim stands, but the case cannot pass audit
  });

  it("an adjudicator failure leaves disputes unresolved rather than guessing", async () => {
    const failing: LlmProvider = { name: "fake", complete: async () => { throw new Error("down"); } };
    const adj = await adjudicateDisputes(chunkOf(SOURCE), encounters, [dispute], { provider: failing });
    expect(adj[0].ruling).toBe("UNRESOLVED");
  });

  it("non-disputing findings (omissions) are not sent to adjudication", async () => {
    const omission: CriticIssue = { type: "MISSING_ENCOUNTER", encounterIndex: null, claimIndex: null, excerpt: null, detail: "missed one" };
    const adj = await adjudicateDisputes(chunkOf(SOURCE), encounters, [omission], { provider: provider(["{}"]) });
    expect(adj).toEqual([]);
  });
});
