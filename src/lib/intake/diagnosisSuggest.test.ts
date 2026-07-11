import { describe, it, expect } from "vitest";
import { suggestDiagnoses } from "./diagnosisSuggest";

const docs = [
  { filename: "op.pdf", extractedText: "PROCEDURE PERFORMED: Open reduction internal fixation, left tibial plateau. PREOPERATIVE DIAGNOSIS: Displaced tibial plateau fracture." },
  { filename: "mri.pdf", extractedText: "IMPRESSION: Acute L1 burst fracture with retropulsion and canal compromise." },
  { filename: "er.pdf", extractedText: "CHIEF COMPLAINT: Back pain after motor vehicle collision. PAST MEDICAL HISTORY: chronic migraine, peripheral neuropathy." },
];

describe("suggestDiagnoses", () => {
  it("suggests diagnoses found in clinical content with sources", () => {
    const s = suggestDiagnoses(docs, []);
    const names = s.map((x) => x.diagnosis);
    expect(names).toContain("Fracture of tibial plateau");
    expect(names).toContain("Burst fracture of first lumbar vertebra");
    expect(s.find((x) => x.diagnosis === "Fracture of tibial plateau")!.sources).toEqual(["op.pdf"]);
  });

  it("does NOT suggest conditions that only appear in past medical history", () => {
    const names = suggestDiagnoses(docs, []).map((x) => x.diagnosis);
    expect(names).not.toContain("Post-traumatic headache");
    expect(names).not.toContain("Post-traumatic peripheral neuropathy");
  });

  it("excludes diagnoses already on the case by ICD-10 code", () => {
    const s = suggestDiagnoses(docs, [{ diagnosis: "something", icd10Code: "S82.101A" }]);
    expect(s.map((x) => x.diagnosis)).not.toContain("Fracture of tibial plateau");
  });

  it("excludes diagnoses already on the case by wording overlap", () => {
    const s = suggestDiagnoses(docs, [{ diagnosis: "Burst fracture of L1 lumbar vertebra", icd10Code: "S32.010A" }]);
    expect(s.map((x) => x.diagnosis)).not.toContain("Burst fracture of first lumbar vertebra");
  });

  it("returns nothing for empty/near-empty records", () => {
    expect(suggestDiagnoses([{ filename: "x.pdf", extractedText: "[illegible]" }], [])).toHaveLength(0);
  });
});
