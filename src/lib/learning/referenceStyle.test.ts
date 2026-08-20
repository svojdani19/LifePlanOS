import { describe, it, expect } from "vitest";
import { deriveStyleProfile, assertFactFree, styleGuidance, FactLeakError, STYLE_PROFILE_VERSION, type StyleProfile } from "@/lib/learning/referenceStyle";

// Synthetic prose in the register of a finalized plan. No real patient content.
const sources = [
  {
    paragraphs: [
      "The claimant sustained a comminuted fracture with residual deformity. Imaging confirms post-traumatic degenerative change. As a result of that pathology, stair negotiation is limited.",
      "Ongoing interventional management is anticipated. Given the documented course, periodic specialist review is required. To that end, an annual evaluation is included.",
    ],
    sections: ["Medical Summary", "Future Care", "Cost Analysis"],
    leadClauses: ["impression", "impression", "objective", "plan"],
  },
  {
    paragraphs: [
      "Chronic radicular symptoms persist despite conservative measures. Secondary to the documented lesion, injection therapy is anticipated. Taken together, the record supports continued care.",
    ],
    sections: ["Medical Summary", "Future Care", "Vocational Impact"],
    leadClauses: ["impression", "objective"],
  },
];

describe("a style profile carries no patient facts, by construction", () => {
  it("derives concision, voice and lead-clause structure", () => {
    const p = deriveStyleProfile(sources);
    expect(p.version).toBe(STYLE_PROFILE_VERSION);
    expect(p.medianSentenceWords).toBeGreaterThan(3);
    expect(p.medianParagraphSentences).toBeGreaterThanOrEqual(1);
    expect(p.leadClauseDistribution[0].label).toBe("impression");
    expect(p.sampleSize).toBe(2);
  });

  it("keeps only headings that recur across plans", () => {
    const p = deriveStyleProfile(sources);
    expect(p.sectionOrder).toContain("medical_summary");
    expect(p.sectionOrder).toContain("future_care");
    // Seen once, so it could be case-specific.
    expect(p.sectionOrder).not.toContain("vocational");
    expect(p.sectionOrder).not.toContain("cost_analysis");
  });

  it("learns argument connectives, which carry structure rather than content", () => {
    const p = deriveStyleProfile(sources);
    const phrases = p.connectives.map((c) => c.phrase);
    expect(phrases).toContain("as a result of");
    expect(phrases).toContain("secondary to");
  });

  it("contains no sentence from any source plan", () => {
    const p = deriveStyleProfile(sources);
    const blob = JSON.stringify(p);
    for (const s of sources) for (const para of s.paragraphs) {
      for (const sentence of para.split(/(?<=[.])\s+/)) {
        expect(blob).not.toContain(sentence.slice(0, 30));
      }
    }
  });
});

describe("the fact-free guarantee is enforced, not assumed", () => {
  const base: StyleProfile = {
    version: STYLE_PROFILE_VERSION, medianSentenceWords: 14, medianParagraphSentences: 3,
    passiveShare: 0.3, clinicalLeadShare: 0.7, leadClauseDistribution: [], sectionOrder: [], connectives: [], sampleSize: 1,
  };

  it("refuses a date or identifier", () => {
    expect(() => assertFactFree({ ...base, sectionOrder: ["Encounter 06/12/2024"] as never })).toThrow(FactLeakError);
    expect(() => assertFactFree({ ...base, connectives: [{ phrase: "MRN 4429183", perThousandWords: 1 }] })).toThrow(FactLeakError);
  });

  it("refuses a proper noun — a name, a facility, a product", () => {
    expect(() => assertFactFree({ ...base, sectionOrder: ["Memorial Hermann"] as never })).toThrow(/proper noun/);
  });

  it("refuses anything long enough to be a sentence from a plan", () => {
    expect(() => assertFactFree({ ...base, connectives: [{ phrase: "the claimant will require lifelong attendant care per the treating physiatrist", perThousandWords: 1 }] }))
      .toThrow(/long enough to be a sentence/);
  });

  it("refuses rather than sanitises — a near-miss is worse than a rejection", () => {
    // Stripping the offending token would leave a profile that LOOKS clean and
    // came from contaminated input.
    let thrown: unknown = null;
    try { assertFactFree({ ...base, sectionOrder: ["Encounter 06/12/2024"] as never }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(FactLeakError);
  });

  it("passes a genuinely fact-free profile", () => {
    expect(() => assertFactFree({ ...base, sectionOrder: ["future_care"], connectives: [{ phrase: "as a result of", perThousandWords: 2 }] })).not.toThrow();
  });
});

describe("guidance is actionable and still fact-free", () => {
  it("turns the profile into instructions a narrator can follow", () => {
    const g = styleGuidance(deriveStyleProfile(sources));
    expect(g.join(" ")).toMatch(/words per sentence/);
    expect(g.length).toBeGreaterThan(1);
  });

  it("emits nothing patient-specific", () => {
    const g = styleGuidance(deriveStyleProfile(sources)).join(" ");
    expect(g).not.toMatch(/\d{2,}\/|claimant sustained|comminuted/);
  });
});
