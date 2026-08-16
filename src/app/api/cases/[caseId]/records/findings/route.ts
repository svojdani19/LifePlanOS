import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Dispositioning a scoped finding.
//
// Findings were persisted, allowed to block a final export, and given no way
// to be answered — so a case could be stuck behind a problem nobody could
// close. This is that answer, and it is a professional act: it is recorded
// with who made it, over exactly which finding, and over exactly which source
// state.
//
// The source fingerprint is the point. A dismissal covers the content it was
// given over; recorded here, `writeFindings` can reopen the finding when the
// source later changes, instead of carrying a stale human decision across
// content nobody has seen.
// ─────────────────────────────────────────────────────────────────────────────

/** What a human may do to a finding, and from which states. */
const TRANSITIONS: Record<string, readonly string[]> = {
  // "This is a real problem" — keeps it open and blocking, on human authority.
  confirm: ["OPEN", "DISMISSED", "RESOLVED"],
  // "This is not a problem with the record."
  dismiss: ["OPEN", "CONFIRMED"],
  // "This was a real problem and it has been dealt with."
  resolve: ["OPEN", "CONFIRMED", "DISMISSED"],
};
const RESULT_STATUS: Record<string, string> = { confirm: "CONFIRMED", dismiss: "DISMISSED", resolve: "RESOLVED" };

const bodySchema = z.object({
  /** Identity of the finding, as displayed. */
  findingId: z.string().min(1),
  action: z.enum(["confirm", "dismiss", "resolve"]),
  /**
   * The finding's stable fingerprint as displayed. A finding re-derived under
   * a different target between render and click is a different problem.
   */
  expectedFingerprint: z.string().min(1),
  /**
   * The source state the reviewer was looking at. Null is accepted only when
   * the finding itself carries none.
   */
  expectedSourceFingerprint: z.string().nullable().optional(),
  reason: z.string().max(2000).optional(),
});

type Params = { params: Promise<{ caseId: string }> };

export async function POST(req: Request, { params: paramsPromise }: Params) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "records.verify", { caseId: params.caseId });
    await requireCase(ctx, params.caseId);
    const input = bodySchema.parse(await req.json());

    // Tenant- and case-scoped by construction: a finding outside this firm's
    // case simply does not come back.
    const finding = await prisma.recordFinding.findFirst({
      where: { id: input.findingId, caseId: params.caseId, firmId: ctx.firm.id },
    });
    if (!finding) return ok({ error: "That finding is not part of this case.", applied: 0 }, 404);

    if (finding.fingerprint !== input.expectedFingerprint) {
      return ok({ error: "Nothing was changed: this finding changed since it was displayed. Reload and look again.", applied: 0 }, 409);
    }
    // The reviewer answers for the content they saw. If the source moved, the
    // answer would attach to content they were never shown.
    const shownSource = input.expectedSourceFingerprint ?? null;
    if ((finding.sourceFingerprint ?? null) !== shownSource) {
      return ok({ error: "Nothing was changed: the source content changed since this finding was displayed.", applied: 0 }, 409);
    }

    const allowedFrom = TRANSITIONS[input.action] ?? [];
    if (!allowedFrom.includes(finding.status)) {
      return ok({ error: `A finding that is ${finding.status} cannot be ${input.action}ed.`, applied: 0 }, 409);
    }

    // Closing a BLOCKING finding is a judgement someone has to stand behind,
    // so it has to be written down. Confirming one needs no justification —
    // it leaves the blocker in place.
    const reason = input.reason?.trim();
    if (finding.blocking && input.action !== "confirm" && !reason) {
      return ok({ error: "Closing a blocking finding requires a reason.", applied: 0 }, 422);
    }

    const now = new Date();
    const nextStatus = RESULT_STATUS[input.action];
    const history = Array.isArray(finding.dispositionHistory) ? (finding.dispositionHistory as unknown[]) : [];
    // Snapshot what is being replaced BEFORE anything is written. Reading it
    // back off `finding` after the update would record the new state as the
    // old one the moment that object is not a detached copy.
    const prior = {
      status: finding.status,
      reason: finding.dispositionReason ?? null,
      byId: finding.reviewedById ?? null,
      at: finding.reviewedAt ? finding.reviewedAt.toISOString() : null,
      sourceFingerprint: finding.dispositionSourceFingerprint ?? null,
      supersededBecause: `superseded by a human ${input.action}`,
    };

    const applied = await prisma.$transaction(async (tx) => {
      // Compare-and-set on the status we validated: a second reviewer acting
      // on the same finding aborts this one rather than overwriting it.
      const changed = await tx.recordFinding.updateMany({
        where: { id: finding.id, caseId: params.caseId, firmId: ctx.firm.id, status: prior.status },
        data: {
          status: nextStatus,
          dispositionReason: reason ?? null,
          reviewedById: ctx.user.id,
          reviewedAt: now,
          // Binds this decision to the content it was made over.
          dispositionSourceFingerprint: finding.sourceFingerprint ?? null,
          // The prior disposition is kept, never overwritten out of existence.
          dispositionHistory: [...history, prior] as never,
        },
      });
      if (changed.count === 0) return 0;
      // The audit event commits WITH the change. PHI-free: identifiers,
      // statuses and the reviewer's own words — never record content.
      await tx.auditLog.create({
        data: {
          firmId: ctx.firm.id,
          userId: ctx.user.id,
          action: `records.finding_${input.action}`,
          targetType: "recordFinding",
          targetId: finding.id,
          caseId: params.caseId,
          meta: {
            scope: finding.scope,
            type: finding.type,
            blocking: finding.blocking,
            priorStatus: prior.status,
            newStatus: nextStatus,
            reason: reason ?? null,
            fingerprint: finding.fingerprint,
            sourceFingerprint: finding.sourceFingerprint ?? null,
            sourceDocumentId: finding.sourceDocumentId,
            canonicalNoteId: finding.canonicalNoteId,
            encounterId: finding.encounterId,
            pageStart: finding.pageStart,
            pageEnd: finding.pageEnd,
            at: now.toISOString(),
          } as never,
        },
      });
      return changed.count;
    });

    if (applied === 0) {
      return ok({ error: "Nothing was changed: this finding was dispositioned by someone else while you were deciding.", applied: 0 }, 409);
    }
    return ok({ applied, status: nextStatus });
  } catch (err) {
    return handleError(err);
  }
}
