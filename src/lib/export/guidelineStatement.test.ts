// What the report may claim about guideline support.
//
// It printed a category-and-region lookup — ODG plus whichever specialty bodies
// plausibly cover the area — and said they were "applied to determine whether
// this care is medically necessary now or in the future". The list is derived
// from the service category, not from the patient; nobody had checked that any
// of those bodies says anything about this pairing; and every row of the
// mapping table ships UNVERIFIED. A defence expert reads "ODG applied" as a
// checkable claim.

import { describe, it, expect } from "vitest";
import { guidelineStatement, type GuidelineStatementInput } from "@/lib/export/guidelineStatement";

const GENERIC = ["ODG (ODGbyMCG) treatment guidelines", "Orthobullets clinical guidance", "ICSI clinical guidelines"];

const input = (over: Partial<GuidelineStatementInput> = {}): GuidelineStatementInput => ({
  itemGuidance: [],
  recordedGuidelineEvidence: [],
  genericSources: GENERIC,
  basisState: "CURRENT",
  retrieval: { status: "SUCCEEDED", failure: null },
  ...over,
});

describe("VERIFIED, item-specific guidance may be called applied", () => {
  const r = guidelineStatement(input({
    itemGuidance: [{ title: "NASS lumbar disc herniation with radiculopathy", claim: "discectomy after failed conservative care", provenance: "PHYSICIAN_VERIFIED", verifiedBy: "Dr Reyes, MD", verifiedAt: "2026-05-04T00:00:00.000Z" }],
  }));

  it("states it as applied support, naming the guideline and its claim", () => {
    expect(r.state).toBe("APPLIED");
    expect(r.label).toBe("Guideline basis");
    expect(r.text).toContain("NASS lumbar disc herniation with radiculopathy");
    expect(r.text).toContain("discectomy after failed conservative care");
  });

  it("says the verification is what earns the claim", () => {
    expect(r.text).toMatch(/read against its publication and confirmed/i);
    expect(r.text).toMatch(/recorded in this recommendation's basis/i);
  });

  it("does not pad the item-specific claim with the generic list", () => {
    // Substituting a category lookup for item-specific support is the defect.
    for (const g of GENERIC) expect(r.text).not.toContain(g);
  });
});

describe("UNVERIFIED mappings stay visible, and stay out of the support claim", () => {
  const r = guidelineStatement(input({
    recordedGuidelineEvidence: [{ text: "ODG addresses lumbar fusion for spondylolisthesis", source: "indication mapping" }],
  }));

  it("is labelled a review candidate, not a basis", () => {
    expect(r.state).toBe("REVIEW_CANDIDATE");
    expect(r.label).toBe("Guideline review candidates");
  });

  it("is preserved rather than deleted — a physician may want to check it", () => {
    expect(r.text).toContain("ODG addresses lumbar fusion for spondylolisthesis");
  });

  it("says plainly that it is not relied upon", () => {
    expect(r.text).toMatch(/not been verified against their publications/i);
    expect(r.text).toMatch(/not relied upon as support for medical necessity/i);
  });

  it("never uses the language of applied evidence", () => {
    expect(r.text).not.toMatch(/\bapplied to determine\b/i);
    expect(r.text).not.toMatch(/\bsupports medical necessity\b/i);
  });
});

describe("a generic list is never a substitute for item-specific support", () => {
  it("with no recorded guidance at all, it says so and marks the list as context", () => {
    const r = guidelineStatement(input());
    expect(r.state).toBe("NONE");
    expect(r.text).toMatch(/no verified, item-specific guideline support is recorded/i);
    expect(r.text).toMatch(/listed as context and are not item-specific support/i);
  });

  it("says nothing at all when there is nothing to say", () => {
    const r = guidelineStatement(input({ genericSources: [] }));
    expect(r.state).toBe("NONE");
    expect(r.text).not.toMatch(/context/i);
  });

  it("the old sentence appears in no state", () => {
    const states: GuidelineStatementInput[] = [
      input(),
      input({ itemGuidance: [{ title: "T", claim: "C", provenance: "PHYSICIAN_VERIFIED", verifiedBy: "Dr Reyes, MD", verifiedAt: "2026-05-04T00:00:00.000Z" }] }),
      input({ recordedGuidelineEvidence: [{ text: "X", source: null }] }),
      input({ basisState: "STALE" }),
      input({ basisState: "MISSING" }),
      input({ retrieval: { status: "FAILED", failure: "UNREACHABLE" } }),
      input({ retrieval: { status: "NOT_ATTEMPTED", failure: "AUTH" } }),
    ];
    for (const s of states) {
      expect(guidelineStatement(s).text).not.toMatch(/applied to determine whether this care is medically necessary/i);
    }
  });
});

describe("a basis that no longer matches cannot lend its guidance", () => {
  it("STALE refuses the applied claim even when verified guidance is recorded", () => {
    // The verified guidance was verified for a plan that has since moved.
    const r = guidelineStatement(input({
      basisState: "STALE",
      itemGuidance: [{ title: "NASS", claim: "discectomy", provenance: "PHYSICIAN_VERIFIED", verifiedBy: "Dr Reyes, MD", verifiedAt: "2026-05-04T00:00:00.000Z" }],
    }));
    expect(r.state).toBe("STALE_BASIS");
    expect(r.text).toMatch(/no longer matches the record/i);
    expect(r.text).not.toContain("NASS");
  });

  it("MISSING says there is no basis to cite from", () => {
    const r = guidelineStatement(input({ basisState: "MISSING", itemGuidance: [{ title: "NASS", claim: "discectomy", provenance: "PHYSICIAN_VERIFIED", verifiedBy: "Dr Reyes, MD", verifiedAt: "2026-05-04T00:00:00.000Z" }] }));
    expect(r.state).toBe("STALE_BASIS");
    expect(r.text).toMatch(/no recorded basis exists/i);
  });
});

describe("an unresolved search supports neither presence nor absence", () => {
  it.each([
    ["FAILED", "UNREACHABLE"],
    ["NOT_ATTEMPTED", "AUTH"],
  ])("%s makes no statement about whether guidance applies", (status, failure) => {
    const r = guidelineStatement(input({ retrieval: { status, failure } }));
    expect(r.state).toBe("RETRIEVAL_UNRESOLVED");
    expect(r.text).toMatch(/did not complete/i);
    expect(r.text).toMatch(/no statement is made/i);
  });

  it("names the cause so the reader knows which system failed", () => {
    expect(guidelineStatement(input({ retrieval: { status: "FAILED", failure: "RATE_LIMITED" } })).text).toMatch(/rate limited/i);
  });

  it("outranks verified guidance — the record cannot be trusted to be complete", () => {
    const r = guidelineStatement(input({
      retrieval: { status: "FAILED", failure: "UNREACHABLE" },
      itemGuidance: [{ title: "NASS", claim: "discectomy", provenance: "PHYSICIAN_VERIFIED", verifiedBy: "Dr Reyes, MD", verifiedAt: "2026-05-04T00:00:00.000Z" }],
    }));
    expect(r.state).toBe("RETRIEVAL_UNRESOLVED");
  });

  it("NO_RESULTS is a completed search and does not block the applied claim", () => {
    // "We looked and found nothing" is a real answer; it must not suppress
    // guidance that WAS verified and recorded for this item.
    const r = guidelineStatement(input({
      retrieval: { status: "NO_RESULTS", failure: null },
      itemGuidance: [{ title: "NASS", claim: "discectomy", provenance: "PHYSICIAN_VERIFIED", verifiedBy: "Dr Reyes, MD", verifiedAt: "2026-05-04T00:00:00.000Z" }],
    }));
    expect(r.state).toBe("APPLIED");
  });

  it("a case with no retrieval record at all is treated as unremarkable", () => {
    expect(guidelineStatement(input({ retrieval: null, itemGuidance: [{ title: "T", claim: "C", provenance: "PHYSICIAN_VERIFIED", verifiedBy: "Dr Reyes, MD", verifiedAt: "2026-05-04T00:00:00.000Z" }] })).state).toBe("APPLIED");
  });
});

describe("the report renders whatever this decides", () => {
  it("the report calls the decision rather than formatting its own line", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "report.ts"), "utf8");
    expect(src).toMatch(/guidelineStatement\(\{/);
    // And no longer hand-builds the applied sentence anywhere.
    expect(src).not.toMatch(/applied to determine whether this care is medically necessary/);
  });
});

describe("a partial retrieval is disclosed in the report, not hidden", () => {
  const partial = { status: "PARTIAL", failure: "TIMEOUT", failedSources: ["crossref:TIMEOUT"] };

  it("keeps verified support AND states the narrower coverage", () => {
    // The results are real. What is unknown is what the unreachable source
    // would have added, and that must not read as a complete search.
    const r = guidelineStatement(input({ retrieval: partial, itemGuidance: [{ title: "NASS", claim: "discectomy", provenance: "PHYSICIAN_VERIFIED", verifiedBy: "Dr Reyes, MD", verifiedAt: "2026-05-04T00:00:00.000Z" }] }));
    expect(r.state).toBe("APPLIED");
    expect(r.text).toContain("NASS");
    expect(r.text).toMatch(/could not be reached/i);
    expect(r.text).toMatch(/crossref:TIMEOUT/);
    expect(r.text).toMatch(/not evidence that no further guidance exists/i);
  });

  it("discloses it on an unverified pairing too", () => {
    const r = guidelineStatement(input({ retrieval: partial, recordedGuidelineEvidence: [{ text: "ODG mapping", source: null }] }));
    expect(r.state).toBe("REVIEW_CANDIDATE");
    expect(r.text).toMatch(/could not be reached/i);
  });

  it("discloses it when nothing item-specific was found", () => {
    const r = guidelineStatement(input({ retrieval: partial }));
    expect(r.state).toBe("NONE");
    expect(r.text).toMatch(/could not be reached/i);
  });

  it("a clean SUCCEEDED run says nothing about unreachable sources", () => {
    const r = guidelineStatement(input({ itemGuidance: [{ title: "NASS", claim: "discectomy", provenance: "PHYSICIAN_VERIFIED", verifiedBy: "Dr Reyes, MD", verifiedAt: "2026-05-04T00:00:00.000Z" }] }));
    expect(r.text).not.toMatch(/could not be reached/i);
  });

  it("does not downgrade a partial run to an unresolved one", () => {
    // PARTIAL is not FAILED: real guidance was retrieved and may be relied on.
    expect(guidelineStatement(input({ retrieval: partial })).state).not.toBe("RETRIEVAL_UNRESOLVED");
  });
});

describe("auto-retrieved guidance can never be called verified", () => {
  // supportingGuidelineAssessments is built from the standard-of-care search:
  // real, resolvable documents returned for this diagnosis and service, with a
  // hardcoded claim string. The report passed them to a parameter named
  // "verified" and printed "Each was verified against its publication" — a
  // statement about human verification that nothing in the pipeline performs.
  const auto = [{ title: "AAOS surgical management of knee osteoarthritis (2021)", claim: "returned by a guidance search for this diagnosis and service", provenance: "AUTO_RETRIEVED" }];

  it("renders as a retrieved candidate, not as applied support", () => {
    const r = guidelineStatement(input({ itemGuidance: auto }));
    expect(r.state).toBe("RETRIEVED_CANDIDATE");
    expect(r.label).toBe("Guidance retrieved for review");
  });

  it("never says verified, confirmed, or applied", () => {
    const t = guidelineStatement(input({ itemGuidance: auto })).text;
    expect(t).not.toMatch(/verified against its publication/i);
    expect(t).not.toMatch(/read against its publication/i);
    expect(t).not.toMatch(/\bapplied to determine\b/i);
  });

  it("says what IS known and what is not", () => {
    const t = guidelineStatement(input({ itemGuidance: auto })).text;
    expect(t).toMatch(/returned by a guidance search/i);
    expect(t).toMatch(/nobody has confirmed/i);
    expect(t).toMatch(/not cited as support for medical necessity/i);
  });

  it("still shows the document, because a physician may want to read it", () => {
    expect(guidelineStatement(input({ itemGuidance: auto })).text).toContain("AAOS surgical management of knee osteoarthritis (2021)");
  });

  it.each(["AUTO_RETRIEVED", "", "unknown", "RETRIEVED", "verified", "PHYSICIAN_VERIFIED "])(
    "provenance %o does not earn the verified language",
    (provenance) => {
      // Anything that is not exactly PHYSICIAN_VERIFIED fails closed.
      const r = guidelineStatement(input({ itemGuidance: [{ title: "T", claim: "C", provenance }] }));
      expect(r.state).not.toBe("APPLIED");
    },
  );

  it("a mixed set cites only the verified entry", () => {
    const r = guidelineStatement(input({
      itemGuidance: [
        ...auto,
        { title: "NASS lumbar disc herniation with radiculopathy", claim: "discectomy after failed conservative care", provenance: "PHYSICIAN_VERIFIED", verifiedBy: "Dr Reyes, MD", verifiedAt: "2026-05-04T00:00:00.000Z" },
      ],
    }));
    expect(r.state).toBe("APPLIED");
    expect(r.text).toContain("NASS lumbar disc herniation with radiculopathy");
    expect(r.text).not.toContain("AAOS surgical management");
  });

  it("names who verified it and when, so the claim is checkable", () => {
    const r = guidelineStatement(input({
      itemGuidance: [{ title: "NASS", claim: "discectomy", provenance: "PHYSICIAN_VERIFIED", verifiedBy: "Dr Reyes, MD", verifiedAt: "2026-05-04T00:00:00.000Z" }],
    }));
    expect(r.text).toContain("Dr Reyes, MD");
    expect(r.text).toContain("2026-05-04");
  });
});

describe("the engine marks its own guidance as retrieved", () => {
  it("emits AUTO_RETRIEVED and a claim that only says what happened", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "..", "engine", "clinicalReasoning.ts"), "utf8");
    expect(src).toMatch(/provenance: "AUTO_RETRIEVED" as const/);
    expect(src).toMatch(/returned by a guidance search for this diagnosis and service/);
    // The old claim asserted a conclusion nothing reaches.
    expect(src).not.toMatch(/claim: "supports the diagnosis and the intervention"/);
  });

  it("literature stays a separate channel from guidelines", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "report.ts"), "utf8");
    // The literature block renders from recordedBasis.literature; the guideline
    // statement never draws on it.
    expect(src).toMatch(/const rLiterature = \(noBasis \? dossier\.literature : V\.literature/);
    const gs = readFileSync(join(__dirname, "guidelineStatement.ts"), "utf8");
    expect(gs).not.toMatch(/literature/i);
  });
});
