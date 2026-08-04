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
import {
  loadClinicalBindingState,
  verifyAttestationClinicalBinding,
  type ClinicalBindingState,
} from "@/lib/engine/attestationBinding";
import { hasVerifiedCredential } from "@/lib/authz/credentialGate";
import type { FutureCareItem } from "@/generated/prisma";

/** Versioned opinion scopes an attestation can explicitly cover. A report may
 *  only render an opinion kind its authorizing attestation explicitly covers —
 *  a future-care attestation never doubles as a causation opinion. */
export type OpinionScope =
  | "FUTURE_CARE_MEDICAL_NECESSITY"
  | "FREQUENCY_AND_DURATION"
  | "CAUSATION"
  | "PROGNOSIS"
  | "LIFE_EXPECTANCY"
  | "FINANCIAL_ASSUMPTIONS";

/** The scopes every existing physician item attestation covers by construction
 *  (its statement speaks to medical necessity, frequency, and duration). */
export const DEFAULT_PHYSICIAN_SCOPES: OpinionScope[] = ["FUTURE_CARE_MEDICAL_NECESSITY", "FREQUENCY_AND_DURATION"];

export type AuthorityReasonCode =
  | "CASE_NOT_FOUND"
  | "NO_ACTIVE_ATTESTATION"
  | "ATTESTATION_HASH_INVALID"
  | "ATTESTATION_DRIFTED"
  | "ATTESTATION_SCOPE_INCOMPLETE"
  | "ATTESTATION_UNVERSIONED"
  | "OPINION_SCOPE_NOT_COVERED"
  | "CLINICAL_FINGERPRINT_MISMATCH"
  | "ASSESSMENT_NEEDS_REVIEW"
  | "ASSESSMENT_INVALID"
  | "ASSESSMENT_SUPERSEDED"
  | "ASSESSMENT_MISSING"
  | "EVIDENCE_INSUFFICIENT"
  | "BLOCKING_FINDINGS_OPEN"
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
  includedCount: number;
  includedPresentValue: number;
  includedLifetimeCost: number;
  /** SHA-256 over the included items' clinical binding states (evidence,
   *  reasoning, sufficiency, duration support). */
  clinicalFingerprint: string;
  /** SHA-256 over the case's financial assumptions + included cost fields. */
  financialFingerprint: string;
  /** SHA-256 binding clinical + financial + included set + scopes + kind —
   *  the immutable identity of the authorized report snapshot. */
  reportFingerprint: string;
  /** Opinion scopes this decision verified as covered by the attestation. */
  coveredScopes: OpinionScope[];
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

export interface FinancialAssumptions {
  lifeExpectancyYears: number | null;
  discountRate: number | null;
  medicalInflation: number | null;
  geographicFactor: number | null;
}

/** Canonical fingerprint over the financial inputs of the included set: the
 *  case-level assumptions plus each included item's cost-bearing fields.
 *  Rounding policy: raw stored values are hashed unrounded; the SINGLE place
 *  totals are rounded for comparison/storage is Math.round at the edge. */
export function financialSetFingerprint(assumptions: FinancialAssumptions, included: IncludedPlanItem[]): string {
  const canonical = {
    assumptions,
    items: included
      .map((it) => [it.lineageId, it.version, it.unitCost, it.frequencyPerYear, it.durationYears, it.isLifetime, it.presentValue, it.lifetimeCost])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Case-level clinical fingerprint: the included items' per-item clinical
 *  binding fingerprints, order-independent. */
export function clinicalSetFingerprint(included: IncludedPlanItem[], binding: Map<string, ClinicalBindingState>): string {
  const canonical = included
    .map((it) => [it.lineageId, binding.get(it.id)?.clinicalFingerprint ?? "MISSING"])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function reportSnapshotFingerprint(parts: {
  clinicalFingerprint: string;
  financialFingerprint: string;
  includedFingerprint: string;
  requiredScopes: OpinionScope[];
  reportKind: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        parts.clinicalFingerprint,
        parts.financialFingerprint,
        parts.includedFingerprint,
        [...parts.requiredScopes].sort(),
        parts.reportKind,
      ]),
    )
    .digest("hex");
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
  /** cfp-1 clinical fingerprint stored at signing; null = legacy/unversioned. */
  clinicalFingerprint: string | null;
  bindingVersion: string | null;
  /** Opinion scopes the signed statement explicitly covers; null = legacy. */
  opinionScopes: OpinionScope[] | null;
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
  /** Per-recommendation clinical binding state (assessment + evidence). */
  bindingByItem: Map<string, ClinicalBindingState>;
  /** Opinion scopes the requested report requires. */
  requiredScopes: OpinionScope[];
  /** Open export-blocking validation findings exist. */
  blockingFindingsOpen: boolean;
  assumptions: FinancialAssumptions;
  reportKind: string;
}): ExpertAuthorityDecision {
  const { attestations, currentItems, included, signerFactsById, bindingByItem, requiredScopes, blockingFindingsOpen, assumptions, reportKind } = input;
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

    // Opinion scope: the signed statement must explicitly cover every opinion
    // kind the report renders. Legacy attestations (null scopes) cover nothing
    // — they cannot authorize new finals at all (unversioned, below).
    const covered = new Set(att.opinionScopes ?? []);
    if (requiredScopes.some((sc) => !covered.has(sc))) reasons.push("OPINION_SCOPE_NOT_COVERED");

    // Clinical-evidence binding: the attestation must be bound (cfp-1) to the
    // exact assessments/evidence reviewed, and that state must still hold.
    const binding = verifyAttestationClinicalBinding(
      { clinicalFingerprint: att.clinicalFingerprint, bindingVersion: att.bindingVersion, scope: att.scope },
      bindingByItem,
      included.map((it) => it.id),
    );
    if (!binding.ok) reasons.push(...(binding.reasons as AuthorityReasonCode[]));

    if (blockingFindingsOpen) reasons.push("BLOCKING_FINDINGS_OPEN");

    const signer = signerFactsById.get(att.physicianId);
    if (!signer || !signer.inFirm) reasons.push("SIGNER_NOT_IN_FIRM");
    else {
      if (!signer.roleValid) reasons.push("SIGNER_ROLE_INVALID");
      if (!signer.credentialValid) reasons.push("SIGNER_CREDENTIAL_INVALID");
    }

    if (!reasons.length) {
      const clinicalFingerprint = clinicalSetFingerprint(included, bindingByItem);
      const financialFingerprint = financialSetFingerprint(assumptions, included);
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
        includedItemIds: included.map((it) => it.id).sort(),
        includedCount: included.length,
        includedPresentValue: Math.round(included.reduce((s, it) => s + it.presentValue, 0)),
        includedLifetimeCost: Math.round(included.reduce((s, it) => s + it.lifetimeCost, 0)),
        clinicalFingerprint,
        financialFingerprint,
        reportFingerprint: reportSnapshotFingerprint({
          clinicalFingerprint,
          financialFingerprint,
          includedFingerprint: fingerprint,
          requiredScopes,
          reportKind,
        }),
        coveredScopes: requiredScopes,
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
 * Signer role-scope rule (authorization-system semantics, fail closed):
 * an assignment qualifies only when the firm matches, status is ACTIVE
 * (SCHEDULED/REVOKED/EXPIRED never qualify), effectiveFrom <= now,
 * effectiveUntil is null or in the future, and its scope provably applies to
 * THIS case — org-wide (no caseId, no officeId) or scoped to exactly this
 * case. An office-scoped assignment cannot be proven to cover a case (cases
 * carry no office linkage), so it does not qualify. The legacy seat role
 * PHYSICIAN_REVIEWER remains an org-wide grant.
 */
async function signerRoleValidForCase(signerId: string, firmId: string, caseId: string, legacyRole: string): Promise<boolean> {
  if (legacyRole === "PHYSICIAN_REVIEWER") return true;
  const now = new Date();
  const assignment = await prisma.userRoleAssignment.findFirst({
    where: {
      userId: signerId,
      firmId,
      status: "ACTIVE",
      builtInRole: "PHYSICIAN_REVIEWER",
      officeId: null,
      OR: [{ caseId: null }, { caseId }],
      effectiveFrom: { lte: now },
      AND: [{ OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }] }],
    },
    select: { id: true },
  });
  return !!assignment;
}

/**
 * Evaluate whether the case's current plan may be released as a FINAL EXPERT
 * physician report rendering the given opinion scopes. `firmId` must be the
 * authenticated tenant's firm id — a case outside that firm is reported as
 * CASE_NOT_FOUND without revealing whether it exists elsewhere.
 */
export async function evaluateProfessionalReportAuthority(opts: {
  firmId: string;
  caseId: string;
  requiredScopes?: OpinionScope[];
  reportKind?: string;
}): Promise<ExpertAuthorityDecision> {
  const requiredScopes = opts.requiredScopes ?? DEFAULT_PHYSICIAN_SCOPES;
  const reportKind = opts.reportKind ?? "LIFE_CARE_PLAN";
  try {
    const kase = await prisma.case.findFirst({
      where: { id: opts.caseId, firmId: opts.firmId },
      select: { id: true, firmId: true, lifeExpectancyYears: true, discountRate: true, medicalInflation: true, geographicFactor: true },
    });
    if (!kase) return { authorized: false, reasons: ["CASE_NOT_FOUND"], includedFingerprint: null };

    const [rawItems, conditions, attestations, blockingOpen, bindingByItem] = await Promise.all([
      prisma.futureCareItem.findMany({ where: { caseId: kase.id, supersededAt: null }, select: ITEM_SELECT }),
      prisma.condition.findMany({ where: { caseId: kase.id } }),
      prisma.attestation.findMany({ where: { caseId: kase.id, firmId: kase.firmId, status: "ACTIVE" }, orderBy: { signedAt: "desc" } }),
      prisma.validationFinding.count({ where: { caseId: kase.id, exportBlocking: true, status: "OPEN" } }),
      loadClinicalBindingState(kase.firmId, kase.id),
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
      const roleValid = await signerRoleValidForCase(signerId, kase.firmId, kase.id, user.role);
      // Credential is checked FRESH at every evaluation (including the
      // pre-record re-evaluation) — never cached from signing time.
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
        clinicalFingerprint: (a as { clinicalFingerprint?: string | null }).clinicalFingerprint ?? null,
        bindingVersion: (a as { bindingVersion?: string | null }).bindingVersion ?? null,
        opinionScopes: ((a as { opinionScopes?: unknown }).opinionScopes as OpinionScope[] | null) ?? null,
      })),
      currentItems: rawItems as unknown as AttestableItem[],
      included,
      signerFactsById,
      bindingByItem,
      requiredScopes,
      blockingFindingsOpen: blockingOpen > 0,
      assumptions: {
        lifeExpectancyYears: kase.lifeExpectancyYears ?? null,
        discountRate: kase.discountRate ?? null,
        medicalInflation: kase.medicalInflation ?? null,
        geographicFactor: kase.geographicFactor ?? null,
      },
      reportKind,
    });
  } catch {
    // Fail closed: an inability to PROVE authority is a denial, never a pass.
    return { authorized: false, reasons: ["AUTHORITY_CHECK_FAILED"], includedFingerprint: null };
  }
}

/** Back-compatible name: the physician LCP authority with default scopes. */
export async function evaluatePhysicianReportAuthority(opts: {
  firmId: string;
  caseId: string;
}): Promise<ExpertAuthorityDecision> {
  return evaluateProfessionalReportAuthority(opts);
}
