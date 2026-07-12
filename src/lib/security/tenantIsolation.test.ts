import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import fg from "fast-glob";

// ─────────────────────────────────────────────────────────────────────────────
// Tenant-isolation tests (Priority 1).
//
// 1) Behavioral: requireCase() must refuse a case belonging to another firm —
//    the query is firm-scoped, so a cross-tenant id resolves to "not found".
// 2) Conformance: every API route under /api/cases/[caseId]/ (every PHI surface:
//    documents, views, exports, downloads, validation, …) must resolve identity
//    via requireApiContext() and scope the case via requireCase(). This static
//    check makes it impossible to add a case route that forgets the guard.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({ headers: () => new Map(), cookies: () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));
vi.mock("@/lib/auth/session", () => ({ readSession: async () => null }));
vi.mock("@/lib/db", () => {
  const CASES = [
    { id: "case-a", firmId: "firm-a" },
    { id: "case-b", firmId: "firm-b" },
  ];
  return {
    prisma: {
      case: {
        // Mirrors Prisma findFirst semantics for the guard's firm-scoped query.
        findFirst: async ({ where }: { where: { id: string; firmId: string } }) =>
          CASES.find((c) => c.id === where.id && c.firmId === where.firmId) ?? null,
      },
    },
  };
});

import { requireCase, TenantError } from "@/lib/tenant";

const ctxFirmA = { user: { id: "u1", role: "ADMIN" }, firm: { id: "firm-a" }, subscription: null } as never;

describe("tenant guard — cross-firm case access", () => {
  it("returns the case when it belongs to the caller's firm", async () => {
    const c = await requireCase(ctxFirmA, "case-a");
    expect(c.id).toBe("case-a");
  });

  it("denies a case that belongs to another firm (indistinguishable from missing)", async () => {
    await expect(requireCase(ctxFirmA, "case-b")).rejects.toThrow(TenantError);
    await expect(requireCase(ctxFirmA, "case-b")).rejects.toMatchObject({ status: 404 });
  });

  it("denies a nonexistent case", async () => {
    await expect(requireCase(ctxFirmA, "nope")).rejects.toThrow(TenantError);
  });
});

describe("route conformance — every case route is tenant-guarded", () => {
  const root = join(__dirname, "../../app/api/cases/[caseId]");
  const routes = fg.sync("**/route.ts", { cwd: root, absolute: true });

  it("finds the case API routes", () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
  });

  it.each(routes.map((r) => [r.split("/api/")[1], r]))("%s resolves identity and scopes by firm", (_label, file) => {
    const src = readFileSync(file as string, "utf8");
    expect(src).toMatch(/requireApiContext\s*\(/);
    expect(src).toMatch(/requireCase\s*\(/);
  });

  it("PHI-serving routes (document view, export download) are among the guarded set", () => {
    const labels = routes.map((r) => r.split("/api/")[1]);
    expect(labels.some((l) => l.includes("documents/[docId]/view"))).toBe(true);
    expect(labels.some((l) => l.includes("export/[exportId]/download"))).toBe(true);
  });
});
