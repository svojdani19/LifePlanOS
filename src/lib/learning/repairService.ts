// ─────────────────────────────────────────────────────────────────────────────
// Fixing THIS case, as narrowly as possible.
//
// Repair and learning are different jobs and must not be confused. Repair puts
// one record right; learning is what stops the next one going wrong. A program
// that only learns leaves a defect sitting in the report a physician is about
// to sign, and a program that only repairs never improves.
//
// Three rules shape everything here.
//
// NARROW. A confirmed miss is re-asked for on the page, section or encounter it
// concerns — never by re-running the document, which would discard correct work
// to recover one omission.
//
// HUMAN WORK IS NEVER DISCARDED. Anything a reviewer edited, verified or
// approved survives repair untouched. A regeneration that overwrites a
// physician's correction is worse than the defect it was fixing, because the
// defect was visible and the overwrite is not.
//
// BOUNDED, AND HONEST WHEN IT FAILS. Two attempts. A defect that survives them
// goes to UNRESOLVED and stays visible, blocking an unqualified audit pass. The
// failure mode this exists to prevent is a retry loop that eventually stops
// trying and leaves no trace that anything was ever wrong.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";
import { profileFor, type FailureCode } from "@/lib/learning/failureTaxonomy";
import { MAX_REPAIR_ATTEMPTS, recordRepairAttempt, repairExhausted } from "@/lib/learning/findingService";

/** Review states whose content a repair must leave exactly as it found it. */
export const PROTECTED_REVIEW_STATES = ["HUMAN_EDITED", "REVIEWED", "VERIFIED"] as const;

export function isProtected(reviewStatus: string | null | undefined): boolean {
  return (PROTECTED_REVIEW_STATES as readonly string[]).includes(reviewStatus ?? "");
}

export type RepairOutcome =
  | { attempted: false; reason: "NOT_RECOVERABLE" | "ATTEMPTS_EXHAUSTED" | "PROTECTED_CONTENT" }
  | { attempted: true; succeeded: boolean; reason?: string };

export interface RepairContext {
  firmId: string;
  findingId: string;
  /**
   * Re-ask for the missing content, scoped to the affected span. Returns true
   * when the defect is gone — verified against the source, not merely retried.
   */
  retry: () => Promise<boolean>;
  /** Review status of the object being repaired, if it has one. */
  reviewStatus?: string | null;
}

/**
 * Attempt one narrow repair.
 *
 * Refuses before it starts in the three cases where trying would be wrong: a
 * defect no retry can fix, a defect that has already used its attempts, and
 * content a human has taken responsibility for.
 */
export async function attemptRepair(ctx: RepairContext): Promise<RepairOutcome> {
  const finding = await prisma.learningFinding.findFirst({
    where: { id: ctx.findingId, firmId: ctx.firmId },
  });
  if (!finding) throw new Error("finding not found in this firm");

  if (isProtected(ctx.reviewStatus)) {
    return { attempted: false, reason: "PROTECTED_CONTENT" };
  }
  if (!profileFor(finding.failureCode as FailureCode).recoverable) {
    // A reviewer's preference cannot be recovered by asking the model again.
    await recordRepairAttempt(finding.id, ctx.firmId, false).catch(() => undefined);
    return { attempted: false, reason: "NOT_RECOVERABLE" };
  }
  if (repairExhausted(finding.repairAttempts)) {
    return { attempted: false, reason: "ATTEMPTS_EXHAUSTED" };
  }

  let succeeded = false;
  try {
    succeeded = await ctx.retry();
  } catch {
    succeeded = false;
  }
  await recordRepairAttempt(finding.id, ctx.firmId, succeeded);
  return { attempted: true, succeeded };
}

/**
 * Does this case still hold a defect that stops the audit calling itself clean?
 *
 * An unresolved, confirmed defect is a known wrong thing in the output. A human
 * may still choose to export over it; what must not happen is the program
 * reporting the record as unqualified-pass while it is there.
 */
export async function auditIsQualified(firmId: string, caseId: string): Promise<{ qualified: boolean; blocking: number }> {
  const blocking = await prisma.learningFinding.count({
    where: { firmId, caseId, state: { in: ["VALIDATED", "UNRESOLVED"] } },
  });
  return { qualified: blocking === 0, blocking };
}

export { MAX_REPAIR_ATTEMPTS };
