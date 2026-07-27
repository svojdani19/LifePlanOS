import { describe, it, expect } from "vitest";
import { assertionOf, isCitableEvidence } from "./assertion";

describe("assertionOf — negation", () => {
  it("negates a term shortly after a pre-negation trigger", () => {
    expect(assertionOf("No acute fracture.", "fracture")).toBe("negated");
    expect(assertionOf("Patient denies chest pain.", "chest pain")).toBe("negated");
    expect(assertionOf("Negative for numbness or tingling.", "numbness")).toBe("negated");
    expect(assertionOf("Resolved effusion of the right knee.", "effusion")).toBe("negated");
    expect(assertionOf("Head CT unremarkable for hemorrhage.", "hemorrhage")).toBe("negated");
  });

  it("negates a short anatomic term without matching inside longer words", () => {
    expect(assertionOf("No cord signal abnormality", "cord")).toBe("negated");
    // "cord" must not match inside "record" ("no" is also out of scope here)
    expect(assertionOf("No record of any prior clinic visits could be located, cord compression noted.", "cord")).toBe("affirmed");
  });

  it("negates via post-position triggers", () => {
    expect(assertionOf("Edema was absent.", "edema")).toBe("negated");
    expect(assertionOf("The lumbar alignment is within normal limits.", "alignment")).toBe("negated");
    expect(assertionOf("Fracture line not seen.", "fracture")).toBe("negated");
  });

  it("treats a completed rule-out as negated", () => {
    expect(assertionOf("The trauma team ruled out concussion.", "concussion")).toBe("negated");
  });

  it("ends negation scope at a conjunction: 'no X, but Y' still affirms Y", () => {
    const s = "No fracture, but severe effusion noted.";
    expect(assertionOf(s, "fracture")).toBe("negated");
    expect(assertionOf(s, "effusion")).toBe("affirmed");
  });

  it("ends negation scope at a semicolon", () => {
    const s = "No cord signal abnormality; burst fracture with retropulsion.";
    expect(assertionOf(s, "cord")).toBe("negated");
    expect(assertionOf(s, "retropulsion")).toBe("affirmed");
  });

  it("leaves a term affirmed when the trigger is out of scope (>6 words away)", () => {
    expect(
      assertionOf("No one who evaluated the patient at the scene that night documented any fracture.", "fracture"),
    ).toBe("affirmed");
  });
});

describe("assertionOf — hypothetical", () => {
  it("classifies a pending rule-out as hypothetical, not negated", () => {
    expect(assertionOf("Rule out concussion", "concussion")).toBe("hypothetical");
    expect(assertionOf("Obtain MRI to r/o ligamentous injury.", "ligamentous")).toBe("hypothetical");
  });

  it("classifies differential and concern phrasing as hypothetical", () => {
    expect(assertionOf("Concern for compartment syndrome.", "compartment syndrome")).toBe("hypothetical");
    expect(assertionOf("Cannot exclude ligamentous injury.", "ligamentous")).toBe("hypothetical");
    expect(assertionOf("Possible occult fracture.", "fracture")).toBe("hypothetical");
    const vs = "Fracture vs. bone contusion on imaging.";
    expect(assertionOf(vs, "fracture")).toBe("hypothetical");
    expect(assertionOf(vs, "contusion")).toBe("hypothetical");
  });

  it("classifies prognostic 'at risk for' as hypothetical", () => {
    expect(assertionOf("Patient is at risk for post-traumatic arthritis.", "arthritis")).toBe("hypothetical");
  });

  it("classifies conditional future events as hypothetical", () => {
    expect(assertionOf("If the patient develops arthritis, orthopedic follow-up is advised.", "arthritis")).toBe("hypothetical");
    expect(assertionOf("Antibiotics will be needed should infection occur.", "infection")).toBe("hypothetical");
  });
});

describe("assertionOf — historical", () => {
  it("classifies directly scoped prior qualifiers as historical", () => {
    expect(assertionOf("History of prior lumbar fusion.", "lumbar fusion")).toBe("historical");
    expect(assertionOf("Status post lumbar fusion in 2015.", "fusion")).toBe("historical");
    expect(assertionOf("Old healed fracture of the clavicle.", "fracture")).toBe("historical");
  });

  it("does not misread ages or 'prior to' as historical qualifiers", () => {
    expect(assertionOf("The patient is a 45-year-old male with a tibial plateau fracture.", "fracture")).toBe("affirmed");
    expect(assertionOf("Symptoms of the concussion began prior to arrival.", "concussion")).toBe("affirmed");
  });
});

describe("assertionOf — family history", () => {
  it("classifies family-history mentions as family", () => {
    expect(assertionOf("Family history of diabetes mellitus.", "diabetes")).toBe("family");
    expect(assertionOf("Mother had breast cancer.", "cancer")).toBe("family");
    expect(assertionOf("Father with hypertension.", "hypertension")).toBe("family");
  });

  it("family wins over every other cue (precedence)", () => {
    // "history of" is also a historical trigger and "no" a negation trigger —
    // the family frame must win in both cases.
    expect(assertionOf("Family history of diabetes mellitus.", "diabetes")).toBe("family");
    expect(assertionOf("No family history of cancer.", "cancer")).toBe("family");
  });
});

describe("assertionOf — affirmed & edge cases", () => {
  it("affirms a plain clinical statement", () => {
    expect(assertionOf("Fracture of the tibial plateau with depression.", "fracture")).toBe("affirmed");
    expect(assertionOf("Fracture of the tibial plateau with depression.", "tibial plateau")).toBe("affirmed");
  });

  it("defaults to affirmed when the term is not in the sentence", () => {
    expect(assertionOf("Unremarkable examination today.", "fracture")).toBe("affirmed");
  });

  it("accepts a RegExp term", () => {
    expect(assertionOf("No evidence of concussion or TBI.", /\bconcussion\b/i)).toBe("negated");
    expect(assertionOf("IMPRESSION: Acute L1 burst fracture.", /burst fracture/i)).toBe("affirmed");
  });
});

describe("isCitableEvidence", () => {
  it("permits only affirmed and historical mentions", () => {
    expect(isCitableEvidence("Fracture of the tibial plateau with depression.", "fracture")).toBe(true);
    expect(isCitableEvidence("History of prior lumbar fusion.", "fusion")).toBe(true);
    expect(isCitableEvidence("No acute fracture.", "fracture")).toBe(false);
    expect(isCitableEvidence("Rule out concussion", "concussion")).toBe(false);
    expect(isCitableEvidence("Family history of diabetes mellitus.", "diabetes")).toBe(false);
  });
});
