// ─────────────────────────────────────────────────────────────────────────────
// Professional-authority gate for FINAL EXPERT report release.
//
// One server-side decision determines whether a report may be represented as a
// final expert report — i.e. whether first-person medical opinions and a
// signature block may appear on it. The decision never trusts UI state, a
// client-supplied status, a legacy role string alone, or the mere existence of
// an attestation row. It verifies, against the database at decision time:
//
//   • the case belongs to the target firm;
//   • an ACTIVE physician attestation exists whose immutable content hash
//     still matches its signed statement + scope (tamper evidence);
//   • the attestation still verifies against the CURRENT plan (no material
//     drift on any covered recommendation since signing);
//   • the attestation covers EVERY recommendation actually included in the
//     report's medical totals (the same deterministic inclusion the report
//     builder uses) — rejected, superseded, excluded, and contingency-only
//     items are outside the totals and therefore outside the requirement;
//   • the signing professional still holds professional authority NOW: an
//     ACTIVE seat in the case's firm, the physician-reviewer role (legacy
//     role or an ACTIVE, unexpired role assignment), and a verified,
//     unexpired professional credential of the required category.
//
// The decision also produces a canonical fingerprint of the included item set
// so callers can detect time-of-check/time-of-use drift: re-evaluate after
// rendering and require the same fingerprint before recording the artifact.
//
// Fail closed: any error while proving authority yields an unauthorized
// decision, never an exception that a caller might swallow into success.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { runIntegrityCheck, hasPatientRecordSupport, type RecInput, type CondInput } from "@/lib/engine/integrity";
import {
  verifyAttestation,
  attestationContentHash,
  type AttestationScopeEntry,
  type AttestableItem,
} from "@/lib/engine/attestation";
import { hasVerifiedCredential } from "@/lib/authz/credentialGate";
import type { FutureCareItem } from "@/generated/prisma";

export type AuthorityReasonCode =
  | "CASE_NOT_FOUND"
  | "NO_ACTIVE_ATTESTATION"
  | "ATTESTATION_HASH_INVALID"
  | "ATTESTATION_DRIFTED"
  | "ATTESTATION_SCOPE_INCOMPLETE"
  | "SIGNER_NOT_IN_FIRM"
  | "SIGNER_ROLE_INVALID"
  | "SIGNER_CREDENTIAL_INVALID"
  | "PLAN_CHANGED_DURING_GENERATION"
  | "AUTHORITY_CHECK_FAILED";

export interface VerifiedExpertAuthority {
  authorized: true;
  attestationId: string;
  signerUserId: string;
  signerName: string;
  /** Credential summary snapshotted at signing — verified identity, never the case creator. */
  signerCredentialSummary: string | null;
  statementText: string;
  signedAt: Date;
  contentHash: string;
  attestedItemCount: number;
  attestedPresentValue: number;
  /** Canonical fingerprint of the included item set at decision time. */
  includedFingerprint: string;
  includedItemIds: string[];
  includedPresentValue: number;
  includedLifetimeCost: number;
}

export interface DeniedExpertAuthority {
  authorized: false;
  reasons: AuthorityReasonCode[];
  includedFingerprint: string | null;
}

export type ExpertAuthorityDecision = VerifiedExpertAuthority | DeniedExpertAuthority;

// ── Canonical included-item set ──────────────────────────────────────────────
// The SAME deterministic inclusion the report builder applies: an item enters
// the medical totals only when the integrity engine includes it. One algorithm,
// used by the gate, the builder, and the fingerprint.

export interface IncludedPlanItem {
  id: string;
  lineageId: string;
  version: number;
  service: string;
  category: string;
  probability: string;
  frequencyPerYear: number;
  durationYears: number | null;
  isLifetime: boolean;
  unitCost: number;
  presentValue: number;
  lifetimeCost: number;
  physicianStatus: string;
}

export function computeIncludedPlanItems(
  items: FutureCareItem[],
  conditions: CondInput[],
): IncludedPlanItem[] {
  const integrity = runIntegrityCheck({
    recommendations: items as unknown as RecInput[],
    conditions,
    hasRecordSupport: (rec, matched) =>
      hasPatientRecordSupport(
        rec as unknown as FutureCareItem,
        matched as (CondInput & { evidenceSources?: unknown }) | null,
      ),
  });
  return items
    .filter((it) => integrity.perItem.get(it as unknown as RecInput)?.includedInTotal)
    .map((it) => ({
      id: it.id,
      lineageId: it.lineageId,
      version: it.version,
      service: it.service,
      category: it.category,
      probability: it.probability,
      frequencyPerYear: it.frequencyPerYear,
      durationYears: it.durationYears,
      isLifetime: it.isLifetime,
      unitCost: it.unitCost,
      presentValue: it.presentValue,
      lifetimeCost: it.lifetimeCost,
      physicianStatus: it.physicianStatus,
    }));
}

/** Canonical, order-independent fingerprint over the included set's material
 *  fields — two evaluations agree iff the plan's included items are identical. */
export function includedSetFingerprint(included: IncludedPlanItem[]): string {
  const canonical = included
    .map((it) => [
      it.lineageId,
      it.version,
      it.service,
      it.category,
      it.probability,
      it.frequencyPerYear,
      it.durationYears,
      it.isLifetime,
      it.unitCost,
      it.presentValue,
      it.physicianStatus,
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ── Pure decision core (unit-testable without a database) ────────────────────

export interface AttestationCandidate {
  id: string;
  physicianId: string;
  physicianName: string;
  credentialSummary: string | null;
  statementText: string;
  signedAt: Date;
  contentHash: string;
  itemCount: number;
  totalPresentValue: number;
  scope: AttestationScopeEntry[];
}

export interface SignerFacts {
  /** The signer exists, is ACTIVE, and belongs to the case's firm. */
  inFirm: boolean;
  /** The signer holds physician-reviewer authority (legacy role or ACTIVE, unexpired assignment). */
  roleValid: boolean;
  /** The signer holds a verified, unexpired credential of the required category in this firm. */
  credentialValid: boolean;
}

export function decideExpertAuthority(input: {
  attestations: AttestationCandidate[];
  currentItems: AttestableItem[];
  included: IncludedPlanItem[];
  signerFactsById: Map<string, SignerFacts>;
}): ExpertAuthorityDecision {
  const { attestations, currentItems, included, signerFactsById } = input;
  const fingerprint = includedSetFingerprint(included);

  if (!attestations.length) {
    return { authorized: false, reasons: ["NO_ACTIVE_ATTESTATION"], includedFingerprint: fingerprint };
  }

  // Evaluate candidates newest-first; the first fully valid one authorizes.
  // Reasons reported are those of the newest candidate (stable, PHI-free).
  let firstReasons: AuthorityReasonCode[] | null = null;
  for (const att of attestations) {
    const reasons: AuthorityReasonCode[] = [];

    if (attestationContentHash(att.statementText, att.scope) !== att.contentHash) {
      reasons.push("ATTESTATION_HASH_INVALID");
    }

    const verdict = verifyAttestation(att.scope, currentItems);
    if (!verdict.valid) reasons.push("ATTESTATION_DRIFTED");

    const coveredLineages = new Set(att.scope.map((s) => s.lineageId));
    const uncovered = included.filter((it) => !coveredLineages.has(it.lineageId));
    if (uncovered.length) reasons.push("ATTESTATION_SCOPE_INCOMPLETE");

    const signer = signerFactsById.get(att.physicianId);
    if (!signer || !signer.inFirm) reasons.push("SIGNER_NOT_IN_FIRM");
    else {
      if (!signer.roleValid) reasons.push("SIGNER_ROLE_INVALID");
      if (!signer.credentialValid) reasons.push("SIGNER_CREDENTIAL_INVALID");
    }

    if (!reasons.length) {
      return {
        authorized: true,
        attestationId: att.id,
        signerUserId: att.physicianId,
        signerName: att.physicianName,
        signerCredentialSummary: att.credentialSummary,
        statementText: att.statementText,
        signedAt: att.signedAt,
        contentHash: att.contentHash,
        attestedItemCount: att.itemCount,
        attestedPresentValue: att.totalPresentValue,
        includedFingerprint: fingerprint,
        includedItemIds: included.map((it) => it.id),
        includedPresentValue: Math.round(included.reduce((s, it) => s + it.presentValue, 0)),
        includedLifetimeCost: Math.round(included.reduce((s, it) => s + it.lifetimeCost, 0)),
      };
    }
    firstReasons = firstReasons ?? reasons;
  }

  return { authorized: false, reasons: firstReasons ?? ["NO_ACTIVE_ATTESTATION"], includedFingerprint: fingerprint };
}

// ── Server-side evaluation ───────────────────────────────────────────────────

const ITEM_SELECT = {
  id: true,
  lineageId: true,
  version: true,
  service: true,
  category: true,
  probability: true,
  frequencyPerYear: true,
  durationYears: true,
  isLifetime: true,
  unitCost: true,
  presentValue: true,
  lifetimeCost: true,
  physicianStatus: true,
  supersededAt: true,
} as const;

/**
 * Evaluate whether the case's current plan may be released as a FINAL EXPERT
 * physician report. `firmId` must be the authenticated tenant's firm id — a
 * case outside that firm is reported as CASE_NOT_FOUND without revealing
 * whether it exists elsewhere.
 */
export async function evaluatePhysicianReportAuthority(opts: {
  firmId: string;
  caseId: string;
}): Promise<ExpertAuthorityDecision> {
  try {
    const kase = await prisma.case.findFirst({
      where: { id: opts.caseId, firmId: opts.firmId },
      select: { id: true, firmId: true },
    });
    if (!kase) return { authorized: false, reasons: ["CASE_NOT_FOUND"], includedFingerprint: null };

    const [rawItems, conditions, attestations] = await Promise.all([
      prisma.futureCareItem.findMany({ where: { caseId: kase.id, supersededAt: null }, select: ITEM_SELECT }),
      prisma.condition.findMany({ where: { caseId: kase.id } }),
      prisma.attestation.findMany({ where: { caseId: kase.id, firmId: kase.firmId, status: "ACTIVE" }, orderBy: { signedAt: "desc" } }),
    ]);

    const included = computeIncludedPlanItems(rawItems as unknown as FutureCareItem[], conditions as unknown as CondInput[]);

    const signerIds = [...new Set(attestations.map((a) => a.physicianId))];
    const signerFactsById = new Map<string, SignerFacts>();
    for (const signerId of signerIds) {
      const user = await prisma.user.findFirst({
        where: { id: signerId, firmId: kase.firmId, status: "ACTIVE" },
        select: { id: true, role: true },
      });
      if (!user) {
        signerFactsById.set(signerId, { inFirm: false, roleValid: false, credentialValid: false });
        continue;
      }
      let roleValid = user.role === "PHYSICIAN_REVIEWER";
      if (!roleValid) {
        const now = new Date();
        const assignment = await prisma.userRoleAssignment.findFirst({
          where: {
            userId: signerId,
            firmId: kase.firmId,
            status: "ACTIVE",
            builtInRole: "PHYSICIAN_REVIEWER",
            OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: now } }],
          },
          select: { id: true },
        });
        roleValid = !!assignment;
      }
      const credentialValid = await hasVerifiedCredential({ userId: signerId, firmId: kase.firmId }, "PHYSICIAN");
      signerFactsById.set(signerId, { inFirm: true, roleValid, credentialValid });
    }

    return decideExpertAuthority({
      attestations: attestations.map((a) => ({
        id: a.id,
        physicianId: a.physicianId,
        physicianName: a.physicianName,
        credentialSummary: a.credentialSummary,
        statementText: a.statementText,
        signedAt: a.signedAt,
        contentHash: a.contentHash,
        itemCount: a.itemCount,
        totalPresentValue: a.totalPresentValue,
        scope: (a.scope as unknown as AttestationScopeEntry[]) ?? [],
      })),
      currentItems: rawItems as unknown as AttestableItem[],
      included,
      signerFactsById,
    });
  } catch {
    // Fail closed: an inability to PROVE authority is a denial, never a pass.
    return { authorized: false, reasons: ["AUTHORITY_CHECK_FAILED"], includedFingerprint: null };
  }
}
