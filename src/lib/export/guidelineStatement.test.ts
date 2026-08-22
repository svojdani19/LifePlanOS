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
  verifiedItemSpecific: [],
  recordedGuidelineEvidence: [],
  genericSources: GENERIC,
  basisState: "CURRENT",
  retrieval: { status: "SUCCEEDED", failure: null },
  ...over,
});

describe("VERIFIED, item-specific guidance may be called applied", () => {
  const r = guidelineStatement(input({
    verifiedItemSpecific: [{ title: "NASS lumbar disc herniation with radiculopathy", claim: "discectomy after failed conservative care" }],
  }));

  it("states it as applied support, naming the guideline and its claim", () => {
    expect(r.state).toBe("APPLIED");
    expect(r.label).toBe("Guideline basis");
    expect(r.text).toContain("NASS lumbar disc herniation with radiculopathy");
    expect(r.text).toContain("discectomy after failed conservative care");
  });

  it("says the verification is what earns the claim", () => {
    expect(r.text).toMatch(/verified against its publication/i);
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
      input({ verifiedItemSpecific: [{ title: "T", claim: "C" }] }),
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
      verifiedItemSpecific: [{ title: "NASS", claim: "discectomy" }],
    }));
    expect(r.state).toBe("STALE_BASIS");
    expect(r.text).toMatch(/no longer matches the record/i);
    expect(r.text).not.toContain("NASS");
  });

  it("MISSING says there is no basis to cite from", () => {
    const r = guidelineStatement(input({ basisState: "MISSING", verifiedItemSpecific: [{ title: "NASS", claim: "discectomy" }] }));
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
      verifiedItemSpecific: [{ title: "NASS", claim: "discectomy" }],
    }));
    expect(r.state).toBe("RETRIEVAL_UNRESOLVED");
  });

  it("NO_RESULTS is a completed search and does not block the applied claim", () => {
    // "We looked and found nothing" is a real answer; it must not suppress
    // guidance that WAS verified and recorded for this item.
    const r = guidelineStatement(input({
      retrieval: { status: "NO_RESULTS", failure: null },
      verifiedItemSpecific: [{ title: "NASS", claim: "discectomy" }],
    }));
    expect(r.state).toBe("APPLIED");
  });

  it("a case with no retrieval record at all is treated as unremarkable", () => {
    expect(guidelineStatement(input({ retrieval: null, verifiedItemSpecific: [{ title: "T", claim: "C" }] })).state).toBe("APPLIED");
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
