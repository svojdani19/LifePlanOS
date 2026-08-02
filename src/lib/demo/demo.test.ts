import { describe, it, expect, vi, afterEach } from "vitest";
import {
  demoModeEnabled,
  demoPassword,
  demoPersonaByEmail,
  DEMO_PERSONAS,
  DEMO_FIRM_SLUG,
  DEV_DEFAULT_DEMO_PASSWORD,
} from "./config";
import { WORKSPACES } from "@/lib/workspaces";
import { ALL_ROLE_TEMPLATES } from "@/lib/authz/roles";
import { UserRole } from "@/generated/prisma";

// The demo login route must be testable without a database: prisma and the
// Next.js request-context helpers are mocked at the module boundary.
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("next/headers", () => ({
  headers: () => ({ get: () => null }),
  cookies: () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("demoModeEnabled", () => {
  it("is OFF in production without the explicit production ack", () => {
    expect(demoModeEnabled({ NODE_ENV: "production", ENABLE_DEMO_MODE: "true" })).toBe(false);
  });

  it("is ON in production only with ENABLE_DEMO_MODE + DEMO_MODE_PRODUCTION_ACK", () => {
    expect(
      demoModeEnabled({ NODE_ENV: "production", ENABLE_DEMO_MODE: "true", DEMO_MODE_PRODUCTION_ACK: "true" }),
    ).toBe(true);
  });

  it("is ON in development when ENABLE_DEMO_MODE=true", () => {
    expect(demoModeEnabled({ NODE_ENV: "development", ENABLE_DEMO_MODE: "true" })).toBe(true);
    expect(demoModeEnabled({ NODE_ENV: "test", ENABLE_DEMO_MODE: "true" })).toBe(true);
  });

  it("is OFF whenever ENABLE_DEMO_MODE is not exactly \"true\"", () => {
    expect(demoModeEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(demoModeEnabled({ NODE_ENV: "development", ENABLE_DEMO_MODE: "1" })).toBe(false);
    expect(demoModeEnabled({ NODE_ENV: "production", DEMO_MODE_PRODUCTION_ACK: "true" })).toBe(false);
  });
});

describe("demoPassword", () => {
  it("uses DEMO_PASSWORD when set, in any environment", () => {
    expect(demoPassword({ NODE_ENV: "production", DEMO_PASSWORD: "s3cret" })).toBe("s3cret");
    expect(demoPassword({ NODE_ENV: "development", DEMO_PASSWORD: "s3cret" })).toBe("s3cret");
  });

  it("falls back to the documented default ONLY outside production", () => {
    expect(demoPassword({ NODE_ENV: "development" })).toBe(DEV_DEFAULT_DEMO_PASSWORD);
    expect(demoPassword({ NODE_ENV: "test" })).toBe(DEV_DEFAULT_DEMO_PASSWORD);
    expect(demoPassword({ NODE_ENV: "production" })).toBeNull();
  });
});

describe("persona roster", () => {
  it("has exactly 13 personas with unique demo-domain emails", () => {
    expect(DEMO_PERSONAS).toHaveLength(13);
    const emails = DEMO_PERSONAS.map((p) => p.email);
    expect(new Set(emails).size).toBe(13);
    for (const email of emails) {
      expect(email.endsWith("@demo.lifeplanos.com")).toBe(true);
    }
  });

  it("only uses valid legacy UserRole enum values", () => {
    const valid = Object.values(UserRole);
    for (const p of DEMO_PERSONAS) {
      expect(valid).toContain(p.role);
    }
  });

  it("routes every persona to a known workspace and known role templates", () => {
    for (const p of DEMO_PERSONAS) {
      expect(WORKSPACES[p.preferredWorkspace], `workspace ${p.preferredWorkspace}`).toBeDefined();
      expect(p.templateAssignments.length).toBeGreaterThan(0);
      for (const t of p.templateAssignments) {
        expect(ALL_ROLE_TEMPLATES[t], `template ${t}`).toBeDefined();
      }
    }
  });

  it("models the multi-role medical director and the read-only observer", () => {
    const director = demoPersonaByEmail("medical.director@demo.lifeplanos.com");
    expect(director?.templateAssignments).toEqual(["PHYSICIAN_REVIEWER", "QUALITY_ASSURANCE_REVIEWER"]);
    const observer = demoPersonaByEmail("observer@demo.lifeplanos.com");
    expect(observer?.role).toBe("ATTORNEY_REVIEWER");
    expect(observer?.templateAssignments).toEqual(["READ_ONLY_OBSERVER"]);
    expect(observer?.preferredWorkspace).toBe("READ_ONLY_OBSERVER");
  });

  it("looks personas up case-insensitively and rejects strangers", () => {
    expect(demoPersonaByEmail("ATTORNEY@demo.lifeplanos.com")?.email).toBe("attorney@demo.lifeplanos.com");
    expect(demoPersonaByEmail("nobody@demo.lifeplanos.com")).toBeUndefined();
    expect(DEMO_FIRM_SLUG).toBe("life-care-plan-partners-demo");
  });
});

describe("POST /api/demo/login", () => {
  const request = (email: string) =>
    new Request("http://localhost/api/demo/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

  it("returns 404 when demo mode is disabled", async () => {
    vi.stubEnv("ENABLE_DEMO_MODE", "false");
    const { POST } = await import("@/app/api/demo/login/route");
    const res = await POST(request("attorney@demo.lifeplanos.com"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for a non-persona email even when demo mode is enabled", async () => {
    vi.stubEnv("ENABLE_DEMO_MODE", "true");
    vi.stubEnv("DEMO_MODE_PRODUCTION_ACK", "true");
    const { POST } = await import("@/app/api/demo/login/route");
    const res = await POST(request("intruder@example.com"));
    expect(res.status).toBe(404);
  });
});
