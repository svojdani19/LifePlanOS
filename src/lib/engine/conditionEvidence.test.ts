// ─────────────────────────────────────────────────────────────────────────────
// "Objective evidence: See medical records." is not evidence. It is an
// instruction to go and look, printed in the field where the justification for
// a causation opinion belongs — and it survived because the text locator found
// nothing citable and nothing replaced the placeholder.
//
// A causation finding is now backed by a real quote, or by an explicit
// statement that no finding was located. There is no third option.
//
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { locateConditionEvidenceInClaims, stateObjectiveEvidence, type EncounterLike } from "@/lib/engine/conditionEvidence";

const files = new Map([["doc-1", "Clinic Notes.pdf"], ["doc-2", "Imaging.pdf"]]);

const enc = (documentId: string, claims: { field: string; value?: string; excerpt?: string; page?: number }[], date = "2025-03-14"): EncounterLike => ({
  sourceDocumentId: documentId,
  encounterDate: new Date(`${date}T00:00:00Z`),
  claims,
});

describe("a causation finding is backed by a real recorded finding", () => {
  it("finds the clinician's own assessment — the quote the text locator threw away", () => {
    // The live failure: "Chronic Pain Syndrome" is a short, generic-looking
    // line that the sentence grep discarded, while the extraction pipeline had
    // it typed as an assessment all along.
    const rows = [enc("doc-1", [{ field: "assessment", value: "Chronic Pain Syndrome", excerpt: "Chronic Pain Syndrome", page: 1 }])];
    const found = locateConditionEvidenceInClaims(rows, files, "Chronic pain syndrome");
    expect(found).toHaveLength(1);
    expect(found[0].strength).toBe("DIAGNOSIS");
    expect(found[0].page).toBe(1);
  });

  it("ranks a diagnosis above an objective finding, and both above history", () => {
    const rows = [
      enc("doc-1", [{ field: "pastMedicalHistory", excerpt: "Chronic pain syndrome", page: 3 }]),
      enc("doc-2", [{ field: "diagnosticStudies", excerpt: "MRI consistent with chronic pain syndrome", page: 9 }]),
      enc("doc-1", [{ field: "assessment", excerpt: "Assessment: chronic pain syndrome", page: 1 }], "2025-04-01"),
    ];
    expect(locateConditionEvidenceInClaims(rows, files, "Chronic pain syndrome").map((e) => e.strength)).toEqual([
      "DIAGNOSIS",
      "OBJECTIVE",
      "HISTORY",
    ]);
  });

  it("never quotes a negated mention as support", () => {
    const rows = [enc("doc-1", [{ field: "assessment", excerpt: "No evidence of chronic pain syndrome", page: 2 }])];
    expect(locateConditionEvidenceInClaims(rows, files, "Chronic pain syndrome")).toHaveLength(0);
  });

  it("does not attach a quote to a different diagnosis on a generic word alone", () => {
    const rows = [enc("doc-1", [{ field: "assessment", excerpt: "Assessment: shoulder pain", page: 1 }])];
    expect(locateConditionEvidenceInClaims(rows, files, "Chronic pain syndrome")).toHaveLength(0);
  });

  it("ignores untyped page text — an account number is not causation evidence", () => {
    const rows = [enc("doc-1", [{ field: "documentContent", excerpt: "chronic pain syndrome billing code", page: 4 }])];
    expect(locateConditionEvidenceInClaims(rows, files, "Chronic pain syndrome")).toHaveLength(0);
  });

  it("does not print the same diagnosis twelve times because it was recorded at twelve visits", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      enc("doc-1", [{ field: "assessment", excerpt: "Assessment: chronic pain syndrome", page: i + 1 }], `2025-0${(i % 9) + 1}-01`),
    );
    expect(locateConditionEvidenceInClaims(rows, files, "Chronic pain syndrome")).toHaveLength(1);
  });
});

describe("what the card says when there is nothing to quote", () => {
  const NAME = "Chronic pain syndrome";

  it("quotes the strongest supporting finding when one exists", () => {
    const rows = [enc("doc-1", [{ field: "assessment", excerpt: "Assessment: chronic pain syndrome", page: 1 }])];
    const stated = stateObjectiveEvidence(locateConditionEvidenceInClaims(rows, files, NAME), NAME);
    expect(stated.supported).toBe(true);
    expect(stated.objectiveEvidence).toMatch(/assessment, Clinic Notes\.pdf, p\. 1/);
    expect(stated.missingInfo).toBeNull();
  });

  it("never says 'see medical records', in any branch", () => {
    const cases = [
      [enc("doc-1", [{ field: "assessment", excerpt: "Assessment: chronic pain syndrome", page: 1 }])],
      [enc("doc-1", [{ field: "pastMedicalHistory", excerpt: "PMH: chronic pain syndrome", page: 3 }])],
      [enc("doc-1", [{ field: "subjective", excerpt: "Reports chronic pain syndrome", page: 2 }])],
      [],
    ];
    for (const rows of cases) {
      const stated = stateObjectiveEvidence(locateConditionEvidenceInClaims(rows, files, NAME), NAME);
      expect(stated.objectiveEvidence, JSON.stringify(rows)).not.toMatch(/see medical records/i);
      expect(stated.objectiveEvidence.length).toBeGreaterThan(20);
    }
  });

  it("will not let past medical history stand as support for an injury-related finding", () => {
    // A condition in the PMH argues it PRE-DATES the incident. Quoting it as
    // objective evidence would look supported and be backwards.
    const rows = [enc("doc-1", [{ field: "pastMedicalHistory", excerpt: "PMH: chronic pain syndrome", page: 3 }])];
    const stated = stateObjectiveEvidence(locateConditionEvidenceInClaims(rows, files, NAME), NAME);
    expect(stated.supported).toBe(false);
    expect(stated.objectiveEvidence).toMatch(/No objective finding/);
    expect(stated.objectiveEvidence).toMatch(/past medical history/);
    expect(stated.missingInfo).toMatch(/pre-existing/);
  });

  it("marks a condition supported only by patient report as needing a physician", () => {
    const rows = [enc("doc-1", [{ field: "subjective", excerpt: "Reports chronic pain syndrome", page: 2 }])];
    const stated = stateObjectiveEvidence(locateConditionEvidenceInClaims(rows, files, NAME), NAME);
    expect(stated.supported).toBe(false);
    expect(stated.missingInfo).toMatch(/reported history or treatment/);
  });

  it("says plainly when nothing in the records asserts the condition", () => {
    const stated = stateObjectiveEvidence([], NAME);
    expect(stated.supported).toBe(false);
    expect(stated.objectiveEvidence).toMatch(/No supporting finding .* was located/);
    expect(stated.missingInfo).toMatch(/should not carry a causation opinion/);
  });
});
