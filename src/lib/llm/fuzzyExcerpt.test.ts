import { describe, expect, it } from "vitest";
import { fuzzyIncludes } from "@/lib/llm/recordExtraction";

// On a real billing production, whole encounters died with "no claims survived
// validation": the model quoted the page faithfully, the OCR text differed by
// a few scanner artifacts, and exact inclusion failed on furniture.

const PAGE =
  "office visit established patient 99213 billed 10 19 2023 visit 1788972 provider radiology providers of texas amount charged 350 00 for services rendered";

describe("matching an excerpt the scanner corrupted", () => {
  it("still matches within a mean edit budget", () => {
    // Two OCR artifacts: "vlsit" for "visit", "blled" for "billed".
    expect(fuzzyIncludes(PAGE, "office vlsit established patient 99213 blled 10 19 2023")).toBe(true);
  });

  it("does not match text that differs in substance", () => {
    expect(fuzzyIncludes(PAGE, "office visit established patient 99215 billed 11 27 2024 charge 900")).toBe(false);
  });

  it("never fuzzy-matches a short excerpt", () => {
    // A short string within a few edits of something else is a coincidence,
    // not a citation.
    expect(fuzzyIncludes(PAGE, "office visyt")).toBe(false);
  });

  it("fails an excerpt mangled beyond a reviewer's eye", () => {
    expect(fuzzyIncludes(PAGE, "ofice vsit estblished patent 9x213 biled 1x 1x 2x23 vist 17x8972")).toBe(false);
  });

  it("matches a clean excerpt trivially", () => {
    expect(fuzzyIncludes(PAGE, "established patient 99213 billed 10 19 2023")).toBe(true);
  });
});
