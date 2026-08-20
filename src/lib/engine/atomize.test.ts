import { describe, it, expect } from "vitest";
import { atomize, dominantRegion, rendersValidatedAssertion, sha256 } from "@/lib/engine/atomize";
import { bodyRegion } from "@/lib/engine/integrity";

// The real field from the reference case, abridged. It is entirely a left-knee
// MRI report; it classified as "spine" and was displayed under a lumbar
// discectomy.
const KNEE_MRI =
  "Multiplanar magnetic resonance images of the left knee were obtained. The medial and lateral menisci were unremarkable. " +
  "The anterior and posterior cruciate ligaments were intact. Comparison was made with the prior lumbar spine study.";

describe("a long field cannot pass one assertion and display another", () => {
  it("reproduces the original misclassification, to show what is being fixed", () => {
    // One passing mention of the spine, in a knee report, decided the region —
    // because spine precedes knee in the pattern table.
    expect(bodyRegion(KNEE_MRI)).toBe("spine");
  });

  it("classifies each assertion on its own text", () => {
    const parts = atomize(KNEE_MRI);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts[0].region).toBe("knee"); // the sentence that used to be displayed
    expect(parts.filter((p) => p.region === "knee").length).toBeGreaterThanOrEqual(1);
  });

  it("reports the DOMINANT region rather than the first pattern to match", () => {
    expect(dominantRegion(KNEE_MRI)).toBe("knee");
  });

  it("binds the displayed string to the validated one", () => {
    const parts = atomize(KNEE_MRI);
    const shown = parts[0].text;
    expect(rendersValidatedAssertion(shown, parts[0])).toBe(true);
    // The old behaviour: gate the blob, display a truncated clause of it.
    expect(rendersValidatedAssertion(KNEE_MRI.slice(0, 180), parts[0])).toBe(false);
  });

  it("tolerates whitespace differences but not different content", () => {
    const parts = atomize(KNEE_MRI);
    expect(rendersValidatedAssertion(`  ${parts[0].text}  `, parts[0])).toBe(true);
    expect(rendersValidatedAssertion(parts[0].text + " and the spine", parts[0])).toBe(false);
  });
});

describe("splitting is conservative", () => {
  it("keeps a single finding whole", () => {
    const parts = atomize("The medial and lateral menisci were unremarkable, with no meniscal tear identified");
    expect(parts).toHaveLength(1);
  });

  it("separates independent findings", () => {
    const parts = atomize("No acute fracture. Mild degenerative change at L4-5.");
    expect(parts).toHaveLength(2);
    expect(parts[1].spinalLevels).toContain("lumbar");
  });

  it("treats an unpunctuated field as one assertion, not zero", () => {
    const parts = atomize("Positive straight leg raise on the right at 40 degrees");
    expect(parts).toHaveLength(1);
    expect(parts[0].laterality).toBe("right");
  });

  it("drops headers and administrative fragments", () => {
    const parts = atomize("EXAM: MRI LUMBAR SPINE. Page 3 of 12. There is a broad-based disc protrusion at L4-5.");
    // The record's own terminal punctuation is kept: the stored excerpt is
    // meant to be verbatim, not tidied.
    expect(parts.map((p) => p.text)).toEqual(["There is a broad-based disc protrusion at L4-5."]);
  });

  it("returns nothing for an empty field", () => {
    expect(atomize(null)).toEqual([]);
    expect(atomize("   ")).toEqual([]);
  });

  it("records the parent hash so a split is auditable", () => {
    const parts = atomize(KNEE_MRI);
    const parent = sha256(KNEE_MRI.replace(/\s+/g, " ").trim());
    expect(parts.every((p) => p.parentHash === parent)).toBe(true);
  });
});

describe("the noise filter removes labels, not clinical sentences", () => {
  it("keeps a finding that begins with a header word", () => {
    // "Patient reports…" is how a large share of functional findings are
    // written. Filtering the bare word deleted them all.
    expect(atomize("Patient reports pain with prolonged standing").map((p) => p.text))
      .toEqual(["Patient reports pain with prolonged standing"]);
    expect(atomize("Date of injury pain has worsened since").length).toBe(1);
  });

  it("still removes an actual label line", () => {
    expect(atomize("Patient: John Doe")).toEqual([]);
    expect(atomize("MRN: 4429183")).toEqual([]);
    expect(atomize("Page 3 of 12")).toEqual([]);
  });
});
