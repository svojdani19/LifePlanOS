// ─────────────────────────────────────────────────────────────────────────────
// The lifecycle: detected → validated → repaired → lesson → evaluated → adopted.
//
// Two rules govern everything in this file, and both exist because the failure
// mode of a self-improving system is that it teaches itself something wrong and
// then cannot be talked out of it.
//
// A CRITIC'S ALLEGATION IS NOT TRUTH. Detection is cheap and often wrong: the
// program's own critic and factual audit raise findings that a look at the
// source disproves. So a finding enters at DETECTED and can influence nothing.
// It becomes learnable only when the source itself disagrees with the output
// (deterministic confirmation) or an authorized human says so. A rejected
// allegation is terminal and can never reach a prompt.
//
// A LESSON IS NOT A LICENCE. Confirming a defect earns the right to repair THIS
// case and to propose a lesson. It does not change behaviour: that needs
// held-out evaluation and an adoption decision, recorded, with the previous
// version still available to roll back to.
//
// PHI STAYS OUT. A finding references the rows it concerns by ID and records
// which fields changed and which claim ids moved — never record text, patient
// identifiers, or model responses. `assertPhiFree` is not decoration; it throws.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";
import {
  canTransition,
  profileFor,
  requiredValidator,
  type FailureCode,
  type FindingState,
} from "@/lib/learning/failureTaxonomy";

export type DetectionSource =
  | "CRITIC"
  | "FACTUAL_AUDIT"
  | "SECTION_LEDGER"
  | "DETERMINISTIC_CHECK"
  | "HUMAN_REVIEW";

export interface PipelineVersions {
  modelVersion?: string | null;
  promptVersion?: string | null;
  schemaVersion?: string | null;
  criticVersion?: string | null;
  writerVersion?: string | null;
  engineVersion?: string | null;
  sourceFingerprint?: string | null;
}

export interface DetectInput extends PipelineVersions {
  firmId: string;
  caseId?: string | null;
  documentId?: string | null;
  encounterId?: string | null;
  chronologyEventId?: string | null;
  futureCareItemId?: string | null;
  failureCode: FailureCode;
  detectionSource: DetectionSource;
  documentClass?: string | null;
  sectionType?: string | null;
  /** Claim identifiers the finding concerns. IDs only. */
  originalClaimIds?: string[];
}

/**
 * Text that must never reach learning storage.
 *
 * The check is deliberately blunt and runs on every write: a date of birth, a
 * long free-text passage, or anything that reads like a record excerpt. It is
 * cheaper to reject a too-specific guidance sentence at the boundary than to
 * discover months later that a shared lesson carried a patient's history in it.
 */
const PHI_SHAPED =
  /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})\b|\bdob\b|\bdate of birth\b|\bmrn\b|\bssn\b|\b\d{3}-\d{2}-\d{4}\b|\bpatient\s+[A-Z][a-z]+\b/i;

export const MAX_GUIDANCE_CHARS = 240;

export function assertPhiFree(text: string, what = "guidance"): void {
  if (text.length > MAX_GUIDANCE_CHARS) {
    throw new Error(`${what} exceeds ${MAX_GUIDANCE_CHARS} characters; learning text must be short and structural`);
  }
  if (PHI_SHAPED.test(text)) {
    throw new Error(`${what} looks like it contains patient-specific detail; learning text must be fact-free`);
  }
}

/** Record an allegation. It can influence nothing until it is validated. */
export async function detectFinding(input: DetectInput) {
  const profile = profileFor(input.failureCode);
  return prisma.learningFinding.create({
    data: {
      firmId: input.firmId,
      caseId: input.caseId ?? null,
      documentId: input.documentId ?? null,
      encounterId: input.encounterId ?? null,
      chronologyEventId: input.chronologyEventId ?? null,
      futureCareItemId: input.futureCareItemId ?? null,
      stage: profile.stage,
      failureCode: input.failureCode,
      severity: profile.severity,
      detectionSource: input.detectionSource,
      state: "DETECTED",
      documentClass: input.documentClass ?? null,
      sectionType: input.sectionType ?? null,
      reusableScope: profile.scope,
      originalClaimIds: (input.originalClaimIds ?? []) as unknown as object,
      modelVersion: input.modelVersion ?? null,
      promptVersion: input.promptVersion ?? null,
      schemaVersion: input.schemaVersion ?? null,
      criticVersion: input.criticVersion ?? null,
      writerVersion: input.writerVersion ?? null,
      engineVersion: input.engineVersion ?? null,
      sourceFingerprint: input.sourceFingerprint ?? null,
    },
  });
}

export interface ValidationInput {
  findingId: string;
  firmId: string;
  /** DETERMINISTIC needs no human; the others name one. */
  validatorKind: "DETERMINISTIC" | "HUMAN_REVIEWER" | "HUMAN_CLINICAL";
  confirmed: boolean;
  reviewerId?: string | null;
  reviewerRole?: string | null;
  correctionReason?: string | null;
  /** Structural before→after. Field names and change kinds only. */
  correctionDelta?: { field: string; changeType: string }[];
  addedClaimIds?: string[];
  removedClaimIds?: string[];
  selectedClaimIds?: string[];
  rejectedClaimIds?: string[];
  /** Did the correction change what the entry MEANS, or only how it reads? */
  changedMeaning?: boolean;
}

/** Roles permitted to confirm a defect that will change clinical behaviour. */
const CLINICAL_ROLES = new Set(["PHYSICIAN_REVIEWER", "ADMIN"]);

/**
 * Confirm or reject an allegation.
 *
 * Authority is checked against what the failure code will be allowed to teach,
 * not against what the reviewer happens to be doing: a care-planning defect
 * becomes a firm-scoped clinical prior, so only a reviewer with clinical
 * standing may confirm one. A rejection is recorded rather than deleted,
 * because the rate at which the critic cries wolf is itself a thing to measure.
 */
export async function validateFinding(input: ValidationInput) {
  const finding = await prisma.learningFinding.findFirst({
    where: { id: input.findingId, firmId: input.firmId },
  });
  if (!finding) throw new Error("finding not found in this firm");

  const code = finding.failureCode as FailureCode;
  const required = requiredValidator(code);
  if (required === "HUMAN_CLINICAL") {
    if (input.validatorKind !== "HUMAN_CLINICAL" || !CLINICAL_ROLES.has(input.reviewerRole ?? "")) {
      throw new Error(`${code} may only be confirmed by a reviewer with clinical authority`);
    }
  }
  if (required === "HUMAN_REVIEWER" && input.validatorKind === "DETERMINISTIC") {
    throw new Error(`${code} cannot be confirmed deterministically; it needs a human judgement`);
  }

  const next: FindingState = input.confirmed ? "VALIDATED" : "REJECTED_FALSE_POSITIVE";
  if (!canTransition(finding.state as FindingState, next)) {
    throw new Error(`cannot move a finding from ${finding.state} to ${next}`);
  }

  return prisma.learningFinding.update({
    where: { id: finding.id },
    data: {
      state: next,
      validatorKind: input.validatorKind,
      validatorResult: input.confirmed ? "CONFIRMED" : "REJECTED",
      reviewerId: input.reviewerId ?? null,
      reviewerRole: input.reviewerRole ?? null,
      correctionReason: input.correctionReason ?? null,
      correctionDelta: (input.correctionDelta ?? []) as unknown as object,
      addedClaimIds: (input.addedClaimIds ?? []) as unknown as object,
      removedClaimIds: (input.removedClaimIds ?? []) as unknown as object,
      selectedClaimIds: (input.selectedClaimIds ?? []) as unknown as object,
      rejectedClaimIds: (input.rejectedClaimIds ?? []) as unknown as object,
      changedMeaning: input.changedMeaning ?? null,
    },
  });
}

/** How many times a single defect may be retried before it stays visible. */
export const MAX_REPAIR_ATTEMPTS = 2;

/**
 * Record the outcome of a targeted repair.
 *
 * REPAIRED is claimed only when the source-grounded defect no longer exists —
 * not when a retry merely ran. An exhausted repair goes to UNRESOLVED and stays
 * visible, because a finding that quietly disappears is indistinguishable from
 * one that was fixed, and only one of those is safe to ship.
 */
export async function recordRepairAttempt(findingId: string, firmId: string, succeeded: boolean) {
  const finding = await prisma.learningFinding.findFirst({ where: { id: findingId, firmId } });
  if (!finding) throw new Error("finding not found in this firm");
  if (finding.state !== "VALIDATED" && finding.state !== "UNRESOLVED") {
    throw new Error(`only a validated finding can be repaired; this one is ${finding.state}`);
  }
  const attempts = finding.repairAttempts + 1;
  const state: FindingState = succeeded ? "REPAIRED" : "UNRESOLVED";
  return prisma.learningFinding.update({
    where: { id: finding.id },
    data: { repairAttempts: attempts, state, repairedAt: succeeded ? new Date() : null },
  });
}

/** Has this defect exhausted its bounded retries? */
export function repairExhausted(attempts: number): boolean {
  return attempts >= MAX_REPAIR_ATTEMPTS;
}

/**
 * Findings that block an unqualified audit pass.
 *
 * An unresolved, validated defect is a known wrong thing in the output. The
 * export gate may still allow a human to override it, but it must not be able
 * to claim the record is clean.
 */
export async function blockingFindings(firmId: string, caseId: string) {
  return prisma.learningFinding.findMany({
    where: { firmId, caseId, state: { in: ["VALIDATED", "UNRESOLVED"] } },
    orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
  });
}
