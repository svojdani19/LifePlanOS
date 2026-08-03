import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase, audit, type TenantContext } from "@/lib/tenant";
import { assertVerifiedCredential } from "@/lib/authz/credentialGate";
import { ok, handleError } from "@/lib/api";
import { VOC_KINDS, vocationalReadiness, type VocEntry } from "@/lib/reports/vocational";

// ─────────────────────────────────────────────────────────────────────────────
// Vocational intake API (docs/23 P4, docs/25). Structured VocationalEntry rows
// are the ONLY substrate of the Vocational Assessment report: every row carries
// a required `source` citation (never invented), and revision is by
// supersede-not-edit — rows are never mutated in place and never deleted, so
// the revision history is complete.
// ─────────────────────────────────────────────────────────────────────────────

const entrySchema = z.object({
  kind: z.enum(VOC_KINDS),
  title: z.string().min(1),
  detail: z.record(z.unknown()).default({}),
  startDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  endDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  // House rule: no vocational fact without a citation.
  source: z.string().min(3, "Every vocational entry must cite the record, interview, or publication it comes from"),
  sourceDocumentId: z.string().optional(),
  verification: z.enum(["UNVERIFIED", "VERIFIED", "DISPUTED"]).optional(),
  notes: z.string().optional(),
});

const patchSchema = entrySchema.partial();

/** Intake may be built by planners (futurecare.edit) or reviewers (physician.review). */
function requireIntakePermission(ctx: TenantContext, caseId: string): void {
  // Life-care planners and vocational experts receive this canonical permission;
  // only vocational.attest can promote an entry to VERIFIED.
  requireCanonicalPermission(ctx, "vocational.edit", { caseId });
}

/** Marking an entry VERIFIED is a reviewer act (vocational experts occupy
 *  PHYSICIAN_REVIEWER seats for the pilot — docs/25). */
function requireVerifyPermission(ctx: TenantContext, caseId: string): void {
  requireCanonicalPermission(ctx, "vocational.attest", { caseId });
}

const toDate = (s: string | undefined): Date | null | undefined => (s === undefined ? undefined : s ? new Date(s) : null);

// ── GET: current (non-superseded) entries grouped by kind + readiness ────────
export async function GET(_req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    await requireCase(ctx, params.caseId);
    requireCanonicalPermission(ctx, "vocational.view", { caseId: params.caseId });

    const entries = await prisma.vocationalEntry.findMany({
      where: { caseId: params.caseId, firmId: ctx.firm.id, supersededById: null },
      orderBy: [{ kind: "asc" }, { startDate: "asc" }, { createdAt: "asc" }],
    });

    const byKind: Record<string, typeof entries> = {};
    for (const e of entries) (byKind[e.kind] ??= []).push(e);

    // Report-level vocational approval (P2 ReportApproval) drives readiness.
    const approval = await prisma.reportApproval.findFirst({
      where: { caseId: params.caseId, firmId: ctx.firm.id, expertRole: "vocational", status: "ACTIVE" },
    });
    const readiness = vocationalReadiness(entries as unknown as VocEntry[], { approved: !!approval });

    return ok({ entries, byKind, readiness });
  } catch (err) {
    return handleError(err);
  }
}

// ── POST: create a sourced entry ─────────────────────────────────────────────
export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    await requireCase(ctx, params.caseId);
    requireIntakePermission(ctx, params.caseId);

    const input = entrySchema.parse(await req.json());
    // Marking VERIFIED is the vocational expert's sign-off — attestation-class,
    // ALWAYS gated on a verified VOCATIONAL credential (docs/26).
    if (input.verification === "VERIFIED") {
      requireVerifyPermission(ctx, params.caseId);
      await assertVerifiedCredential(ctx, "VOCATIONAL");
    }

    const entry = await prisma.vocationalEntry.create({
      data: {
        firmId: ctx.firm.id,
        caseId: params.caseId,
        kind: input.kind,
        title: input.title,
        detail: input.detail as never,
        startDate: toDate(input.startDate) ?? null,
        endDate: toDate(input.endDate) ?? null,
        source: input.source,
        sourceDocumentId: input.sourceDocumentId ?? null,
        verification: input.verification ?? "UNVERIFIED",
        notes: input.notes ?? null,
        enteredById: ctx.user.id,
      },
    });

    await audit(ctx, "vocational.entry", { type: "vocationalEntry", id: entry.id, caseId: params.caseId, meta: { kind: entry.kind } });
    return ok({ entry }, 201);
  } catch (err) {
    return handleError(err);
  }
}

// ── PATCH ?id= : supersede-not-edit (replacement row; old row points forward) ─
export async function PATCH(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    await requireCase(ctx, params.caseId);
    requireIntakePermission(ctx, params.caseId);

    const id = new URL(req.url).searchParams.get("id");
    if (!id) return ok({ error: "Query parameter `id` is required" }, 400);

    const existing = await prisma.vocationalEntry.findFirst({
      where: { id, caseId: params.caseId, firmId: ctx.firm.id, supersededById: null },
    });
    if (!existing) return ok({ error: "Entry not found (or already superseded)" }, 404);

    const input = patchSchema.parse(await req.json());
    const verification = input.verification ?? existing.verification;
    // Newly marking VERIFIED = vocational sign-off — always credential-gated.
    if (verification === "VERIFIED" && existing.verification !== "VERIFIED") {
      requireVerifyPermission(ctx, params.caseId);
      await assertVerifiedCredential(ctx, "VOCATIONAL");
    }

    const replacement = await prisma.vocationalEntry.create({
      data: {
        firmId: ctx.firm.id,
        caseId: params.caseId,
        kind: input.kind ?? existing.kind,
        title: input.title ?? existing.title,
        detail: (input.detail ?? existing.detail) as never,
        startDate: input.startDate !== undefined ? toDate(input.startDate) : existing.startDate,
        endDate: input.endDate !== undefined ? toDate(input.endDate) : existing.endDate,
        source: input.source ?? existing.source,
        sourceDocumentId: input.sourceDocumentId ?? existing.sourceDocumentId,
        verification,
        notes: input.notes ?? existing.notes,
        enteredById: ctx.user.id,
      },
    });
    await prisma.vocationalEntry.update({ where: { id: existing.id }, data: { supersededById: replacement.id } });

    await audit(ctx, "vocational.entry", {
      type: "vocationalEntry",
      id: replacement.id,
      caseId: params.caseId,
      meta: { kind: replacement.kind, supersedes: existing.id },
    });
    return ok({ entry: replacement, superseded: existing.id });
  } catch (err) {
    return handleError(err);
  }
}

// ── DELETE: refused — revision history is the point ──────────────────────────
export async function DELETE() {
  return ok({ error: "Vocational entries are superseded, never deleted. Submit a replacement via PATCH instead." }, 405);
}
