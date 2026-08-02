import { describe, it, expect, vi } from "vitest";

// The signup route must reject the reserved demo persona domain before any
// service code runs — those identities (including the platform Super Admin)
// exist only via demo seeding and must never be claimable through public
// registration. Dependencies are mocked at the module boundary so the test
// exercises only the route's validation.
vi.mock("@/lib/db", () => ({ prisma: { auditLog: { create: vi.fn() } } }));
vi.mock("next/headers", () => ({
  headers: () => ({ get: () => null }),
  cookies: () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
vi.mock("@/lib/auth/service", () => ({
  signupFirm: vi.fn(async () => ({ id: "u1", firmId: "f1", email: "new@firm.com" })),
}));
vi.mock("@/lib/auth/session", () => ({ createSession: vi.fn(async () => ({})) }));

import { POST } from "./route";
import { signupFirm } from "@/lib/auth/service";

function req(body: unknown): Request {
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const base = { firmName: "Test Firm", adminName: "Test Admin", password: "password123" };

describe("signup reserved-domain block", () => {
  it("rejects @demo.lifeplanos.com emails without calling the signup service", async () => {
    const res = await POST(req({ ...base, email: "platform.admin@demo.lifeplanos.com" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(signupFirm).not.toHaveBeenCalled();
  });

  it("rejects the domain case-insensitively", async () => {
    const res = await POST(req({ ...base, email: "Anyone@DEMO.LifePlanOS.com" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(signupFirm).not.toHaveBeenCalled();
  });

  it("accepts an ordinary email", async () => {
    const res = await POST(req({ ...base, email: "new@firm.com" }));
    expect(res.status).toBe(200);
    expect(signupFirm).toHaveBeenCalledTimes(1);
  });
});
