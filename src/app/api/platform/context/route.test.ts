import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/tenant", () => {
  class TenantError extends Error {
    constructor(message: string, readonly code: string, readonly status: number) {
      super(message);
    }
  }
  return {
    TenantError,
    requireApiContext: vi.fn(),
    audit: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/authz/platform", () => ({ requirePlatformAdmin: vi.fn(async () => {}) }));
vi.mock("@/lib/auth/session", () => ({ setSessionSupportFirm: vi.fn(async () => {}) }));
vi.mock("@/lib/db", () => ({ prisma: { firm: { findUnique: vi.fn() } } }));

import { POST } from "./route";
import { prisma } from "@/lib/db";
import { audit, requireApiContext, TenantError } from "@/lib/tenant";
import { requirePlatformAdmin } from "@/lib/authz/platform";
import { setSessionSupportFirm } from "@/lib/auth/session";

const context = requireApiContext as unknown as Mock;
const platformGuard = requirePlatformAdmin as unknown as Mock;
const findFirm = prisma.firm.findUnique as unknown as Mock;
const setSupportFirm = setSessionSupportFirm as unknown as Mock;
const auditMock = audit as unknown as Mock;
const ACTOR_FIRM = "00000000-0000-4000-8000-000000000001";
const TARGET_FIRM = "00000000-0000-4000-8000-000000000002";

const request = (firmId: string | null) =>
  new Request("http://localhost/api/platform/context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ firmId }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  context.mockResolvedValue({
    user: { id: "platform-user", firmId: ACTOR_FIRM },
    firm: { id: ACTOR_FIRM },
    subscription: null,
    sessionId: "session-1",
  });
  platformGuard.mockResolvedValue(undefined);
  findFirm.mockResolvedValue({ name: "Target Firm" });
});

describe("platform support context", () => {
  it("stores the target on the authenticated server session and audits actor + target", async () => {
    const response = await POST(request(TARGET_FIRM));

    expect(response.status).toBe(200);
    expect(setSupportFirm).toHaveBeenCalledWith("session-1", TARGET_FIRM);
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      "platform.support_context.enter",
      expect.objectContaining({ meta: expect.objectContaining({ actorFirmId: ACTOR_FIRM, targetFirmId: TARGET_FIRM, readOnly: true }) }),
    );
  });

  it("clears support context without accepting an actor-firm impersonation", async () => {
    const response = await POST(request(ACTOR_FIRM));

    expect(response.status).toBe(200);
    expect(setSupportFirm).toHaveBeenCalledWith("session-1", null);
  });

  it("does not change the session when the platform grant is denied", async () => {
    platformGuard.mockRejectedValue(new TenantError("Platform administrator authorization required.", "FORBIDDEN", 403));

    const response = await POST(request(TARGET_FIRM));

    expect(response.status).toBe(403);
    expect(setSupportFirm).not.toHaveBeenCalled();
  });

  it("does not store a target firm that does not exist", async () => {
    findFirm.mockResolvedValue(null);

    const response = await POST(request(TARGET_FIRM));

    expect(response.status).toBe(404);
    expect(setSupportFirm).not.toHaveBeenCalled();
  });
});
