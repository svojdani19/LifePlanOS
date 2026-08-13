import { describe, expect, it } from "vitest";
import { authoritativeFacts, claimDiscrepancies, isHumanAuthored } from "@/lib/records/humanAuthority";

const row = (over: Record<string, unknown> = {}) => ({
  status: "AI_DRAFT",
  factualSummary: "Machine-written summary of the visit.",
  ...over,
});

describe("whose work governs a record", () => {
  it("treats an edited, reviewed or verified row as human-authored", () => {
    for (const status of ["HUMAN_EDITED", "REVIEWED", "VERIFIED"]) {
      expect(isHumanAuthored({ status })).toBe(true);
    }
  });

  it("does not treat the program agreeing with itself as review", () => {
    // An adversarial audit passing is the program's own opinion. Counting it as
    // review would let a case present unreviewed content as reviewed.
    expect(isHumanAuthored({ status: "AI_AUDIT_PASSED" })).toBe(false);
    expect(isHumanAuthored({ status: "AI_DRAFT" })).toBe(false);
  });
});

describe("preserving a physician's corrections through a rebuild", () => {
  it("keeps an edited summary exactly, character for character", () => {
    // This is the failure that mattered: a correction survived until the next
    // document finished processing, then the case rebuilt and replaced it with
    // newly phrased prose that looked just as confident.
    const corrected = "Patient reported worsening right-leg radicular pain; MRI confirmed L5-S1 protrusion.";
    const facts = authoritativeFacts([row({ status: "HUMAN_EDITED", factualSummary: corrected })]);
    expect(facts?.summary).toBe(corrected);
  });

  it("keeps every corrected field", () => {
    const facts = authoritativeFacts([
      row({
        status: "REVIEWED",
        encounterDate: new Date("2024-03-15T00:00:00Z"),
        provider: "Fernando Techy",
        providerCredentials: "MD, FACS",
        facility: "East Houston Hospital",
        encounterType: "Operative report",
        analysisClass: "OPERATIVE",
        substanceClass: "CLINICAL",
      }),
    ]);
    expect(facts).toMatchObject({
      provider: "Fernando Techy",
      providerCredentials: "MD, FACS",
      facility: "East Houston Hospital",
      encounterType: "Operative report",
      analysisClass: "OPERATIVE",
      substanceClass: "CLINICAL",
    });
    expect(facts?.encounterDate?.toISOString().slice(0, 10)).toBe("2024-03-15");
  });

  it("keeps a reviewer's classification rather than recomputing the AI's", () => {
    // A reviewer calling something administrative must not be argued with by
    // the next rebuild.
    const facts = authoritativeFacts([row({ status: "HUMAN_EDITED", substanceClass: "ADMINISTRATIVE" })]);
    expect(facts?.substanceClass).toBe("ADMINISTRATIVE");
  });

  it("carries the verification hash so lineage survives", () => {
    const facts = authoritativeFacts([row({ status: "VERIFIED", verifiedContentHash: "sha256:abc123" })]);
    expect(facts?.verifiedContentHash).toBe("sha256:abc123");
  });

  it("returns nothing when no row was touched by a human", () => {
    expect(authoritativeFacts([row(), row({ status: "AI_AUDIT_PASSED" })])).toBeNull();
  });

  it("lets the most strongly reviewed row govern", () => {
    // An entry absorbs several rows and only some are reviewed.
    const facts = authoritativeFacts([
      row({ status: "HUMAN_EDITED", factualSummary: "Edited wording." }),
      row({ status: "VERIFIED", factualSummary: "Verified wording." }),
    ]);
    expect(facts?.summary).toBe("Verified wording.");
    expect(facts?.states).toContain("HUMAN_EDITED");
  });

  it("does not treat a cleared field as authored emptiness", () => {
    // A reviewer who blanked a summary did not thereby write an empty one.
    const facts = authoritativeFacts([row({ status: "REVIEWED", factualSummary: "   " })]);
    expect(facts?.summary).toBeNull();
  });
});

describe("when the source disagrees with the correction", () => {
  it("surfaces a claim the human summary does not account for", () => {
    // Raised for review, never acted on. Possibly the reviewer trimmed noise;
    // possibly the extractor found something they had not seen. What must not
    // happen is the program deciding the human was wrong.
    const missed = claimDiscrepancies("Patient reported low back pain and was discharged home.", [
      { field: "subjective", value: "Patient reported low back pain" },
      { field: "procedure", value: "Lumbar epidural steroid injection administered under fluoroscopy" },
    ]);
    expect(missed).toHaveLength(1);
    expect(missed[0].field).toBe("procedure");
  });

  it("does not flag a claim the summary merely condensed", () => {
    const missed = claimDiscrepancies("MRI confirmed an L5-S1 disc protrusion with radiculopathy.", [
      { field: "impression", value: "MRI lumbar spine: L5-S1 disc protrusion" },
    ]);
    expect(missed).toHaveLength(0);
  });

  it("stays bounded on a record carrying many claims", () => {
    const claims = Array.from({ length: 200 }, (_, i) => ({ field: "procedure", value: `Unrelated procedure ${i} performed` }));
    expect(claimDiscrepancies("Summary mentioning nothing.", claims).length).toBeLessThanOrEqual(10);
  });
});
