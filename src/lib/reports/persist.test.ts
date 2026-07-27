import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { createHash } from "node:crypto";

// All DB and storage access is mocked — these tests never touch a database.
vi.mock("@/lib/db", () => ({
  prisma: { reportExport: { aggregate: vi.fn(), create: vi.fn() } },
}));
vi.mock("@/lib/storage", () => ({
  putObject: vi.fn(),
  deleteObject: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { putObject, deleteObject } from "@/lib/storage";
import { createExportWithVersion, storeAndRecord, approvalStale, ExportRecordError, type ExportCreateData } from "./persist";

const aggregate = prisma.reportExport.aggregate as unknown as Mock;
const create = prisma.reportExport.create as unknown as Mock;
const mockPut = putObject as unknown as Mock;
const mockDelete = deleteObject as unknown as Mock;

const BASE: Omit<ExportCreateData, "storageKey" | "contentSha256"> = {
  caseId: "case-1",
  firmId: "firm-1",
  reportType: "MEDICAL_CHRONOLOGY",
  format: "DOCX",
  template: "NEUTRAL",
  draft: false,
  generatedById: "user-1",
  itemCount: 0,
  totalLifetimeCost: 0,
  totalPresentValue: 0,
};

beforeEach(() => {
  aggregate.mockReset();
  create.mockReset();
  mockPut.mockReset().mockResolvedValue("objects/stored-key.docx");
  mockDelete.mockReset().mockResolvedValue(undefined);
});

describe("createExportWithVersion — concurrency-safe versioning", () => {
  it("retries on a P2002 unique violation and lands on the recomputed version", async () => {
    // First attempt: max version 3 → tries 4, but a concurrent writer already
    // took 4 (P2002). Retry recomputes max = 4 → creates version 5.
    aggregate
      .mockResolvedValueOnce({ _max: { version: 3 } })
      .mockResolvedValueOnce({ _max: { version: 4 } });
    create
      .mockRejectedValueOnce({ code: "P2002", meta: { target: "report_version_series" } })
      .mockImplementationOnce(async ({ data }: { data: { version: number } }) => data);

    const row = await createExportWithVersion({ ...BASE, storageKey: "k", contentSha256: "h" });

    expect(row.version).toBe(5);
    expect(create).toHaveBeenCalledTimes(2); // only ONE row was ever inserted
    expect(aggregate).toHaveBeenCalledTimes(2); // version recomputed each attempt
  });

  it("starts a fresh series at version 1 when no export of the type exists", async () => {
    aggregate.mockResolvedValue({ _max: { version: null } });
    create.mockImplementation(async ({ data }: { data: { version: number } }) => data);
    const row = await createExportWithVersion({ ...BASE, storageKey: "k", contentSha256: "h" });
    expect(row.version).toBe(1);
  });

  it("gives up after 5 attempts of persistent P2002 conflicts", async () => {
    aggregate.mockResolvedValue({ _max: { version: 1 } });
    create.mockRejectedValue({ code: "P2002" });
    await expect(createExportWithVersion({ ...BASE, storageKey: "k", contentSha256: "h" })).rejects.toBeTruthy();
    expect(create).toHaveBeenCalledTimes(5);
  });

  it("does not retry (propagates) a non-P2002 error", async () => {
    aggregate.mockResolvedValue({ _max: { version: 1 } });
    create.mockRejectedValue(new Error("connection reset"));
    await expect(createExportWithVersion({ ...BASE, storageKey: "k", contentSha256: "h" })).rejects.toThrow("connection reset");
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("storeAndRecord — parallel exports against an in-memory unique index", () => {
  it("assigns distinct versions to two concurrent exports of the same type", async () => {
    // In-memory stand-in for the report_version_series unique constraint: the
    // create mock atomically (single-threaded) checks-and-inserts, throwing
    // P2002 on a duplicate (caseId, reportType, version) exactly like Postgres.
    const rows = new Set<string>();
    aggregate.mockImplementation(async ({ where }: { where: { caseId: string; reportType: string | null } }) => {
      let max = 0;
      for (const k of rows) {
        const [cid, rt, v] = k.split("|");
        if (cid === where.caseId && rt === String(where.reportType)) max = Math.max(max, Number(v));
      }
      return { _max: { version: max || null } };
    });
    create.mockImplementation(async ({ data }: { data: { caseId: string; reportType: string; version: number } }) => {
      const k = `${data.caseId}|${data.reportType}|${data.version}`;
      if (rows.has(k)) throw { code: "P2002", meta: { target: "report_version_series" } };
      rows.add(k);
      return data;
    });
    mockPut.mockImplementation(async () => `objects/${Math.random().toString(36).slice(2)}.docx`);

    const buf = Buffer.from("report bytes");
    const [a, b] = await Promise.all([storeAndRecord(buf, ".docx", BASE), storeAndRecord(buf, ".docx", BASE)]);

    expect(new Set([a.version, b.version])).toEqual(new Set([1, 2])); // no duplicate version
    expect(rows.size).toBe(2); // exactly one row per export
    expect(mockDelete).not.toHaveBeenCalled(); // both were recorded — nothing compensated
  });

  it("stamps the sha-256 of the exact stored bytes", async () => {
    aggregate.mockResolvedValue({ _max: { version: null } });
    create.mockImplementation(async ({ data }: { data: unknown }) => data);
    const buf = Buffer.from("the final buffer");
    const row = await storeAndRecord(buf, ".html", BASE);
    expect(row.contentSha256).toBe(createHash("sha256").update(buf).digest("hex"));
    expect(row.storageKey).toBe("objects/stored-key.docx");
  });
});

describe("storeAndRecord — storage compensation", () => {
  it("deletes the stored object and raises a controlled PHI-free error when the row cannot be recorded", async () => {
    aggregate.mockResolvedValue({ _max: { version: null } });
    create.mockRejectedValue(new Error("db unreachable: host neon-phi-cluster"));

    await expect(storeAndRecord(Buffer.from("x"), ".docx", BASE)).rejects.toThrow(
      "Export could not be recorded; the stored file was removed.",
    );
    await expect(storeAndRecord(Buffer.from("x"), ".docx", BASE)).rejects.toBeInstanceOf(ExportRecordError);
    expect(mockDelete).toHaveBeenCalledWith("objects/stored-key.docx"); // orphaned PHI object removed
  });

  it("compensates even when P2002 retries are exhausted", async () => {
    aggregate.mockResolvedValue({ _max: { version: 1 } });
    create.mockRejectedValue({ code: "P2002" });
    await expect(storeAndRecord(Buffer.from("x"), ".docx", BASE)).rejects.toBeInstanceOf(ExportRecordError);
    expect(mockDelete).toHaveBeenCalledWith("objects/stored-key.docx");
  });
});

describe("approvalStale", () => {
  const HASH = "a".repeat(64);

  it("is false when the signature hash matches the export's content hash", () => {
    expect(approvalStale({ contentSha256: HASH }, { contentSha256: HASH })).toBe(false);
  });

  it("is true when the export's content differs from what was signed", () => {
    expect(approvalStale({ contentSha256: HASH }, { contentSha256: "b".repeat(64) })).toBe(true);
  });

  it("is true when the export carries no content hash at all", () => {
    expect(approvalStale({ contentSha256: HASH }, { contentSha256: null })).toBe(true);
  });
});
