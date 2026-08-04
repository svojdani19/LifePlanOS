import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Vocational entry integrity — the fail-closed verification rules.
//
// The regression under test (spec: CRITICAL VERIFIED-ENTRY INTEGRITY CHECK):
// the old PATCH carried `existing.verification` onto the replacement when the
// caller omitted `verification`, so a vocational.edit-only user could
// materially change a VERIFIED entry and keep it VERIFIED without holding
// vocational.attest or a verified VOCATIONAL credential. The new rules:
//   • omission is never reconfirmation — a material change resets to
//     UNVERIFIED;
//   • an explicit VERIFIED is always a fresh act: vocational.attest + verified
//     VOCATIONAL credential + attribution snapshot;
//   • the superseded row is preserved; ACTIVE vocational approvals go STALE;
//   • sourceDocumentId must reference a document in the same case + tenant.
// Prisma and the tenant guard are mocked at the module boundary.
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
vi.mock("@/lib/db", () => ({
  prisma: {
    vocationalEntry: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    reportApproval: {
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    document: { findFirst: vi.fn(async () => null) },
    userCredential: { findMany: vi.fn(async () => []) },
  },
}));

import { prisma } from "@/lib/db";
import { TenantError, requireApiContext, requireCanonicalPermission } from "@/lib/tenant";
import { POST as vocPost, PATCH as vocPatch, DELETE as vocDelete } from "@/app/api/cases/[caseId]/vocational/route";

const findFirstEntry = prisma.vocationalEntry.findFirst as unknown as Mock;
const createEntry = prisma.vocationalEntry.create as unknown as Mock;
const updateEntry = prisma.vocationalEntry.update as unknown as Mock;
const staleApprovals = prisma.reportApproval.updateMany as unknown as Mock;
const findDocument = prisma.document.findFirst as unknown as Mock;
const findCredentials = prisma.userCredential.findMany as unknown as Mock;
const mockApiContext = requireApiContext as unknown as Mock;
const mockCanonical = requireCanonicalPermission as unknown as Mock;

const ctx = {
  user: { id: "expert-1", name: "Riley Expert, CRC", role: "ATTORNEY_REVIEWER", credentialSummary: null },
  firm: { id: "firm-1", isDemo: false, features: { "report.vocational_assessment": true } },
  subscription: null,
};

const VERIFIED_ENTRY = {
  id: "entry-1",
  firmId: "firm-1",
  caseId: "case-1",
  kind: "conclusion",
  title: "Partial permanent vocational loss",
  detail: { annualLoss: "$17,540/yr" },
  startDate: null,
  endDate: null,
  source: "Vocational expert analysis 04/2026 (synthetic)",
  sourceDocumentId: null,
  verification: "VERIFIED",
  verifiedById: "expert-1",
  verifiedAt: new Date("2026-04-01T00:00:00Z"),
  verifiedCredential: "CRC (synthetic)",
  notes: null,
  supersededById: null,
};

const params = () => ({ params: Promise.resolve({ caseId: "case-1" }) });
const req = (body: Record<string, unknown>, id?: string) =>
  new Request(`http://t${id ? `?id=${id}` : ""}`, { method: "POST", body: JSON.stringify(body) });

const vocCredential = { category: "VOCATIONAL", status: "ORG_VERIFIED", expiresAt: null, label: "CRC (synthetic)" };

// Deny vocational.attest by default; individual tests grant it.
function denyAttest() {
  mockCanonical.mockImplementation((_ctx: unknown, permission: string) => {
    if (permission === "vocational.attest") throw new TenantError("no attest", "FORBIDDEN", 403);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApiContext.mockResolvedValue(ctx);
  mockCanonical.mockImplementation(() => {});
  findFirstEntry.mockResolvedValue(VERIFIED_ENTRY);
  createEntry.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "entry-2", ...data }));
  updateEntry.mockResolvedValue({});
  findDocument.mockResolvedValue(null);
  findCredentials.mockResolvedValue([]);
});

describe("PATCH — verified status never survives an unauthorized material replacement", () => {
  it("REGRESSION: a vocational.edit-only material change with `verification` omitted resets the replacement to UNVERIFIED", async () => {
    denyAttest();
    const res = await vocPatch(req({ title: "Materially different conclusion" }, "entry-1"), params());
    expect(res.status).toBe(200);
    const stored = createEntry.mock.calls[0][0].data;
    expect(stored.verification).toBe("UNVERIFIED"); // the old code carried VERIFIED here
    expect(stored.verifiedById).toBeNull();
    expect(stored.verifiedAt).toBeNull();
    expect(stored.verifiedCredential).toBeNull();
    // The original verified row is preserved in the revision chain, not erased.
    expect(updateEntry).toHaveBeenCalledWith({ where: { id: "entry-1" }, data: { supersededById: "entry-2" } });
  });

  it("a material change stales every ACTIVE vocational report approval for the case", async () => {
    denyAttest();
    await vocPatch(req({ title: "Materially different conclusion" }, "entry-1"), params());
    expect(staleApprovals).toHaveBeenCalledWith({
      where: { caseId: "case-1", firmId: "firm-1", expertRole: "vocational", status: "ACTIVE" },
      data: { status: "STALE", invalidReason: expect.any(String) },
    });
  });

  it("a notes-only (non-material) replacement carries verification AND its original attribution", async () => {
    denyAttest();
    await vocPatch(req({ notes: "formatting touch-up" }, "entry-1"), params());
    const stored = createEntry.mock.calls[0][0].data;
    expect(stored.verification).toBe("VERIFIED");
    expect(stored.verifiedById).toBe("expert-1");
    expect(stored.verifiedCredential).toBe("CRC (synthetic)");
    expect(staleApprovals).not.toHaveBeenCalled();
  });

  it("explicit VERIFIED is a fresh act: vocational.attest + verified credential, even on a material replacement", async () => {
    findCredentials.mockResolvedValue([vocCredential]);
    const res = await vocPatch(req({ title: "Corrected conclusion", verification: "VERIFIED" }, "entry-1"), params());
    expect(res.status).toBe(200);
    expect(mockCanonical).toHaveBeenCalledWith(ctx, "vocational.attest", { caseId: "case-1" });
    const stored = createEntry.mock.calls[0][0].data;
    expect(stored.verification).toBe("VERIFIED");
    // Attribution is the authenticated expert and a fresh credential snapshot.
    expect(stored.verifiedById).toBe("expert-1");
    expect(stored.verifiedAt).toBeInstanceOf(Date);
    expect(stored.verifiedCredential).toBe("CRC (synthetic)");
  });

  it("explicit VERIFIED without a verified VOCATIONAL credential is refused — no replacement row", async () => {
    findCredentials.mockResolvedValue([{ ...vocCredential, status: "SELF_REPORTED" }]);
    const res = await vocPatch(req({ verification: "VERIFIED" }, "entry-1"), params());
    expect(res.status).toBe(403);
    expect(createEntry).not.toHaveBeenCalled();
  });

  it("vocational.edit-only callers cannot mark VERIFIED at all", async () => {
    denyAttest();
    findCredentials.mockResolvedValue([vocCredential]);
    const res = await vocPatch(req({ verification: "VERIFIED" }, "entry-1"), params());
    expect(res.status).toBe(403);
    expect(createEntry).not.toHaveBeenCalled();
  });

  it("an explicit un-verify stales approvals whose signature covered the verified content", async () => {
    denyAttest();
    await vocPatch(req({ verification: "UNVERIFIED" }, "entry-1"), params());
    const stored = createEntry.mock.calls[0][0].data;
    expect(stored.verification).toBe("UNVERIFIED");
    expect(staleApprovals).toHaveBeenCalled();
  });
});

describe("sourceDocumentId — same case, same tenant, or rejected", () => {
  it("a document outside the case/tenant is refused with no row written", async () => {
    findDocument.mockResolvedValue(null);
    const res = await vocPatch(req({ sourceDocumentId: "doc-other-case" }, "entry-1"), params());
    expect(res.status).toBe(422);
    expect(createEntry).not.toHaveBeenCalled();
    // The lookup itself is scoped — never a bare findUnique on the id.
    expect(findDocument).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "doc-other-case", caseId: "case-1", firmId: "firm-1" } }),
    );
  });

  it("a same-case document is accepted and carried onto the replacement", async () => {
    findDocument.mockResolvedValue({ id: "doc-1" });
    denyAttest();
    const res = await vocPatch(req({ sourceDocumentId: "doc-1" }, "entry-1"), params());
    expect(res.status).toBe(200);
    expect(createEntry.mock.calls[0][0].data.sourceDocumentId).toBe("doc-1");
  });

  it("POST applies the same scoped validation", async () => {
    findDocument.mockResolvedValue(null);
    const res = await vocPost(
      req({ kind: "employment", title: "Job", source: "Employment records (synthetic)", sourceDocumentId: "doc-x" }),
      params(),
    );
    expect(res.status).toBe(422);
    expect(createEntry).not.toHaveBeenCalled();
  });
});

describe("POST / DELETE — revision-chain and staleness invariants", () => {
  it("POST VERIFIED stamps attribution from the authenticated expert", async () => {
    findCredentials.mockResolvedValue([vocCredential]);
    const res = await vocPost(
      req({ kind: "conclusion", title: "Conclusion", source: "Vocational analysis (synthetic)", verification: "VERIFIED" }),
      params(),
    );
    expect(res.status).toBe(201);
    const stored = createEntry.mock.calls[0][0].data;
    expect(stored.verifiedById).toBe("expert-1");
    expect(stored.verifiedCredential).toBe("CRC (synthetic)");
  });

  it("POST of new content stales ACTIVE vocational approvals — a signed report never silently covers new entries", async () => {
    await vocPost(req({ kind: "labor_market", title: "Survey", source: "Labor-market survey (synthetic)" }), params());
    expect(staleApprovals).toHaveBeenCalled();
  });

  it("DELETE is refused — entries are superseded, never deleted", async () => {
    const res = await vocDelete();
    expect(res.status).toBe(405);
  });
});
