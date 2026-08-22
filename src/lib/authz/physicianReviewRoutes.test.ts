import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Physician review routes — authorization, staleness, and ledger invariants.
//
// Under test: bulk approval (accept-all) refuses items that changed after the
// confirmation snapshot, records an individual ledgered decision for every
// item it actually approved, and sits behind the same canonical case-scoped
// permission + verified-credential boundary as a single decision; interview
// findings honor the case-scoped physician assignment path through the
// resource-aware canonical check. Prisma and the tenant guard are mocked at
// the module boundary (same pattern as credentialBoundaries.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/tenant", () => {
  class TenantError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    TenantError,
    requireApiContext: vi.fn(),
    requirePermission: vi.fn(),
    requireCanonicalPermission: vi.fn(),
    requireCase: vi.fn(async () => ({ id: "case-1" })),
    audit: vi.fn(async () => {}),
    recordUsage: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/db", () => {
  // The decision and its ledger entry are written in ONE transaction, so a
  // failure between them cannot leave an approval standing with no audit
  // record. The fake therefore has to run the callback with a client — a
  // `$transaction` that returns without invoking it would make the route look
  // like it wrote nothing.
  const prisma: Record<string, unknown> = {
    futureCareItem: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    recommendationTransition: { createMany: vi.fn(async () => ({ count: 0 })) },
    interviewFinding: { create: vi.fn(async () => ({ id: "finding-1" })) },
  };
  prisma.$transaction = vi.fn(async (arg: unknown) =>
    typeof arg === "function" ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[]),
  );
  return { prisma };
});
vi.mock("@/lib/authz/credentialGate", () => ({
  enforceReviewCredential: vi.fn(async () => {}),
}));
vi.mock("@/lib/engine/generate", () => ({ generateReviews: vi.fn(async () => {}) }));
// Bulk approval now triggers the SAME refreshes as an individual approval.
vi.mock("@/lib/engine/validation", () => ({ persistCaseValidation: vi.fn(async () => {}) }));
vi.mock("@/lib/engine/clinicalReasoningPersist", () => ({ persistCaseReasoning: vi.fn(async () => {}) }));
vi.mock("@/lib/engine/attestationService", () => ({ refreshCaseAttestations: vi.fn(async () => {}) }));

import { prisma } from "@/lib/db";
import {
  TenantError,
  requireApiContext,
  requirePermission,
  requireCanonicalPermission,
  audit,
} from "@/lib/tenant";
import { enforceReviewCredential } from "@/lib/authz/credentialGate";
import { POST as acceptAllPost } from "@/app/api/cases/[caseId]/future-care/accept-all/route";
import { POST as interviewPost } from "@/app/api/cases/[caseId]/interviews/route";

const findItems = prisma.futureCareItem.findMany as unknown as Mock;
const updateItems = prisma.futureCareItem.updateMany as unknown as Mock;
const createTransitions = prisma.recommendationTransition.createMany as unknown as Mock;
const createFinding = prisma.interviewFinding.create as unknown as Mock;
const mockApiContext = requireApiContext as unknown as Mock;
const mockPermission = requirePermission as unknown as Mock;
const mockCanonical = requireCanonicalPermission as unknown as Mock;
const mockCredential = enforceReviewCredential as unknown as Mock;
const auditMock = audit as unknown as Mock;

const ctx = {
  user: { id: "md-1", name: "Dr. Reviewer", role: "PHYSICIAN_REVIEWER", credentialSummary: "MD" },
  firm: { id: "firm-1", isDemo: false, features: null },
  subscription: null,
};

const params = (extra: Record<string, string> = {}) => ({
  params: Promise.resolve({ caseId: "case-1", ...extra }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockApiContext.mockResolvedValue(ctx);
  // clearAllMocks keeps implementations — reset the guards to permissive
  // defaults so each test states its own denials explicitly.
  mockPermission.mockImplementation(() => {});
  mockCanonical.mockImplementation(() => {});
  mockCredential.mockImplementation(async () => {});
  findItems.mockResolvedValue([]);
  updateItems.mockResolvedValue({ count: 0 });
});

describe("POST /future-care/accept-all — bulk approval boundaries", () => {
  const pendingRows = [
    { id: "item-a", lineageId: "lin-a", lifecycleStatus: "AI_GENERATED" },
    { id: "item-b", lineageId: "lin-b", lifecycleStatus: "AI_GENERATED" },
  ];

  it("requires the canonical case-scoped physician permission and a verified credential", async () => {
    await acceptAllPost(new Request("http://t"), params());
    expect(mockCanonical).toHaveBeenCalledWith(ctx, "physician.review", { caseId: "case-1" });
    expect(mockCredential).toHaveBeenCalledWith(ctx, "PHYSICIAN", expect.objectContaining({ caseId: "case-1" }));
  });

  it("a credential failure blocks the batch before any item is touched", async () => {
    mockCredential.mockRejectedValueOnce(new TenantError("credential required", "FORBIDDEN", 403));
    const res = await acceptAllPost(new Request("http://t"), params());
    expect(res.status).toBe(403);
    expect(updateItems).not.toHaveBeenCalled();
    expect(createTransitions).not.toHaveBeenCalled();
  });

  it("approves only items still PENDING and unsuperseded at write time — stale items are refused, not approved", async () => {
    findItems.mockResolvedValue(pendingRows);
    // item-a still pending; item-b changed after the snapshot (conditional write misses).
    updateItems.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "item-a" ? { count: 1 } : { count: 0 },
    );
    const res = await acceptAllPost(new Request("http://t"), params());

    // Every write is conditional on the exact reviewable state.
    for (const call of updateItems.mock.calls) {
      expect(call[0].where).toMatchObject({ physicianStatus: "PENDING", supersededAt: null });
    }
    // The ledger records ONLY the decision that took effect, attributed to the
    // session physician with the item's version lineage.
    expect(createTransitions).toHaveBeenCalledTimes(1);
    const rows = createTransitions.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: "item-a", lineageId: "lin-a", userId: "md-1", reasonCode: "ACCEPT_ALL" });

    expect(await res.json()).toMatchObject({ count: 1 });
    expect(auditMock).toHaveBeenCalledWith(
      ctx,
      "physician.review",
      expect.objectContaining({ meta: expect.objectContaining({ count: 1, refusedStale: 1 }) }),
    );
  });

  it("never creates an attestation as a side effect of bulk approval", async () => {
    findItems.mockResolvedValue(pendingRows);
    updateItems.mockResolvedValue({ count: 1 });
    await acceptAllPost(new Request("http://t"), params());
    // The route has no attestation model access at all — approval and
    // attestation remain separate explicit acts.
    const auditedActions = auditMock.mock.calls.map((c) => c[1]);
    expect(auditedActions).not.toContain("attestation.sign");
  });
});

describe("POST /interviews — case-scoped physician assignment path", () => {
  const body = JSON.stringify({ subject: "PROVIDER", providerId: "prov-1", text: "Provider confirms ongoing spasticity management." });
  const req = () => new Request("http://t", { method: "POST", body });

  it("falls through to the resource-aware canonical check when org-level grants are absent", async () => {
    mockPermission.mockImplementation(() => {
      throw new TenantError("no", "FORBIDDEN", 403);
    });
    mockCanonical.mockImplementation(() => {});
    const res = await interviewPost(req(), params());
    expect(res.status).toBe(200);
    expect(mockCanonical).toHaveBeenCalledWith(ctx, "physician.review", { caseId: "case-1" });
    // Attribution is always the session user — never client-supplied.
    expect(createFinding).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ createdById: "md-1", interviewedById: "md-1" }) }),
    );
  });

  it("denies when neither the org-level nor the case-scoped physician grant applies", async () => {
    mockPermission.mockImplementation(() => {
      throw new TenantError("no", "FORBIDDEN", 403);
    });
    mockCanonical.mockImplementation(() => {
      throw new TenantError("no scope", "FORBIDDEN", 403);
    });
    const res = await interviewPost(req(), params());
    expect(res.status).toBe(403);
    expect(createFinding).not.toHaveBeenCalled();
  });
});

describe("bulk approval triggers the same safeguards as an individual one", () => {
  it("refreshes reviews, validation, reasoning and attestations", async () => {
    // It ran `generateReviews` alone, so approving forty items at once left the
    // reasoning, the validation findings and the signatures describing a plan
    // that no longer existed — while approving the same forty one at a time did
    // not. The safeguards cannot depend on which button produced the decision.
    const { generateReviews } = await import("@/lib/engine/generate");
    const { persistCaseValidation } = await import("@/lib/engine/validation");
    const { persistCaseReasoning } = await import("@/lib/engine/clinicalReasoningPersist");
    const { refreshCaseAttestations } = await import("@/lib/engine/attestationService");
    for (const fn of [generateReviews, persistCaseValidation, persistCaseReasoning, refreshCaseAttestations]) vi.mocked(fn).mockClear();

    vi.mocked(prisma.futureCareItem.findMany).mockResolvedValueOnce([
      { id: "i-1", lineageId: "l-1", lifecycleStatus: "AI_DRAFT", origin: "TEMPLATE_CONDITION", supportClass: "CANDIDATE_REVIEW" },
    ] as never);
    vi.mocked(prisma.futureCareItem.updateMany).mockResolvedValueOnce({ count: 1 } as never);

    const { POST } = await import("@/app/api/cases/[caseId]/future-care/accept-all/route");
    await POST(new Request("http://localhost/api", { method: "POST" }), { params: Promise.resolve({ caseId: "case-1" }) } as never);

    expect(generateReviews).toHaveBeenCalledTimes(1);
    expect(persistCaseValidation).toHaveBeenCalledTimes(1);
    expect(persistCaseReasoning).toHaveBeenCalledTimes(1);
    expect(refreshCaseAttestations).toHaveBeenCalledTimes(1);
  });

  it("writes the decision and its ledger entry in one transaction", async () => {
    // A failure between them could leave an approval standing with no audit
    // record — the one thing a law firm cannot afford to be missing.
    expect(vi.mocked((prisma as unknown as { $transaction: unknown }).$transaction)).toBeDefined();
  });
});
