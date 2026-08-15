// The critic is held to the SAME evidentiary standard as the extractor: it
// cannot invent an objection any more than the extractor can invent a finding.
// The adjudicator sees only the source and the disputes. Synthetic data only.
import { describe, it, expect } from "vitest";
import { chunkDocumentText, type DocumentChunk, type LlmEncounter } from "./recordExtraction";
import { runCritic, adjudicateDisputes, applyAdjudications, buildCriticPrompt, isDisputing, type CriticIssue } from "./extractionCritic";
import type { LlmProvider } from "@/lib/llm";

const META = { firmId: "firm-1", caseId: "case-1", sourceDocumentId: "doc-1", filename: "synthetic.pdf", ocrConfidence: 0.97, documentType: "MEDICAL_RECORD" };

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

describe("what the server settles without a model", () => {
  const dispute = (over: Partial<CriticIssue> = {}): CriticIssue =>
    ({ type: "UNSUPPORTED_CLAIM", encounterIndex: 0, claimIndex: 1, excerpt: null, detail: "the cited text does not support this", ...over }) as CriticIssue;

  const never = (): LlmProvider => ({ name: "fake", complete: async () => { throw new Error("must not be called"); } });

  it("discards a criticism that names a claim which does not exist", async () => {
    // It can neither remove anything nor confirm anything; counting it as an
    // unresolved source conflict punished the record for the critic's error.
    const out = await adjudicateDisputes(chunkOf(SOURCE), encounters, [dispute({ claimIndex: 47 })], { provider: never() });
    expect(out).toHaveLength(1);
    expect(out[0].ruling).toBe("DISCARDED");
    const applied = applyAdjudications(encounters, out);
    expect(applied.discarded).toBe(1);
    expect(applied.unresolved).toBe(0);
  });

  it("rejects a criticism quoting text the document does not contain", async () => {
    const out = await adjudicateDisputes(
      chunkOf(SOURCE),
      encounters,
      [dispute({ excerpt: "Patient underwent total knee arthroplasty on this date." })],
      { provider: never() },
    );
    expect(out[0].ruling).toBe("REJECTED");
    expect(out[0].reason).toMatch(/does not appear in the source/);
  });

  it("still asks about a criticism whose evidence IS in the source", async () => {
    const out = await adjudicateDisputes(
      chunkOf(SOURCE),
      encounters,
      [dispute({ excerpt: "Plan: Recommend epidural steroid injection at L4-L5." })],
      { provider: provider([JSON.stringify({ rulings: [{ issueIndex: 0, ruling: "UPHELD", reason: "the source recommends it" }] })]) },
    );
    expect(out[0].ruling).toBe("UPHELD");
  });
});

describe("one bad answer must not conflict a whole document", () => {
  const many = (n: number): CriticIssue[] =>
    Array.from({ length: n }, () => ({ type: "UNSUPPORTED_CLAIM", encounterIndex: 0, claimIndex: 1, excerpt: null, detail: "disputed" }) as CriticIssue);

  it("retries a malformed answer tersely before giving up on the batch", async () => {
    const out = await adjudicateDisputes(chunkOf(SOURCE), encounters, many(2), {
      provider: provider(["not json at all", JSON.stringify({ rulings: [{ issueIndex: 0, ruling: "REJECTED", reason: "stands" }, { issueIndex: 1, ruling: "REJECTED", reason: "stands" }] })]),
    });
    expect(out.map((o) => o.ruling)).toEqual(["REJECTED", "REJECTED"]);
  });

  it("confines an unparseable batch to itself", async () => {
    // 10 disputes = two batches. The first answers, the second never parses;
    // only the second batch may go unresolved.
    const good = JSON.stringify({ rulings: Array.from({ length: 8 }, (_, i) => ({ issueIndex: i, ruling: "REJECTED", reason: "stands" })) });
    const out = await adjudicateDisputes(chunkOf(SOURCE), encounters, many(10), { provider: provider([good, "garbage", "garbage"]) });
    expect(out.filter((o) => o.ruling === "REJECTED")).toHaveLength(8);
    expect(out.filter((o) => o.ruling === "UNRESOLVED")).toHaveLength(2);
  });
});

describe("an unresolved conflict belongs to its own entry", () => {
  it("attributes unresolved disputes by encounter, and counts unattributable ones apart", () => {
    const applied = applyAdjudications(encounters, [
      { issue: { type: "UNSUPPORTED_CLAIM", encounterIndex: 0, claimIndex: 1, excerpt: null, detail: "d" } as CriticIssue, ruling: "UNRESOLVED", reason: "source silent" },
      { issue: { type: "MISSING_ENCOUNTER", encounterIndex: null, claimIndex: null, excerpt: null, detail: "d" } as CriticIssue, ruling: "UNRESOLVED", reason: "source silent" },
    ]);
    expect(applied.unresolved).toBe(2);
    expect(applied.unresolvedByEncounter.get(0)).toBe(1);
    expect(applied.unresolvedUnattributed).toBe(1);
  });
});
