// Professional-authority gate — the decision that determines whether a report
// may be represented as a final expert report. The core is pure; the wrapper
// is exercised for tenant scoping, role-scope query semantics, and fail-closed
// behavior. Clinical-evidence binding has its own module and suite; here it is
// mocked at the module boundary with a contract-faithful default: a candidate
// without a stored clinical fingerprint is ATTESTATION_UNVERSIONED, everything
// else passes unless a test overrides the verifier.

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  caseFindFirst: vi.fn(),
  itemFindMany: vi.fn(),
  conditionFindMany: vi.fn(),
  attestationFindMany: vi.fn(),
  userFindFirst: vi.fn(),
  assignmentFindFirst: vi.fn(),
  credentialFindMany: vi.fn(),
  findingCount: vi.fn(),
}));

const binding = vi.hoisted(() => ({
  loadClinicalBindingState: vi.fn(async () => new Map()),
  verifyAttestationClinicalBinding: vi.fn(
    (att: { clinicalFingerprint: string | null }) =>
      att.clinicalFingerprint == null
        ? { ok: false, reasons: ["ATTESTATION_UNVERSIONED"] }
        : { ok: true, reasons: [] },
  ),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    case: { findFirst: db.caseFindFirst },
    futureCareItem: { findMany: db.itemFindMany },
    condition: { findMany: db.conditionFindMany },
    attestation: { findMany: db.attestationFindMany },
    user: { findFirst: db.userFindFirst },
    userRoleAssignment: { findFirst: db.assignmentFindFirst },
    userCredential: { findMany: db.credentialFindMany },
    validationFinding: { count: db.findingCount },
  },
}));

vi.mock("@/lib/engine/attestationBinding", () => binding);

import {
  decideExpertAuthority,
  includedSetFingerprint,
  financialSetFingerprint,
  evaluatePhysicianReportAuthority,
  evaluateProfessionalReportAuthority,
  DEFAULT_PHYSICIAN_SCOPES,
  type AttestationCandidate,
  type IncludedPlanItem,
  type SignerFacts,
  type OpinionScope,
} from "./professionalAuthority";
import { attestationContentHash, buildAttestationScope, type AttestableItem } from "@/lib/engine/attestation";

function item(over: Partial<IncludedPlanItem> & { id: string; lineageId: string }): IncludedPlanItem {
  return {
    version: 1,
    service: `svc-${over.id}`,
    category: "PHYSICIAN_VISIT",
    probability: "PROBABLE",
    frequencyPerYear: 2,
    durationYears: null,
    isLifetime: true,
    unitCost: 200,
    presentValue: 1000,
    lifetimeCost: 1200,
    physicianStatus: "APPROVED",
    ...over,
  } as IncludedPlanItem;
}

function attestable(it: IncludedPlanItem): AttestableItem {
  return { ...it, supersededAt: null };
}

function makeAttestation(items: IncludedPlanItem[], over: Partial<AttestationCandidate> = {}): AttestationCandidate {
  const scope = buildAttestationScope(items.map(attestable));
  const statementText = "signed statement";
  return {
    id: "att-1",
    physicianId: "md-1",
    physicianName: "Dr. Test, MD",
    credentialSummary: "Board certified",
    statementText,
    signedAt: new Date("2026-01-01T00:00:00Z"),
    contentHash: attestationContentHash(statementText, scope),
    itemCount: scope.length,
    totalPresentValue: scope.reduce((s, e) => s + e.presentValue, 0),
    scope,
    clinicalFingerprint: "cfp-1:test",
    bindingVersion: "cfp-1",
    opinionScopes: [...DEFAULT_PHYSICIAN_SCOPES],
    ...over,
  };
}

const GOOD_SIGNER: SignerFacts = { inFirm: true, roleValid: true, credentialValid: true };
const signerMap = (facts: SignerFacts = GOOD_SIGNER) => new Map([["md-1", facts]]);

const ASSUMPTIONS = { lifeExpectancyYears: 30, discountRate: 0.03, medicalInflation: 0.04, geographicFactor: 1 };

function decide(over: Partial<Parameters<typeof decideExpertAuthority>[0]> & { items?: IncludedPlanItem[] } = {}) {
  const items = over.items ?? [item({ id: "a", lineageId: "L1" })];
  return decideExpertAuthority({
    attestations: over.attestations ?? [makeAttestation(items)],
    currentItems: over.currentItems ?? items.map(attestable),
    included: over.included ?? items,
    signerFactsById: over.signerFactsById ?? signerMap(),
    bindingByItem: over.bindingByItem ?? new Map(),
    requiredScopes: over.requiredScopes ?? [...DEFAULT_PHYSICIAN_SCOPES],
    blockingFindingsOpen: over.blockingFindingsOpen ?? false,
    assumptions: over.assumptions ?? ASSUMPTIONS,
    reportKind: over.reportKind ?? "LIFE_CARE_PLAN",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  binding.verifyAttestationClinicalBinding.mockImplementation(
    (att: { clinicalFingerprint: string | null }) =>
      att.clinicalFingerprint == null
        ? { ok: false, reasons: ["ATTESTATION_UNVERSIONED"] }
        : { ok: true, reasons: [] },
  );
  binding.loadClinicalBindingState.mockResolvedValue(new Map());
});

describe("decideExpertAuthority (pure)", () => {
  it("denies with NO_ACTIVE_ATTESTATION when none exist", () => {
    const d = decide({ attestations: [] });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toContain("NO_ACTIVE_ATTESTATION");
  });

  it("authorizes a valid, current, fully covering, scope-covering attestation", () => {
    const d = decide();
    expect(d.authorized).toBe(true);
    if (d.authorized) {
      expect(d.attestationId).toBe("att-1");
      expect(d.includedCount).toBe(1);
      expect(d.clinicalFingerprint).toBeTruthy();
      expect(d.financialFingerprint).toBeTruthy();
      expect(d.reportFingerprint).toBeTruthy();
      expect(d.coveredScopes).toEqual(DEFAULT_PHYSICIAN_SCOPES);
    }
  });

  it("denies a tampered statement (hash invalid)", () => {
    const items = [item({ id: "a", lineageId: "L1" })];
    const att = makeAttestation(items, { statementText: "altered after signing" });
    const d = decide({ items, attestations: [att] });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toContain("ATTESTATION_HASH_INVALID");
  });

  it("denies when a covered recommendation drifted since signing", () => {
    const items = [item({ id: "a", lineageId: "L1" })];
    const att = makeAttestation(items);
    const drifted = [item({ id: "a", lineageId: "L1", frequencyPerYear: 9 })];
    const d = decide({ attestations: [att], currentItems: drifted.map(attestable), included: drifted });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toContain("ATTESTATION_DRIFTED");
  });

  it("denies when the attestation covers only part of the included totals", () => {
    const a1 = item({ id: "a", lineageId: "L1" });
    const a2 = item({ id: "b", lineageId: "L2" });
    const att = makeAttestation([a1]);
    const d = decide({ attestations: [att], currentItems: [a1, a2].map(attestable), included: [a1, a2] });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toContain("ATTESTATION_SCOPE_INCOMPLETE");
  });

  it("denies when the required opinion scope is not covered (causation vs future-care)", () => {
    const d = decide({ requiredScopes: [...DEFAULT_PHYSICIAN_SCOPES, "CAUSATION" as OpinionScope] });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toContain("OPINION_SCOPE_NOT_COVERED");
  });

  it("denies a legacy attestation with no opinion scopes and no clinical fingerprint", () => {
    const items = [item({ id: "a", lineageId: "L1" })];
    const att = makeAttestation(items, { opinionScopes: null, clinicalFingerprint: null, bindingVersion: null });
    const d = decide({ items, attestations: [att] });
    expect(d.authorized).toBe(false);
    if (!d.authorized) {
      expect(d.reasons).toContain("OPINION_SCOPE_NOT_COVERED");
      expect(d.reasons).toContain("ATTESTATION_UNVERSIONED");
    }
  });

  it("surfaces clinical-binding failures (stale assessment, insufficiency) as denial reasons", () => {
    binding.verifyAttestationClinicalBinding.mockReturnValue({
      ok: false,
      reasons: ["ASSESSMENT_NEEDS_REVIEW", "EVIDENCE_INSUFFICIENT"],
    });
    const d = decide();
    expect(d.authorized).toBe(false);
    if (!d.authorized) {
      expect(d.reasons).toContain("ASSESSMENT_NEEDS_REVIEW");
      expect(d.reasons).toContain("EVIDENCE_INSUFFICIENT");
    }
  });

  it("denies while export-blocking validation findings are open", () => {
    const d = decide({ blockingFindingsOpen: true });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toContain("BLOCKING_FINDINGS_OPEN");
  });

  it.each([
    [{ inFirm: false, roleValid: false, credentialValid: false }, "SIGNER_NOT_IN_FIRM"],
    [{ inFirm: true, roleValid: false, credentialValid: true }, "SIGNER_ROLE_INVALID"],
    [{ inFirm: true, roleValid: true, credentialValid: false }, "SIGNER_CREDENTIAL_INVALID"],
  ] as const)("denies signer facts %o with %s", (facts, code) => {
    const d = decide({ signerFactsById: signerMap(facts as SignerFacts) });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toContain(code);
  });

  it("never falls back to another candidate silently — an older valid attestation still authorizes explicitly", () => {
    const items = [item({ id: "a", lineageId: "L1" })];
    const bad = makeAttestation(items, { id: "att-new", statementText: "tampered" });
    const good = makeAttestation(items, { id: "att-old" });
    const d = decide({ items, attestations: [bad, good] });
    expect(d.authorized).toBe(true);
    if (d.authorized) expect(d.attestationId).toBe("att-old");
  });

  it("fingerprints are deterministic and order-independent; financial fingerprint tracks assumptions", () => {
    const a1 = item({ id: "a", lineageId: "L1" });
    const a2 = item({ id: "b", lineageId: "L2", presentValue: 500 });
    expect(includedSetFingerprint([a1, a2])).toBe(includedSetFingerprint([a2, a1]));
    expect(financialSetFingerprint(ASSUMPTIONS, [a1, a2])).toBe(financialSetFingerprint(ASSUMPTIONS, [a2, a1]));
    expect(financialSetFingerprint({ ...ASSUMPTIONS, discountRate: 0.05 }, [a1, a2])).not.toBe(
      financialSetFingerprint(ASSUMPTIONS, [a1, a2]),
    );
  });
});

describe("evaluateProfessionalReportAuthority (server wrapper)", () => {
  it("reports CASE_NOT_FOUND for a wrong-firm case without leaking existence", async () => {
    db.caseFindFirst.mockResolvedValue(null);
    const d = await evaluateProfessionalReportAuthority({ firmId: "firm-other", caseId: "case-1" });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toEqual(["CASE_NOT_FOUND"]);
  });

  it("fails closed with AUTHORITY_CHECK_FAILED on any evaluation error", async () => {
    db.caseFindFirst.mockRejectedValue(new Error("db down"));
    const d = await evaluatePhysicianReportAuthority({ firmId: "f1", caseId: "c1" });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toEqual(["AUTHORITY_CHECK_FAILED"]);
  });

  it("enforces role-scope semantics in the assignment query: ACTIVE, effective now, office-unscoped, this case or org-wide", async () => {
    db.caseFindFirst.mockResolvedValue({ id: "c1", firmId: "f1", lifeExpectancyYears: 30, discountRate: 0.03, medicalInflation: 0.04, geographicFactor: 1 });
    db.itemFindMany.mockResolvedValue([]);
    db.conditionFindMany.mockResolvedValue([]);
    db.findingCount.mockResolvedValue(0);
    db.attestationFindMany.mockResolvedValue([
      {
        id: "att-1", physicianId: "md-1", physicianName: "Dr. A", credentialSummary: null,
        statementText: "s", signedAt: new Date(), contentHash: "h", itemCount: 0, totalPresentValue: 0,
        scope: [], clinicalFingerprint: "cfp-1:x", bindingVersion: "cfp-1", opinionScopes: DEFAULT_PHYSICIAN_SCOPES,
      },
    ]);
    // Signer holds no legacy physician seat → the assignment query decides.
    db.userFindFirst.mockResolvedValue({ id: "md-1", role: "PLANNER" });
    db.assignmentFindFirst.mockResolvedValue(null);
    db.credentialFindMany.mockResolvedValue([]);

    await evaluateProfessionalReportAuthority({ firmId: "f1", caseId: "c1" });

    expect(db.assignmentFindFirst).toHaveBeenCalledTimes(1);
    const where = db.assignmentFindFirst.mock.calls[0][0].where;
    expect(where.status).toBe("ACTIVE");
    expect(where.builtInRole).toBe("PHYSICIAN_REVIEWER");
    // Office-scoped assignments cannot be proven to cover a case → excluded.
    expect(where.officeId).toBeNull();
    // Only org-wide or THIS case's assignment qualifies — never another case's.
    expect(where.OR).toEqual([{ caseId: null }, { caseId: "c1" }]);
    // A future-dated assignment must not authorize before its effective date.
    expect(where.effectiveFrom.lte).toBeInstanceOf(Date);
    expect(where.AND[0].OR).toEqual([{ effectiveUntil: null }, { effectiveUntil: { gt: expect.any(Date) } }]);
  });

  it("legacy PHYSICIAN_REVIEWER seat qualifies org-wide without an assignment lookup", async () => {
    db.caseFindFirst.mockResolvedValue({ id: "c1", firmId: "f1", lifeExpectancyYears: 30, discountRate: 0.03, medicalInflation: 0.04, geographicFactor: 1 });
    db.itemFindMany.mockResolvedValue([]);
    db.conditionFindMany.mockResolvedValue([]);
    db.findingCount.mockResolvedValue(0);
    db.attestationFindMany.mockResolvedValue([
      {
        id: "att-1", physicianId: "md-1", physicianName: "Dr. A", credentialSummary: null,
        statementText: "s", signedAt: new Date(), contentHash: "h", itemCount: 0, totalPresentValue: 0,
        scope: [], clinicalFingerprint: "cfp-1:x", bindingVersion: "cfp-1", opinionScopes: DEFAULT_PHYSICIAN_SCOPES,
      },
    ]);
    db.userFindFirst.mockResolvedValue({ id: "md-1", role: "PHYSICIAN_REVIEWER" });
    db.credentialFindMany.mockResolvedValue([]);

    await evaluateProfessionalReportAuthority({ firmId: "f1", caseId: "c1" });
    expect(db.assignmentFindFirst).not.toHaveBeenCalled();
  });
});
