// A record is not READ by scrolling raw quotes in extractor order.
//
// The card showed the first four claims as they arrived, which on a real note
// meant an account number, a medical-record number and two lines of garbled
// OCR — before a single clinical fact. Nothing may be dropped, because a
// signature covers all of it; the fix is order and separation.
//
// Synthetic data only.
import { describe, expect, it } from "vitest";
import { presentClaims, labelForField, type PresentableClaim } from "@/lib/records/claimPresentation";

const c = (field: string, excerpt = "text", over: Partial<PresentableClaim> = {}): PresentableClaim => ({ field, excerpt, page: 1, ...over });

describe("clinical assertions come before page text", () => {
  it("puts the assessment ahead of untyped page text, whatever order they arrived in", () => {
    const claims = [c("documentContent", "Acct Num: FV1000316180"), c("assessment", "Lumbar radiculopathy")];
    const { clinical, raw } = presentClaims(claims);
    expect(clinical.map((x) => x.field)).toEqual(["assessment"]);
    expect(raw.map((x) => x.field)).toEqual(["documentContent"]);
  });

  it("orders clinical fields the way a note is read, not alphabetically", () => {
    const claims = [c("disposition"), c("subjective"), c("assessment"), c("medications"), c("objectiveFindings")];
    const order = presentClaims(claims).clinical.map((x) => x.field);
    expect(order.indexOf("assessment")).toBeLessThan(order.indexOf("objectiveFindings"));
    expect(order.indexOf("objectiveFindings")).toBeLessThan(order.indexOf("subjective"));
    expect(order.indexOf("medications")).toBeLessThan(order.indexOf("disposition"));
  });

  it("keeps an unrecognised field visible, between the clinical set and page text", () => {
    const { clinical, raw } = presentClaims([c("documentContent"), c("somethingNew"), c("assessment")]);
    expect(clinical.map((x) => x.field)).toEqual(["assessment", "somethingNew"]);
    expect(raw).toHaveLength(1);
  });

  it("loses nothing — every quote is still there", () => {
    const claims = Array.from({ length: 318 }, (_, i) => c(i % 3 === 0 ? "documentContent" : "assessment", `q${i}`));
    const { clinical, raw } = presentClaims(claims);
    expect(clinical.length + raw.length).toBe(318);
  });

  it("preserves the extractor's order within one field", () => {
    const claims = [c("assessment", "first"), c("assessment", "second"), c("assessment", "third")];
    expect(presentClaims(claims).clinical.map((x) => x.excerpt)).toEqual(["first", "second", "third"]);
  });

  it("collects the quotes the extractor warned about", () => {
    const claims = [c("assessment"), c("subjective", "x", { warning: "low-confidence OCR" })];
    expect(presentClaims(claims).flagged).toHaveLength(1);
  });

  it("handles a note with no quotes at all", () => {
    expect(presentClaims([])).toEqual({ clinical: [], raw: [], flagged: [] });
  });
});

describe("field names are said the way a clinician says them", () => {
  it("labels the known fields", () => {
    expect(labelForField("objectiveFindings")).toBe("Examination");
    expect(labelForField("pastMedicalHistory")).toBe("Past medical history");
    expect(labelForField("documentContent")).toBe("Page text");
  });

  it("never shows a bare camelCase key", () => {
    expect(labelForField("someNewField")).toBe("Some New Field");
    expect(labelForField(null)).toBe("Quote");
  });
});
