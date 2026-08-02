import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// Route-handler test with every side-effecting module mocked — no database, no
// session, no filesystem. The handler is invoked directly with a Request.
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
    requireApiContext: vi.fn(async () => ({ user: { id: "user-1" }, firm: { id: "firm-1" }, subscription: null })),
    requireCanonicalPermission: vi.fn(),
    requireCase: vi.fn(async () => ({ id: "case-1", caseNumber: "LCP-2026-0001" })),
    audit: vi.fn(async () => {}),
    recordUsage: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/db", () => ({
  prisma: {
    reportExport: { findFirst: vi.fn() },
    userRoleAssignment: { count: vi.fn(async () => 0) },
  },
}));
vi.mock("@/lib/storage", () => ({
  getObject: vi.fn(async () => Buffer.from("<p>report body</p>")),
}));

import { prisma } from "@/lib/db";
import { GET } from "./route";

const findFirst = prisma.reportExport.findFirst as unknown as Mock;
const assignmentCount = prisma.userRoleAssignment.count as unknown as Mock;

const PARAMS = { params: Promise.resolve({ caseId: "case-1", exportId: "export-1" }) };
const req = () => new Request("http://localhost/api/cases/case-1/export/export-1/download");

const exportRow = (over: Record<string, unknown> = {}) => ({
  id: "export-1",
  caseId: "case-1",
  firmId: "firm-1",
  format: "HTML",
  version: 2,
  reportType: "MEDICAL_CHRONOLOGY",
  storageKey: "objects/abc.html",
  draft: false,
  lifecycle: "final_expert",
  supersededById: null,
  ...over,
});

beforeEach(() => {
  findFirst.mockReset();
  assignmentCount.mockReset();
  assignmentCount.mockResolvedValue(0);
});

describe("export download route — security headers", () => {
  it("serves HTML with nosniff, no-store, no-referrer, and a strict CSP", async () => {
    findFirst.mockResolvedValue(exportRow());
    const res = await GET(req(), PARAMS);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    // Existing behavior preserved: attachment disposition with the human name.
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="LCP-2026-0001-medical-chronology-v2.html"');
  });

  it("serves DOCX with the same protections but no CSP (non-HTML)", async () => {
    findFirst.mockResolvedValue(exportRow({ format: "DOCX", storageKey: "objects/abc.docx" }));
    const res = await GET(req(), PARAMS);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("404s without a body when the export does not exist", async () => {
    findFirst.mockResolvedValue(null);
    const res = await GET(req(), PARAMS);
    expect(res.status).toBe(404);
  });

  it.each([
    { draft: true, lifecycle: "draft_expert", supersededById: null },
    { draft: false, lifecycle: "supporting", supersededById: null },
    { draft: false, lifecycle: "final_expert", supersededById: "export-2" },
  ])("does not disclose non-releasable report versions to external recipients", async (state) => {
    assignmentCount.mockResolvedValue(1);
    findFirst.mockResolvedValue(exportRow(state));

    const res = await GET(req(), PARAMS);

    expect(res.status).toBe(404);
  });

  it("allows an external recipient to download the current final report", async () => {
    assignmentCount.mockResolvedValue(1);
    findFirst.mockResolvedValue(exportRow());

    const res = await GET(req(), PARAMS);

    expect(res.status).toBe(200);
  });
});
