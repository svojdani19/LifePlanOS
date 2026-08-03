// Professional-authority gate — the decision that determines whether a report
// may be represented as a final expert report. The core is pure; the wrapper
// is exercised for tenant scoping and fail-closed behavior.

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  caseFindFirst: vi.fn(),
  itemFindMany: vi.fn(),
  conditionFindMany: vi.fn(),
  attestationFindMany: vi.fn(),
  userFindFirst: vi.fn(),
  assignmentFindFirst: vi.fn(),
  credentialFindMany: vi.fn(),
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
  },
}));

import {
  decideExpertAuthority,
  includedSetFingerprint,
  evaluatePhysicianReportAuthority,
  type AttestationCandidate,
  type IncludedPlanItem,
  type SignerFacts,
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
    ...over,
  };
}

const GOOD_SIGNER: SignerFacts = { inFirm: true, roleValid: true, credentialValid: true };
const signerMap = (facts: SignerFacts = GOOD_SIGNER) => new Map([["md-1", facts]]);

describe("decideExpertAuthority (pure)", () => {
  const items = [item({ id: "a", lineageId: "L-a" }), item({ id: "b", lineageId: "L-b" })];

  it("denies with NO_ACTIVE_ATTESTATION when no attestation exists", () => {
    const d = decideExpertAuthority({ attestations: [], currentItems: items.map(attestable), included: items, signerFactsById: signerMap() });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toEqual(["NO_ACTIVE_ATTESTATION"]);
  });

  it("denies a tampered attestation (hash mismatch)", () => {
    const att = makeAttestation(items, { contentHash: "0".repeat(64) });
    const d = decideExpertAuthority({ attestations: [att], currentItems: items.map(attestable), included: items, signerFactsById: signerMap() });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toContain("ATTESTATION_HASH_INVALID");
  });

  it("denies when a covered recommendation changed materially after signing", () => {
    const att = makeAttestation(items);
    const drifted = [item({ id: "a", lineageId: "L-a", unitCost: 999 }), items[1]];
    const d = decideExpertAuthority({ attestations: [att], currentItems: drifted.map(attestable), included: drifted, signerFactsById: signerMap() });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toContain("ATTESTATION_DRIFTED");
  });

  it("denies when the attestation covers only part of the included totals", () => {
    const att = makeAttestation([items[0]]); // covers L-a only
    const d = decideExpertAuthority({ attestations: [att], currentItems: items.map(attestable), included: items, signerFactsById: signerMap() });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toContain("ATTESTATION_SCOPE_INCOMPLETE");
  });

  it("denies an included PENDING item the attestation cannot cover", () => {
    const pending = item({ id: "c", lineageId: "L-c", physicianStatus: "PENDING" });
    const all = [...items, pending];
    const att = makeAttestation(all); // scope only picks APPROVED/MODIFIED — L-c uncovered
    const d = decideExpertAuthority({ attestations: [att], currentItems: all.map(attestable), included: all, signerFactsById: signerMap() });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toContain("ATTESTATION_SCOPE_INCOMPLETE");
  });

  it("denies when the signer left the firm, lost the role, or lost the credential", () => {
    const att = makeAttestation(items);
    for (const facts of [
      { inFirm: false, roleValid: false, credentialValid: false },
      { inFirm: true, roleValid: false, credentialValid: true },
      { inFirm: true, roleValid: true, credentialValid: false },
    ] satisfies SignerFacts[]) {
      const d = decideExpertAuthority({ attestations: [att], currentItems: items.map(attestable), included: items, signerFactsById: signerMap(facts) });
      expect(d.authorized).toBe(false);
    }
  });

  it("authorizes a current, verified attestation covering the complete included set", () => {
    const att = makeAttestation(items);
    const d = decideExpertAuthority({ attestations: [att], currentItems: items.map(attestable), included: items, signerFactsById: signerMap() });
    expect(d.authorized).toBe(true);
    if (d.authorized) {
      expect(d.signerName).toBe("Dr. Test, MD");
      expect(d.attestationId).toBe("att-1");
      expect(d.includedPresentValue).toBe(2000);
      expect(d.includedFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("fingerprint changes when the included set changes and is order-independent", () => {
    const f1 = includedSetFingerprint(items);
    expect(includedSetFingerprint([...items].reverse())).toBe(f1);
    expect(includedSetFingerprint([items[0]])).not.toBe(f1);
    expect(includedSetFingerprint([item({ id: "a", lineageId: "L-a", unitCost: 999 }), items[1]])).not.toBe(f1);
  });
});

describe("evaluatePhysicianReportAuthority (wrapper)", () => {
  beforeEach(() => {
    Object.values(db).forEach((fn) => fn.mockReset());
  });

  it("reports CASE_NOT_FOUND for a wrong-firm case without leaking existence", async () => {
    db.caseFindFirst.mockResolvedValue(null); // firm-scoped lookup misses
    const d = await evaluatePhysicianReportAuthority({ firmId: "firm-other", caseId: "case-1" });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toEqual(["CASE_NOT_FOUND"]);
  });

  it("fails closed with AUTHORITY_CHECK_FAILED when authority cannot be proved", async () => {
    db.caseFindFirst.mockRejectedValue(new Error("db down"));
    const d = await evaluatePhysicianReportAuthority({ firmId: "f", caseId: "c" });
    expect(d.authorized).toBe(false);
    if (!d.authorized) expect(d.reasons).toEqual(["AUTHORITY_CHECK_FAILED"]);
  });
});
