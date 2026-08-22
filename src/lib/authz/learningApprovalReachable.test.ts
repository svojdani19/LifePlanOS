// STYLE approval must actually be performable by someone.
//
// The previous pass moved learning.approve onto PLATFORM_SYSTEM_ADMINISTRATOR
// and marked it platformOnly. authorize() denies every platformOnly key at
// step 1 — "no role, custom allow, or grant can rescue them" — so routing the
// decision through requireCanonicalPermission made it unreachable for
// EVERYBODY, operator included. The static role-template test passed because it
// only read the template array; it never asked the evaluator anything.
//
// These tests exercise the evaluator and the routes.

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { authorize, type AuthzContext } from "@/lib/authz/evaluate";

const NOW = new Date("2026-08-22T12:00:00Z");
const assignment = (builtInRole: string) => ({
  builtInRole,
  scopeType: "ORGANIZATION",
  scopeId: null,
  status: "ACTIVE",
  effectiveFrom: new Date("2020-01-01"),
  effectiveUntil: null,
});
const ctx = (over: Partial<AuthzContext> = {}): AuthzContext =>
  ({
    userFirmId: "firm-1",
    legacyRole: "ADMIN",
    assignments: [assignment("FIRM_ADMINISTRATOR")],
    grants: [],
    credentials: [],
    now: NOW,
    ...over,
  }) as unknown as AuthzContext;

describe("the evaluator, not the template array", () => {
  it("denies learning.approve to a firm administrator — it is platform-only", () => {
    const r = authorize({ userId: "u", firmId: "firm-1", permission: "learning.approve" }, ctx());
    expect(r.allowed).toBe(false);
    expect(r.denialCode).toBe("SYSTEM_PROHIBITION");
  });

  it("denies it to a user holding the PLATFORM template through the canonical path too", () => {
    // This is the part the template test could not see: step 1 fires before any
    // role is consulted, so putting the key on the platform template does not
    // make the canonical evaluator grant it.
    const r = authorize(
      { userId: "u", firmId: "firm-1", permission: "learning.approve" },
      ctx({ assignments: [assignment("PLATFORM_SYSTEM_ADMINISTRATOR")] as never }),
    );
    expect(r.allowed).toBe(false);
    expect(r.denialCode).toBe("SYSTEM_PROHIBITION");
  });

  it("still grants learning.view to a firm administrator", () => {
    // Seeing what a firm learned is not adopting it, and must keep working.
    expect(authorize({ userId: "u", firmId: "firm-1", permission: "learning.view" }, ctx()).allowed).toBe(true);
  });
});

// ── Routes ──────────────────────────────────────────────────────────────────

vi.mock("@/lib/tenant", () => {
  class TenantError extends Error {
    constructor(message: string, readonly code: string, readonly status: number) { super(message); }
  }
  return {
    TenantError,
    requireApiContext: vi.fn(),
    requireCanonicalPermission: vi.fn(),
    audit: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/db", () => ({
  prisma: { learningCandidate: { findUnique: vi.fn(), findFirst: vi.fn() } },
}));
vi.mock("@/lib/authz/platform", () => ({
  requirePlatformAdminWrite: vi.fn(async () => {}),
  requirePlatformAdmin: vi.fn(async () => {}),
  isPlatformAdmin: vi.fn(async () => true),
}));
vi.mock("@/lib/authz/credentialGate", () => ({
  enforceReviewCredential: vi.fn(async () => {}),
  verifiedCredentialLabel: vi.fn(async () => "MD, verified"),
}));
vi.mock("@/lib/learning/candidateService", () => {
  class CandidateStateError extends Error {}
  // The real service runs the audit writer INSIDE its transaction. A fake that
  // ignores the callback would make the route look like it never audited.
  const runWriter = async (writeAudit?: (tx: unknown, c: unknown) => Promise<void>) => {
    if (writeAudit) await writeAudit({ __tx: true }, { id: "cand-1", mechanism: "TASK_GUIDANCE", failureCode: "MISSED_SECTION", approvalClass: "STYLE" });
  };
  return {
    CandidateStateError,
    approveCandidate: vi.fn(async (_id: string, _actor: unknown, _note: unknown, writeAudit?: never) => {
      await runWriter(writeAudit);
      return { id: "cand-1", status: "ADOPTED" };
    }),
    rejectCandidate: vi.fn(async (_id: string, _actor: unknown, _reason: unknown, writeAudit?: never) => {
      await runWriter(writeAudit);
      return { id: "cand-1", status: "REJECTED_BY_REVIEWER" };
    }),
  };
});

import { prisma } from "@/lib/db";
import { requireApiContext, audit } from "@/lib/tenant";
import { requirePlatformAdminWrite } from "@/lib/authz/platform";
import { approveCandidate } from "@/lib/learning/candidateService";
import { POST as platformDecide } from "@/app/api/platform/learning/candidates/[candidateId]/decide/route";
import { POST as tenantApprove } from "@/app/api/learning/candidates/[candidateId]/approve/route";

const findUnique = (prisma as unknown as { learningCandidate: { findUnique: Mock; findFirst: Mock } }).learningCandidate;
const OPERATOR = { firm: { id: "firm-operator" }, user: { id: "op-1" } };
const params = { params: Promise.resolve({ candidateId: "cand-1" }) };
const req = (body: unknown) => new Request("http://t/x", { method: "POST", body: JSON.stringify(body) });
const row = (approvalClass: string) => ({
  id: "cand-1", firmId: "firm-tenant", approvalClass, mechanism: "TASK_GUIDANCE", failureCode: "MISSED_SECTION", status: "APPROVAL_PENDING",
});

beforeEach(() => {
  vi.clearAllMocks();
  (requireApiContext as Mock).mockResolvedValue(OPERATOR);
  (requirePlatformAdminWrite as Mock).mockResolvedValue(undefined);
});

describe("a platform administrator CAN adopt an editorial lesson", () => {
  it("succeeds, and the decision actually reaches the service", async () => {
    findUnique.findUnique.mockResolvedValue(row("STYLE"));
    const res = await platformDecide(req({ action: "approve" }), params);
    expect(res.status).toBe(200);
    expect(approveCandidate).toHaveBeenCalled();
  });

  it("scopes the decision to the CANDIDATE's firm, not the operator's context firm", async () => {
    // Passing the operator's firm would scope it to whichever tenant they were
    // viewing, and the conditional write would then match nothing.
    findUnique.findUnique.mockResolvedValue(row("STYLE"));
    await platformDecide(req({ action: "approve" }), params);
    expect(approveCandidate).toHaveBeenCalledWith("cand-1", expect.objectContaining({ firmId: "firm-tenant" }), undefined, expect.any(Function));
  });

  it("audits BOTH the actor's firm and the target's", async () => {
    findUnique.findUnique.mockResolvedValue(row("STYLE"));
    await platformDecide(req({ action: "approve" }), params);
    const meta = (audit as Mock).mock.calls[0][2].meta;
    expect(meta).toMatchObject({ platformOperator: true, actorFirmId: "firm-operator", targetFirmId: "firm-tenant" });
  });

  it("commits the audit inside the decision transaction", async () => {
    findUnique.findUnique.mockResolvedValue(row("STYLE"));
    await platformDecide(req({ action: "approve" }), params);
    // The service is handed a writer, not left to the route afterwards.
    expect((approveCandidate as Mock).mock.calls[0][3]).toBeTypeOf("function");
  });
});

describe("support impersonation stays read-only", () => {
  it("a write refused by the platform guard never reaches the service", async () => {
    (requirePlatformAdminWrite as Mock).mockRejectedValue(new Error("Platform support context is read-only."));
    findUnique.findUnique.mockResolvedValue(row("STYLE"));
    const res = await platformDecide(req({ action: "approve" }), params);
    expect(res.ok).toBe(false);
    expect(approveCandidate).not.toHaveBeenCalled();
  });

  it("the guard is the write variant, not the read one", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "..", "..", "app", "api", "platform", "learning", "candidates", "[candidateId]", "decide", "route.ts"), "utf8");
    expect(src).toMatch(/requirePlatformAdminWrite\(ctx\)/);
  });
});

describe("platform authority does not extend to clinical lessons", () => {
  it("refuses a CLINICAL candidate outright", async () => {
    findUnique.findUnique.mockResolvedValue(row("CLINICAL"));
    const res = await platformDecide(req({ action: "approve" }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "CLINICAL_NOT_PLATFORM_DECIDABLE" });
    expect(approveCandidate).not.toHaveBeenCalled();
  });

  it.each(["", "clinical", "SOMETHING_NEW", null])("refuses malformed class %o, failing closed", async (approvalClass) => {
    findUnique.findUnique.mockResolvedValue({ ...row("STYLE"), approvalClass });
    const res = await platformDecide(req({ action: "approve" }), params);
    expect(res.status).toBe(409);
    expect(approveCandidate).not.toHaveBeenCalled();
  });
});

describe("an ordinary firm administrator cannot adopt an editorial lesson", () => {
  it("the tenant route refuses STYLE and never reaches the service", async () => {
    findUnique.findFirst.mockResolvedValue({ ...row("STYLE"), status: "APPROVAL_PENDING" });
    const res = await tenantApprove(req({}), { params: Promise.resolve({ candidateId: "cand-1" }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "STYLE_NOT_TENANT_DECIDABLE" });
    expect(approveCandidate).not.toHaveBeenCalled();
  });

  it("the tenant page does not render an Adopt control for editorial lessons", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "..", "..", "app", "(app)", "settings", "learning", "page.tsx"), "utf8");
    expect(src).toMatch(/const canApproveStyle = false;/);
  });
});

describe("the operator's queue is reachable", () => {
  it("the platform-admin page renders it and it posts to the route that exists", async () => {
    const { readFileSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const root = join(__dirname, "..", "..", "..");
    expect(readFileSync(join(root, "src/app/(app)/platform-admin/page.tsx"), "utf8")).toMatch(/<PlatformLearningQueue rows=\{styleRows\}/);
    const q = readFileSync(join(root, "src/components/learning/PlatformLearningQueue.tsx"), "utf8");
    expect(q).toMatch(/\/api\/platform\/learning\/candidates\/\$\{id\}\/decide/);
    expect(existsSync(join(root, "src/app/api/platform/learning/candidates/[candidateId]/decide/route.ts"))).toBe(true);
  });

  it("the queue lists only STYLE candidates awaiting approval", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "..", "..", "app", "(app)", "platform-admin", "page.tsx"), "utf8");
    expect(src).toMatch(/status: "APPROVAL_PENDING", approvalClass: "STYLE"/);
  });
});
