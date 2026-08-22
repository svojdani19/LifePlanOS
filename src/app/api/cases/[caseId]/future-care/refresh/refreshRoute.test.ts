// The post-review refresh retry: reachable, correctly gated, idempotent.
//
// The route existed and nothing called it, so the only remedy for a failed
// post-review refresh was a full regeneration. Its header also claimed it used
// "the same grant the review routes require" while checking futurecare.edit
// with no credential gate — a comment describing a stronger policy than the
// code enforced, which is worse than a weak gate because it is what an auditor
// would have signed off on.

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

vi.mock("@/lib/tenant", () => {
  class TenantError extends Error {
    constructor(message: string, readonly code: string, readonly status: number) { super(message); }
  }
  return {
    TenantError,
    requireApiContext: vi.fn(),
    requireCanonicalPermission: vi.fn(),
    requireCase: vi.fn(async () => ({ id: "case-1" })),
    audit: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/engine/generate", () => ({ generateReviews: vi.fn(async () => {}) }));
vi.mock("@/lib/engine/validation", () => ({ persistCaseValidation: vi.fn(async () => ({})) }));
vi.mock("@/lib/engine/clinicalReasoningPersist", () => ({ persistCaseReasoning: vi.fn(async () => {}) }));
vi.mock("@/lib/engine/attestationService", () => ({ refreshCaseAttestations: vi.fn(async () => {}) }));
vi.mock("@/lib/engine/reviewDecision", () => ({
  refreshAfterReview: vi.fn(async () => ({ failed: [] as string[] })),
  recordRefreshObligation: vi.fn(async () => {}),
}));

import { requireApiContext, requireCanonicalPermission, audit } from "@/lib/tenant";
import { refreshAfterReview, recordRefreshObligation } from "@/lib/engine/reviewDecision";
import { POST } from "./route";

const params = { params: Promise.resolve({ caseId: "case-1" }) };
const ctx = { firm: { id: "firm-1" }, user: { id: "user-1" } };

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: a test that makes the permission check
  // throw installs an implementation that clearAllMocks leaves in place, and
  // every later test in the file then silently exercises the denial path.
  vi.resetAllMocks();
  (requireCanonicalPermission as Mock).mockImplementation(() => {});
  (audit as Mock).mockResolvedValue(undefined);
  (recordRefreshObligation as Mock).mockResolvedValue(undefined);
  (requireApiContext as Mock).mockResolvedValue(ctx);
  (refreshAfterReview as Mock).mockResolvedValue({ failed: [] });
});

describe("the gate is the one the comment claims", () => {
  it("requires futurecare.edit, case-scoped", async () => {
    await POST(new Request("http://t/x", { method: "POST" }), params);
    expect(requireCanonicalPermission).toHaveBeenCalledWith(ctx, "futurecare.edit", { caseId: "case-1" });
  });

  it("does not require a physician credential — it records no clinical judgment", async () => {
    // A recompute from existing state authorises nothing. Gating it on a
    // credential would leave a planner unable to repair derived artifacts
    // after a transient failure, for no safety gain.
    const src = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(src).not.toMatch(/enforceReviewCredential/);
    expect(src).not.toMatch(/requireCanonicalPermission\(ctx,\s*"physician\.review"/);
  });

  it("says what it actually enforces", () => {
    const src = readFileSync(join(__dirname, "route.ts"), "utf8");
    // The old standalone claim, as it was written. The phrase survives inside
    // the new comment that explains what it got wrong, which is intended.
    expect(src).not.toMatch(/\/\/ The same grant the review routes require:/);
    expect(src).toMatch(/futurecare\.edit is the correct requirement/);
  });

  it("refuses when the permission check throws, and refreshes nothing", async () => {
    (requireCanonicalPermission as Mock).mockImplementation(() => { throw new Error("forbidden"); });
    const res = await POST(new Request("http://t/x", { method: "POST" }), params);
    expect(res.ok).toBe(false);
    expect(refreshAfterReview).not.toHaveBeenCalled();
  });
});

describe("the audit trail stays honest", () => {
  it("files under its own action, not the clinical-review action", async () => {
    // A recompute in the physician.review trail is an entry for something no
    // clinician did.
    await POST(new Request("http://t/x", { method: "POST" }), params);
    const action = (audit as Mock).mock.calls[0][1];
    expect(action).toBe("futurecare.refresh_retry");
    expect(action).not.toBe("physician.review");
  });
});

describe("idempotent, and durable until it actually succeeds", () => {
  it("reports COMPLETE and replaces the obligation when every stage succeeds", async () => {
    const res = await POST(new Request("http://t/x", { method: "POST" }), params);
    expect(await res.json()).toMatchObject({ refresh: { status: "COMPLETE" } });
    expect(recordRefreshObligation).toHaveBeenCalledWith(expect.anything(), "case-1", "firm-1", []);
  });

  it("keeps the obligation when a stage still fails", async () => {
    (refreshAfterReview as Mock).mockResolvedValue({ failed: ["validation", "reasoning"] });
    const res = await POST(new Request("http://t/x", { method: "POST" }), params);
    expect(await res.json()).toMatchObject({ refresh: { status: "ATTENTION_REQUIRED", failed: ["validation", "reasoning"] } });
    expect(recordRefreshObligation).toHaveBeenCalledWith(expect.anything(), "case-1", "firm-1", ["validation", "reasoning"]);
  });

  it("running it twice on a healthy case is a no-op both times", async () => {
    const a = await POST(new Request("http://t/x", { method: "POST" }), params);
    const b = await POST(new Request("http://t/x", { method: "POST" }), params);
    expect(await a.json()).toEqual(await b.json());
    // The obligation is REPLACED each run, never appended to.
    expect((recordRefreshObligation as Mock).mock.calls.every((c) => c[3].length === 0)).toBe(true);
  });

  it("a partial repair narrows the obligation rather than clearing it", async () => {
    (refreshAfterReview as Mock).mockResolvedValueOnce({ failed: ["validation", "reasoning"] });
    await POST(new Request("http://t/x", { method: "POST" }), params);
    (refreshAfterReview as Mock).mockResolvedValueOnce({ failed: ["reasoning"] });
    await POST(new Request("http://t/x", { method: "POST" }), params);
    expect((recordRefreshObligation as Mock).mock.calls[1][3]).toEqual(["reasoning"]);
  });
});

describe("reachable from the surface where the failure appears", () => {
  const root = join(__dirname, "..", "..", "..", "..", "..", "..", "..");
  const workspace = readFileSync(join(root, "src/components/case/CaseWorkspace.tsx"), "utf8");

  it("the integrity card posts to this route", () => {
    expect(workspace).toMatch(/\/api\/cases\/\$\{caseId\}\/future-care\/refresh/);
  });

  it("the action is offered on the REFRESH_INCOMPLETE finding specifically", () => {
    expect(workspace).toMatch(/REFRESH_INCOMPLETE/);
    expect(workspace).toMatch(/Retry refresh/);
  });

  it("the route it targets exists", () => {
    expect(existsSync(join(root, "src/app/api/cases/[caseId]/future-care/refresh/route.ts"))).toBe(true);
  });

  it("a still-incomplete retry is reported, not swallowed into a success", () => {
    expect(workspace).toMatch(/ATTENTION_REQUIRED/);
    expect(workspace).toMatch(/finding stays until every stage succeeds/);
  });
});
