// The taxonomy is what the rest of the loop agrees on: which mechanism may
// learn from a defect, whether its regression is ever negotiable, and how far a
// lesson may travel. These tests hold those invariants, because a code that
// quietly changes mechanism or severity changes what the program is allowed to
// teach itself.
//
// Synthetic only — nothing here reads a record.

import { describe, expect, it } from "vitest";
import {
  canTransition,
  codeFromCorrectionCategory,
  FAILURE_CODES,
  FAILURE_PROFILES,
  isFailureCode,
  isLearnable,
  nextStates,
  profileFor,
  RECOVERABLE_CODES,
  requiredValidator,
  SAFETY_CRITICAL_CODES,
  type FailureCode,
} from "@/lib/learning/failureTaxonomy";

describe("the vocabulary is closed and complete", () => {
  it("gives every code a profile", () => {
    for (const code of FAILURE_CODES) {
      expect(FAILURE_PROFILES[code], code).toBeDefined();
      expect(FAILURE_PROFILES[code].code).toBe(code);
    }
  });

  it("contains no duplicates", () => {
    expect(new Set(FAILURE_CODES).size).toBe(FAILURE_CODES.length);
  });

  it("rejects a code it does not know", () => {
    expect(isFailureCode("WRONG_LATERALITY")).toBe(true);
    expect(isFailureCode("SOMETHING_INVENTED")).toBe(false);
  });
});

describe("a safety defect never learns from prose", () => {
  it("routes inversions and grounding defects to deterministic rules", () => {
    // Retrieving an example cannot stop a laterality inversion. Treating a
    // safety defect as a style suggestion is how it survives.
    for (const code of ["WRONG_LATERALITY", "NEGATION_REVERSED", "PLANNED_AS_PERFORMED", "CONSENT_AS_TREATMENT", "UNSUPPORTED_CLAIM", "FALSE_ENCOUNTER_MERGE"] as FailureCode[]) {
      expect(profileFor(code).mechanism, code).toBe("DETERMINISTIC_RULE");
    }
  });

  it("marks them safety-critical", () => {
    for (const code of ["WRONG_LATERALITY", "NEGATION_REVERSED", "PLANNED_AS_PERFORMED", "UNSUPPORTED_CLAIM", "UNSUPPORTED_PROSE", "FALSE_ENCOUNTER_MERGE", "UNSUPPORTED_RECOMMENDATION"] as FailureCode[]) {
      expect(SAFETY_CRITICAL_CODES, code).toContain(code);
    }
  });

  it("never lets a safety-critical code learn as a salience preference", () => {
    for (const code of SAFETY_CRITICAL_CODES) {
      expect(profileFor(code).mechanism, code).not.toBe("SALIENCE_PREFERENCE");
    }
  });
});

describe("identity defects train the merger, not the writer", () => {
  it("routes merge and duplicate defects to deterministic rules at the identity stage", () => {
    for (const code of ["FALSE_ENCOUNTER_MERGE", "DUPLICATE_ENTRY", "MISSED_DUPLICATE", "UNCLEAR_SOURCE_BOUNDARY"] as FailureCode[]) {
      expect(profileFor(code).stage, code).toBe("IDENTITY");
      expect(profileFor(code).mechanism, code).toBe("DETERMINISTIC_RULE");
    }
  });

  it("never routes an identity defect to task guidance", () => {
    // The prose writer has no say in whether two records are one encounter.
    for (const code of FAILURE_CODES) {
      if (profileFor(code).stage !== "IDENTITY") continue;
      expect(profileFor(code).mechanism, code).not.toBe("TASK_GUIDANCE");
    }
  });
});

describe("care planning learns only as a firm-scoped clinical prior", () => {
  it("scopes recommendation defects to the firm and demands clinical standing", () => {
    for (const code of ["UNSUPPORTED_RECOMMENDATION", "UNSUPPORTED_FREQUENCY", "UNSUPPORTED_DURATION", "UNSUPPORTED_TREATMENT_FAILURE"] as FailureCode[]) {
      expect(profileFor(code).mechanism, code).toBe("CLINICAL_PRIOR");
      expect(profileFor(code).scope, code).toBe("FIRM_CLINICAL");
      expect(requiredValidator(code), code).toBe("HUMAN_CLINICAL");
    }
  });

  it("never lets a clinical prior originate from a deterministic check alone", () => {
    for (const code of FAILURE_CODES) {
      if (profileFor(code).mechanism !== "CLINICAL_PRIOR") continue;
      expect(requiredValidator(code), code).not.toBe("DETERMINISTIC");
    }
  });
});

describe("summary preferences are structure, not prose", () => {
  it("learns selection defects as salience preferences", () => {
    expect(profileFor("IRRELEVANT_SUMMARY").mechanism).toBe("SALIENCE_PREFERENCE");
    expect(profileFor("IMPORTANT_FACT_OMITTED").mechanism).toBe("SALIENCE_PREFERENCE");
  });

  it("requires a human to say a summary was wrong", () => {
    // No deterministic check can tell that a true sentence was the wrong one
    // to lead with.
    expect(requiredValidator("IRRELEVANT_SUMMARY")).toBe("HUMAN_REVIEWER");
  });

  it("does not treat a reworded summary as a recoverable extraction defect", () => {
    expect(profileFor("IRRELEVANT_SUMMARY").recoverable).toBe(false);
  });
});

describe("recall defects can be retried, preferences cannot", () => {
  it("marks missed content recoverable", () => {
    for (const code of ["MISSED_SECTION", "MISSED_MATERIAL_FACT", "MISSED_NEGATIVE_FINDING"] as FailureCode[]) {
      expect(RECOVERABLE_CODES, code).toContain(code);
    }
  });

  it("does not mark a preference recoverable", () => {
    expect(RECOVERABLE_CODES).not.toContain("IRRELEVANT_SUMMARY");
    expect(RECOVERABLE_CODES).not.toContain("UNSUPPORTED_FREQUENCY");
  });
});

describe("the state machine", () => {
  it("cannot learn from an allegation nobody confirmed", () => {
    // A critic's finding is not training truth.
    expect(canTransition("DETECTED", "LEARNING_CANDIDATE")).toBe(false);
    expect(isLearnable("DETECTED")).toBe(false);
  });

  it("allows validation or rejection from detection", () => {
    expect(nextStates("DETECTED")).toEqual(["VALIDATED", "REJECTED_FALSE_POSITIVE"]);
  });

  it("makes a rejected false positive terminal", () => {
    // A rejected allegation must be unable to influence any future prompt.
    expect(nextStates("REJECTED_FALSE_POSITIVE")).toHaveLength(0);
    expect(isLearnable("REJECTED_FALSE_POSITIVE")).toBe(false);
  });

  it("requires evaluation before adoption", () => {
    expect(canTransition("LEARNING_CANDIDATE", "ADOPTED")).toBe(false);
    expect(canTransition("LEARNING_CANDIDATE", "EVALUATED")).toBe(true);
    expect(canTransition("EVALUATED", "ADOPTED")).toBe(true);
  });

  it("allows an adopted lesson to be retired", () => {
    expect(canTransition("ADOPTED", "RETIRED")).toBe(true);
    expect(nextStates("RETIRED")).toHaveLength(0);
  });

  it("lets a repaired case still teach, and an unresolved one stay visible", () => {
    expect(canTransition("REPAIRED", "LEARNING_CANDIDATE")).toBe(true);
    expect(canTransition("VALIDATED", "UNRESOLVED")).toBe(true);
    expect(canTransition("UNRESOLVED", "REPAIRED")).toBe(true);
  });

  it("cannot skip straight from detection to repair", () => {
    expect(canTransition("DETECTED", "REPAIRED")).toBe(false);
  });
});

describe("mapping the corrections already recorded today", () => {
  it("maps the existing categories into the vocabulary", () => {
    expect(codeFromCorrectionCategory("DATE_CORRECTED")).toBe("WRONG_DATE");
    expect(codeFromCorrectionCategory("PROVIDER_CORRECTED")).toBe("WRONG_PROVIDER");
    expect(codeFromCorrectionCategory("EXCERPT_MISMATCH")).toBe("UNSUPPORTED_CLAIM");
    expect(codeFromCorrectionCategory("BOILERPLATE_REMOVED")).toBe("IRRELEVANT_SUMMARY");
  });

  it("falls back rather than guessing", () => {
    // The existing categories say what a reviewer touched, not what the
    // program got wrong, so an unmappable one must not invent a defect.
    expect(codeFromCorrectionCategory("SUMMARY_REWORDED")).toBe("OTHER_REVIEWER_CORRECTION");
    expect(codeFromCorrectionCategory("WRONG_FIELD")).toBe("OTHER_REVIEWER_CORRECTION");
    expect(codeFromCorrectionCategory("ANYTHING_ELSE")).toBe("OTHER_REVIEWER_CORRECTION");
  });
});
