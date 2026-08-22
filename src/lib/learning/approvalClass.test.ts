import { describe, it, expect } from "vitest";
import { classifyApproval, requiredApprovalCredential, requiredApprovalPermission } from "@/lib/learning/approvalClass";

describe("who may approve a lesson", () => {
  it("routes editorial guidance to the administrator", () => {
    expect(classifyApproval({ mechanism: "TASK_GUIDANCE", scope: "DOCUMENT_CLASS", failureCode: "MISSED_SECTION" })).toBe("STYLE");
  });

  it("routes a clinical prior to a physician", () => {
    expect(classifyApproval({ mechanism: "CLINICAL_PRIOR", scope: "FIRM_CLINICAL", failureCode: "UNSUPPORTED_FREQUENCY" })).toBe("CLINICAL");
  });

  it("routes a deterministic RULE to a physician — proposing code is not editing prose", () => {
    expect(classifyApproval({ mechanism: "DETERMINISTIC_RULE", scope: "DOCUMENT_CLASS", failureCode: "WRONG_DATE" })).toBe("CLINICAL");
  });

  it("treats FIRM_CLINICAL scope as clinical whatever the mechanism claims", () => {
    // Guidance applied across every case in a firm's clinical output is a firm
    // clinical position, not a house style.
    expect(classifyApproval({ mechanism: "SALIENCE_PREFERENCE", scope: "FIRM_CLINICAL" })).toBe("CLINICAL");
  });

  it("treats a SAFETY_CRITICAL failure as clinical whatever the mechanism claims", () => {
    // A lesson learned from a laterality inversion is not an editorial matter.
    expect(classifyApproval({ mechanism: "TASK_GUIDANCE", scope: "DOCUMENT_CLASS", failureCode: "WRONG_LATERALITY" })).toBe("CLINICAL");
  });

  it("defaults to CLINICAL on anything it does not recognise", () => {
    // The two misclassifications do not cost the same: sending an editorial
    // lesson to a physician wastes a review, sending a clinical one to an
    // administrator puts a medical opinion into output on the wrong authority.
    expect(classifyApproval({ mechanism: "SOMETHING_NEW" })).toBe("CLINICAL");
    expect(classifyApproval({ mechanism: "NONE" })).toBe("CLINICAL");
  });

  it("names the credential and permission each class requires", () => {
    expect(requiredApprovalCredential("CLINICAL")).toBe("PHYSICIAN");
    expect(requiredApprovalCredential("STYLE")).toBeNull();
    expect(requiredApprovalPermission("CLINICAL")).toBe("learning.approve_clinical");
    expect(requiredApprovalPermission("STYLE")).toBe("learning.approve");
  });
});
