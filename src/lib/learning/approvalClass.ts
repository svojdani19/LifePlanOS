/**
 * Which human may approve a learned lesson.
 *
 * Evaluation used to end in adoption: judgeCandidate said the metrics improved
 * and evaluateCandidate wrote status ADOPTED, at which point the lesson began
 * shaping output. No person approved anything, and a lesson that changes how
 * care is recommended was adopted on the same footing as one that changes which
 * field leads a summary.
 *
 * Those are not the same act. A salience preference is an editorial judgment
 * about presentation; a clinical prior is a standing medical opinion the firm
 * applies before anyone looks at the patient. The second needs someone with the
 * standing to hold that opinion.
 *
 * The taxonomy already encoded this for the VALIDATION stage — requiredValidator
 * returns HUMAN_CLINICAL for CLINICAL_PRIOR mechanisms. This module carries the
 * same distinction into the ADOPTION stage, which had no gate at all.
 */

import { FAILURE_PROFILES, type FailureCode, type LearningMechanism } from "@/lib/learning/failureTaxonomy";

/**
 * STYLE — presentation and structure. A firm administrator may approve.
 * CLINICAL — changes what the program asserts about care. Requires a verified
 *   physician credential, enforced by the same gate that guards attestation.
 */
export type ApprovalClass = "STYLE" | "CLINICAL";

export interface ClassifyInput {
  mechanism: LearningMechanism | string;
  /** CASE_ONLY | DOCUMENT_CLASS | FIRM_CLINICAL */
  scope?: string | null;
  failureCode?: string | null;
}

/** Mechanisms that are editorial by construction. Everything else is clinical. */
const STYLE_MECHANISMS = new Set<string>(["TASK_GUIDANCE", "SALIENCE_PREFERENCE"]);

/**
 * Classify a candidate.
 *
 * The rule is deliberately asymmetric: a candidate is STYLE only when every
 * signal says so, and CLINICAL whenever any of them says otherwise. A
 * misclassification that routes an editorial lesson to a physician costs an
 * unnecessary review. One that routes a clinical lesson to an administrator
 * puts a medical opinion into the firm's output on an administrator's say-so.
 * Those errors are not worth the same, so the default falls toward CLINICAL.
 */
export function classifyApproval(input: ClassifyInput): ApprovalClass {
  if (!STYLE_MECHANISMS.has(String(input.mechanism))) return "CLINICAL";
  // Firm-wide clinical scope overrides the mechanism: guidance applied across
  // every case in a firm's clinical output is a firm clinical position.
  if (input.scope === "FIRM_CLINICAL") return "CLINICAL";
  // A safety-critical failure is one that puts a wrong clinical assertion in
  // front of a reader. A lesson learned from one is not an editorial matter,
  // whatever mechanism happens to carry it.
  const profile = input.failureCode ? FAILURE_PROFILES[input.failureCode as FailureCode] : undefined;
  if (profile?.severity === "SAFETY_CRITICAL") return "CLINICAL";
  return "STYLE";
}

/** The credential an approver must hold, or null when none is required. */
export function requiredApprovalCredential(cls: ApprovalClass): "PHYSICIAN" | null {
  return cls === "CLINICAL" ? "PHYSICIAN" : null;
}

/** The permission key an approver must hold for this class. */
export function requiredApprovalPermission(cls: ApprovalClass): string {
  return cls === "CLINICAL" ? "learning.approve_clinical" : "learning.approve";
}
