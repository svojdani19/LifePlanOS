import { describe, it, expect, vi, beforeEach } from "vitest";

// Login rate limiting (ATD-3 pilot gate): failures are throttled per-IP AND
// per-email inside the window, backed by the LoginAttempt table.

const counts = { ip: 0, email: 0 };
vi.mock("@/lib/db", () => ({
  prisma: {
    loginAttempt: {
      count: async ({ where }: { where: { ip?: string; email?: string } }) => (where.ip ? counts.ip : where.email ? counts.email : 0),
      create: async () => ({}),
    },
  },
}));

import { loginAllowed } from "./rateLimit";

beforeEach(() => {
  counts.ip = 0;
  counts.email = 0;
});

describe("loginAllowed", () => {
  it("allows a caller with no recent failures", async () => {
    expect(await loginAllowed("1.2.3.4", "a@b.com")).toBe(true);
  });

  it("blocks an IP at the failure ceiling", async () => {
    counts.ip = 10;
    expect(await loginAllowed("1.2.3.4", "a@b.com")).toBe(false);
  });

  it("blocks a targeted account even when the attacker rotates IPs", async () => {
    counts.email = 10; // many failures against this email from various IPs
    expect(await loginAllowed("5.6.7.8", "victim@firm.com")).toBe(false);
  });

  it("does not lock everyone out when the caller cannot be identified", async () => {
    counts.ip = 99; // irrelevant — no ip/email to key on
    expect(await loginAllowed(null, null)).toBe(true);
  });
});
