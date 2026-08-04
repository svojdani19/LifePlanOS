import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase, audit, TenantError, type TenantContext } from "@/lib/tenant";
import { assertVerifiedCredential, verifiedCredentialLabel } from "@/lib/authz/credentialGate";
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

/** Intake authoring — planners and vocational experts hold `vocational.edit`. */
function requireIntakePermission(ctx: TenantContext, caseId: string): void {
  // Canonical, case-scoped, feature-gated; only vocational.attest (below) can
  // promote an entry to VERIFIED.
  requireCanonicalPermission(ctx, "vocational.edit", { caseId });
}

/** Marking an entry VERIFIED is the vocational expert's own professional act —
 *  `vocational.attest`, never a physician or planner compatibility shortcut. */
function requireVerifyPermission(ctx: TenantContext, caseId: string): void {
  requireCanonicalPermission(ctx, "vocational.attest", { caseId });
}

const toDate = (s: string | undefined): Date | null | undefined => (s === undefined ? undefined : s ? new Date(s) : null);

/** A cited source document must belong to THIS case in THIS tenant — a
 *  cross-case or cross-tenant reference is rejected, never stored. */
async function assertSourceDocument(ctx: TenantContext, caseId: string, documentId: string): Promise<void> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, caseId, firmId: ctx.firm.id },
    select: { id: true },
  });
  if (!doc) {
    throw new TenantError("sourceDocumentId does not reference a document in this case.", "FORBIDDEN", 422);
  }
}

/** Vocational work product changed — any ACTIVE vocational report approval no
 *  longer covers the current content. Disclosed as STALE, never hidden. */
async function staleVocationalApprovals(caseId: string, firmId: string, reason: string): Promise<void> {
  await prisma.reportApproval.updateMany({
    where: { caseId, firmId, expertRole: "vocational", status: "ACTIVE" },
    data: { status: "STALE", invalidReason: reason },
  });
}

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
    let verifiedCredential: string | null = null;
    if (input.verification === "VERIFIED") {
      requireVerifyPermission(ctx, params.caseId);
      await assertVerifiedCredential(ctx, "VOCATIONAL");
      verifiedCredential = await verifiedCredentialLabel(ctx, "VOCATIONAL");
    }
    if (input.sourceDocumentId) await assertSourceDocument(ctx, params.caseId, input.sourceDocumentId);

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
        // Attribution of the verification act itself — the authenticated
        // expert, the moment, and the credential snapshot. Never client-sent.
        verifiedById: input.verification === "VERIFIED" ? ctx.user.id : null,
        verifiedAt: input.verification === "VERIFIED" ? new Date() : null,
        verifiedCredential,
        notes: input.notes ?? null,
        enteredById: ctx.user.id,
      },
    });

    // New content changes the substrate any signed vocational report stood on.
    await staleVocationalApprovals(params.caseId, ctx.firm.id, "vocational content added after signature");

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
    if (input.sourceDocumentId) await assertSourceDocument(ctx, params.caseId, input.sourceDocumentId);

    // Resolve the replacement's substantive fields first so materiality is
    // judged on what will actually be stored.
    const next = {
      kind: input.kind ?? existing.kind,
      title: input.title ?? existing.title,
      detail: (input.detail ?? existing.detail) as never,
      startDate: input.startDate !== undefined ? toDate(input.startDate) : existing.startDate,
      endDate: input.endDate !== undefined ? toDate(input.endDate) : existing.endDate,
      source: input.source ?? existing.source,
      sourceDocumentId: input.sourceDocumentId ?? existing.sourceDocumentId,
      notes: input.notes ?? existing.notes,
    };
    // Material = any substantive field changes (everything except notes).
    const time = (d: Date | null | undefined) => (d ? new Date(d).getTime() : null);
    const material =
      next.kind !== existing.kind ||
      next.title !== existing.title ||
      JSON.stringify(next.detail ?? null) !== JSON.stringify(existing.detail ?? null) ||
      time(next.startDate) !== time(existing.startDate) ||
      time(next.endDate) !== time(existing.endDate) ||
      next.source !== existing.source ||
      next.sourceDocumentId !== existing.sourceDocumentId;

    // Verification NEVER transfers silently across a material change (fail
    // closed): omitting `verification` is not reconfirmation. An explicit
    // VERIFIED is always a fresh professional act — vocational.attest plus a
    // verified VOCATIONAL credential, whatever the prior status was.
    let verification: string;
    let verifiedById: string | null;
    let verifiedAt: Date | null;
    let verifiedCredential: string | null;
    if (input.verification === "VERIFIED") {
      requireVerifyPermission(ctx, params.caseId);
      await assertVerifiedCredential(ctx, "VOCATIONAL");
      verification = "VERIFIED";
      verifiedById = ctx.user.id;
      verifiedAt = new Date();
      verifiedCredential = await verifiedCredentialLabel(ctx, "VOCATIONAL");
    } else if (input.verification !== undefined) {
      verification = input.verification;
      verifiedById = null;
      verifiedAt = null;
      verifiedCredential = null;
    } else if (existing.verification === "VERIFIED" && material) {
      verification = "UNVERIFIED"; // material change resets verification
      verifiedById = null;
      verifiedAt = null;
      verifiedCredential = null;
    } else {
      // Non-material replacement (notes only) — the prior verification and its
      // attribution still describe the same substantive content.
      verification = existing.verification;
      verifiedById = existing.verifiedById;
      verifiedAt = existing.verifiedAt;
      verifiedCredential = existing.verifiedCredential;
    }

    const replacement = await prisma.vocationalEntry.create({
      data: {
        firmId: ctx.firm.id,
        caseId: params.caseId,
        ...next,
        verification,
        verifiedById,
        verifiedAt,
        verifiedCredential,
        enteredById: ctx.user.id,
      },
    });
    await prisma.vocationalEntry.update({ where: { id: existing.id }, data: { supersededById: replacement.id } });

    // A material change — or any change in verification status — means signed
    // vocational report approvals no longer cover the current work product.
    if (material || verification !== existing.verification) {
      await staleVocationalApprovals(params.caseId, ctx.firm.id, "vocational content changed after signature");
    }

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
