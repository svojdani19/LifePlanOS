import { describe, it, expect } from "vitest";
import { locateConditionEvidence } from "./evidence";

const docs = [
  {
    id: "d1",
    filename: "mri.pdf",
    type: "IMAGING_REPORT",
    extractedText:
      "MRI OF THE LUMBAR SPINE\nPage 1 of 2\nTECHNIQUE: Multiplanar imaging.\nPage 2 of 2\nFINDINGS: L1 burst fracture with retropulsion and canal compromise. No cord signal abnormality.\nIMPRESSION: Acute L1 burst fracture.",
  },
  {
    id: "d2",
    filename: "op.pdf",
    type: "OPERATIVE_NOTE",
    extractedText:
      "OPERATIVE REPORT\nPage 1 of 1\nPREOPERATIVE DIAGNOSIS: Displaced tibial plateau fracture, left knee.\nPROCEDURE PERFORMED: Open reduction internal fixation, left tibial plateau.",
  },
  {
    id: "d3",
    filename: "billing.pdf",
    type: "BILLING_RECORD",
    extractedText: "EXPLANATION OF BENEFITS. Charges for L1 burst fracture treatment. CPT 22842.",
  },
];

describe("locateConditionEvidence", () => {
  it("finds the document, page, and quote where a diagnosis is documented", () => {
    const s = locateConditionEvidence(docs, "L1 burst fracture with incomplete SCI");
    expect(s.length).toBeGreaterThan(0);
    expect(s[0].documentId).toBe("d1");
    expect(s[0].page).toBe(2); // finding appears after the "Page 2 of 2" marker
    expect(s[0].quote.toLowerCase()).toContain("burst fracture");
  });

  it("does not attribute evidence to the wrong diagnosis via a generic shared word", () => {
    const s = locateConditionEvidence(docs, "Fracture of tibial plateau");
    expect(s.every((x) => x.documentId === "d2")).toBe(true); // never the lumbar MRI
    expect(s[0].quote.toLowerCase()).toContain("tibial plateau");
  });

  it("never cites administrative/legal records as clinical evidence", () => {
    const s = locateConditionEvidence(docs, "L1 burst fracture");
    expect(s.some((x) => x.documentId === "d3")).toBe(false);
  });

  it("returns [] when the records do not document the condition", () => {
    expect(locateConditionEvidence(docs, "Rotator cuff tear of the shoulder")).toHaveLength(0);
  });
});
