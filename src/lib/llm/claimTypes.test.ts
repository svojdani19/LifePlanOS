// Category errors in record review — each of these converts one kind of
// statement into a materially different one. Synthetic records only.
import { describe, it, expect } from "vitest";
import {
  checkCompletedClaim,
  checkNegationConsistency,
  checkAnatomyConsistency,
  checkCertainty,
  isNegated,
  looksCopiedForward,
} from "./claimTypes";

describe("consent is not a performed procedure", () => {
  it("rejects a completed-procedure claim cited to a consent form", () => {
    const r = checkCompletedClaim(
      "PROCEDURE_PERFORMED",
      "Right knee arthroscopy performed",
      "I authorize Dr. Chen to perform arthroscopy of the right knee. Risks and benefits were discussed.",
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/consent/i);
    expect(r.suggestedType).toBe("CONSENT_ONLY");
  });

  it("accepts the procedure when an operative note states it was performed", () => {
    const r = checkCompletedClaim(
      "PROCEDURE_PERFORMED",
      "Right knee arthroscopic partial medial meniscectomy",
      "Procedure performed: Right knee arthroscopic partial medial meniscectomy. The patient tolerated the procedure well.",
    );
    expect(r.ok).toBe(true);
  });
});

describe("a recommendation is not delivered treatment", () => {
  it("rejects completed treatment cited to a recommendation", () => {
    for (const excerpt of [
      "Recommend lumbar epidural steroid injection at L4-L5.",
      "The patient is a candidate for total knee arthroplasty.",
      "Plan to schedule physical therapy twice weekly.",
    ]) {
      const r = checkCompletedClaim("COMPLETED_TREATMENT", "Injection administered", excerpt);
      expect(r.ok, excerpt).toBe(false);
      expect(r.suggestedType).toBe("RECOMMENDED_TREATMENT");
    }
  });

  it("accepts treatment the excerpt says was administered", () => {
    const r = checkCompletedClaim("COMPLETED_TREATMENT", "Toradol 60mg IM administered", "Toradol 60mg IM administered in the emergency department.");
    expect(r.ok).toBe(true);
  });

  it("a completed claim with no performance language at all is rejected", () => {
    const r = checkCompletedClaim("COMPLETED_TREATMENT", "Physical therapy", "The patient has low back pain radiating to the left leg.");
    expect(r.ok).toBe(false);
  });
});

describe("negation is never inverted", () => {
  it("detects negated findings", () => {
    expect(isNegated("X-ray shows no acute fracture", "acute fracture")).toBe(true);
    expect(isNegated("Patient denies numbness or tingling", "numbness")).toBe(true);
    expect(isNegated("negative for infection", "infection")).toBe(true);
    expect(isNegated("Displaced fracture of the distal radius", "fracture")).toBe(false);
  });

  it("rejects a positive finding whose excerpt negates it", () => {
    const r = checkNegationConsistency("IMAGING_FINDING", "Acute fracture of the left hip", "X-ray left hip: no acute fracture or dislocation seen.");
    expect(r.ok).toBe(false);
    expect(r.suggestedType).toBe("NEGATIVE_FINDING");
  });

  it("allows the negative finding to be recorded as such", () => {
    expect(checkNegationConsistency("NEGATIVE_FINDING", "No acute fracture", "no acute fracture or dislocation seen").ok).toBe(true);
  });
});

describe("anatomy and laterality must be supported", () => {
  it("rejects a switched side", () => {
    const r = checkAnatomyConsistency("Right knee effusion", "Exam: left knee effusion with limited flexion.");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/states "right" but the source states "left"/);
  });

  it("accepts anatomy stated in the page header rather than the quoted impression", () => {
    // A radiology impression omits the side because the study header carries it.
    const page = "MRI RIGHT KNEE\nImpression: Complex tear of the medial meniscus posterior horn.";
    const r = checkAnatomyConsistency(
      "MRI right knee: complex tear of the medial meniscus posterior horn",
      "Impression: Complex tear of the medial meniscus posterior horn.",
      page,
    );
    expect(r.ok).toBe(true);
  });

  it("still rejects a side the page contradicts, even with page context", () => {
    const page = "MRI LEFT KNEE\nImpression: Complex tear of the medial meniscus.";
    const r = checkAnatomyConsistency("MRI right knee: complex tear", "Impression: Complex tear of the medial meniscus.", page);
    expect(r.ok).toBe(false);
  });

  it("rejects anatomy the excerpt never names", () => {
    const r = checkAnatomyConsistency("Lumbar disc herniation", "MRI cervical spine: disc herniation at C5-6.");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/anatomy/);
  });

  it("accepts a faithful anatomical claim", () => {
    expect(checkAnatomyConsistency("Left knee effusion", "Exam: left knee effusion with limited flexion.").ok).toBe(true);
  });
});

describe("uncertainty is preserved in both directions", () => {
  it("rejects certainty the record does not express", () => {
    expect(checkCertainty("MRI confirms meniscal tear", "MRI impression: findings suggestive of a medial meniscus tear.").ok).toBe(false);
  });

  it("rejects dropping the record's hedge", () => {
    expect(checkCertainty("Medial meniscus tear", "Impression: possible medial meniscus tear.").ok).toBe(false);
  });

  it("accepts a claim that carries the hedge through", () => {
    expect(checkCertainty("Possible medial meniscus tear", "Impression: possible medial meniscus tear.").ok).toBe(true);
  });
});

describe("copied-forward text is detectable", () => {
  it("flags history repeated verbatim from a prior note", () => {
    const prior = "Patient reports persistent low back pain radiating into the left leg since the collision.";
    expect(looksCopiedForward(prior, [prior])).toBe(true);
  });

  it("does not flag short or genuinely new text", () => {
    expect(looksCopiedForward("Pain improved.", ["Patient reports persistent low back pain radiating into the left leg."])).toBe(false);
  });
});
