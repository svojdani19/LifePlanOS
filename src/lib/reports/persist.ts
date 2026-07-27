import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { putObject, deleteObject } from "@/lib/storage";
import type { Prisma, ReportExport } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Report Library — export persistence (docs/23 Phase 2).
//
// Two hardening properties live here, extracted so they are unit-testable with
// a mocked prisma:
//
//   1. CONCURRENCY-SAFE VERSIONING. The old `count(...)+1` pattern races: two
//      parallel exports could both read N and both write N+1. The DB now
//      carries @@unique([caseId, reportType, version]) (report_version_series),
//      so we attempt max+1 and, on a P2002 unique violation, recompute and
//      retry. One writer wins each version; the loser lands on the next one.
//
//   2. STORAGE COMPENSATION. The stored object is written before the DB row.
//      If the row cannot be recorded, the orphaned object (PHI) is deleted and
//      a controlled, PHI-free error is raised for the route to map to a 500.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_VERSION_ATTEMPTS = 5;

/** Data for a new export row; the version is assigned here, never by callers. */
export type ExportCreateData = Omit<Prisma.ReportExportUncheckedCreateInput, "version">;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/**
 * Insert a ReportExport at the next free version of its (caseId, reportType)
 * series. On a unique-constraint collision (a concurrent export took the
 * version), the version is recomputed and the insert retried, up to
 * MAX_VERSION_ATTEMPTS times. Any other error propagates unchanged.
 */
export async function createExportWithVersion(data: ExportCreateData): Promise<ReportExport> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_VERSION_ATTEMPTS; attempt++) {
    const agg = await prisma.reportExport.aggregate({
      where: { caseId: data.caseId, reportType: data.reportType ?? null },
      _max: { version: true },
    });
    const version = (agg._max.version ?? 0) + 1;
    try {
      return await prisma.reportExport.create({ data: { ...data, version } });
    } catch (err) {
      if (isUniqueViolation(err)) {
        lastErr = err; // another writer took this version — recompute and retry
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Export version could not be assigned after repeated conflicts.");
}

/** Controlled failure of the store-then-record sequence. Carries no PHI. */
export class ExportRecordError extends Error {
  constructor() {
    super("Export could not be recorded; the stored file was removed.");
    this.name = "ExportRecordError";
  }
}

/**
 * The full persistence sequence for a generated report:
 * sha-256 the bytes → store the object → record the row (version-safe).
 * If the row cannot be recorded, the stored object is deleted (compensation —
 * no orphaned PHI) and an ExportRecordError is thrown for the route to map to
 * a controlled 500.
 */
export async function storeAndRecord(
  buffer: Buffer,
  ext: string,
  data: Omit<ExportCreateData, "storageKey" | "contentSha256">,
): Promise<ReportExport> {
  const contentSha256 = createHash("sha256").update(buffer).digest("hex");
  const storageKey = await putObject(buffer, ext);
  try {
    return await createExportWithVersion({ ...data, storageKey, contentSha256 });
  } catch {
    await deleteObject(storageKey);
    throw new ExportRecordError();
  }
}

/**
 * A report-level approval/attestation binds to the exact exported bytes via
 * contentSha256. If the export's hash differs (regenerated content) — or the
 * export carries no hash at all — the signature no longer covers what would be
 * served, and must be reported STALE (never hidden).
 */
export function approvalStale(approval: { contentSha256: string }, export_: { contentSha256: string | null }): boolean {
  return !export_.contentSha256 || approval.contentSha256 !== export_.contentSha256;
}
