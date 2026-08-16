import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase, audit } from "@/lib/tenant";
import { encounterContentHash } from "@/lib/records/verifiedContent";
import { REVIEW_VISIBLE_STATES, REVIEW_VISIBLE_WHERE, isCurrentOutput } from "@/lib/records/encounterLifecycle";
import { makeRecordStore, refreshCaseRecordsWithRecovery } from "@/lib/records/buildRecords";
import { generatePlan } from "@/lib/engine/generate";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// One review decision covering several rows — as ONE decision.
//
// The first version of cross-document review fanned out from the browser: it
// verified the primary, then fired a request per copy, ignored their failures,
// and sent no content hash. So the card could promise "one review covers every
// copy" while some copies stayed unreviewed, or while a copy whose content had
// changed since it was displayed got a signature anyway.
//
// Here the whole group is one request. Every row is loaded, every row is
// checked — reviewable, in this case, and still carrying the exact content the
// reviewer was shown — and only then does anything change, inside a single
// transaction. If one row fails a check, nothing is written and the response
// says which row and why.
// ─────────────────────────────────────────────────────────────────────────────

const bodySchema = z.object({
  action: z.enum(["verify", "review", "reject"]),
  note: z.string().max(2000).optional(),
  /**
   * The canonical note being decided. Membership is derived SERVER-side from
   * the persisted segments — a client may not define which rows a decision
   * covers, or it could smuggle unrelated rows into one signature.
   */
  canonicalNoteId: z.string().min(1).optional(),
  rows: z
    .array(
      z.object({
        id: z.string().min(1),
        /**
         * Hash of the content the reviewer was actually looking at. REQUIRED:
         * an optional hash means a client can sign content it never showed.
         */
        expectedContentHash: z.string().length(64),
      }),
    )
    .min(1)
    // A canonical note can exceed a small cap; the bound exists to stop an
    // unbounded request, not to truncate a legitimate note.
    .max(500),
});

type Params = { params: Promise<{ caseId: string }> };

export async function POST(req: Request, { params: paramsPromise }: Params) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "records.verify", { caseId: params.caseId });
    await requireCase(ctx, params.caseId);
    const input = bodySchema.parse(await req.json());

    const askedIds = [...new Set(input.rows.map((r) => r.id))];
    // Tenant- and case-scoped by construction: rows outside this firm's case
    // simply do not come back, so they can never join the decision.
    const asked = await prisma.extractedEncounter.findMany({
      where: { id: { in: askedIds }, caseId: params.caseId, firmId: ctx.firm.id },
    });

    // ── Server-derived membership ──────────────────────────────────────────
    // The note's members come from the persisted canonical segments, never
    // from the request. A client that names extra rows is refused rather than
    // obeyed: one signature must cover exactly one record.
    const anchor = asked[0];
    let ids = askedIds;
    if (anchor) {
      const doc = await prisma.document.findFirst({
        where: { id: anchor.sourceDocumentId, caseId: params.caseId, firmId: ctx.firm.id },
        select: { id: true, segments: true },
      });
      const segments = Array.isArray(doc?.segments) ? (doc!.segments as { rowIds?: unknown }[]) : [];
      const owning = segments
        .map((seg) => (Array.isArray(seg?.rowIds) ? (seg.rowIds as unknown[]).filter((x): x is string => typeof x === "string") : []))
        .find((rowIds) => rowIds.includes(anchor.id));
      if (owning?.length) {
        const live = await prisma.extractedEncounter.findMany({
          where: { id: { in: owning }, caseId: params.caseId, firmId: ctx.firm.id, ...REVIEW_VISIBLE_WHERE },
          select: { id: true },
        });
        const derived = new Set(live.map((r) => r.id));
        const smuggled = askedIds.filter((id) => !derived.has(id));
        if (smuggled.length) {
          return ok(
            {
              error: "No row was changed: the request named rows that are not part of this canonical note.",
              problems: smuggled.map((id) => ({ id, reason: "not a member of this note" })),
              applied: 0,
            },
            409,
          );
        }
        ids = [...derived];
      }
    }

    const rows = ids.length === askedIds.length && ids.every((id) => askedIds.includes(id))
      ? asked
      : await prisma.extractedEncounter.findMany({ where: { id: { in: ids }, caseId: params.caseId, firmId: ctx.firm.id } });

    // ── Validate every row BEFORE writing any of them ──────────────────────
    const problems: { id: string; reason: string }[] = [];
    const found = new Map(rows.map((r) => [r.id, r]));
    // Every derived member must arrive with the hash it was displayed as: a
    // member the client did not show cannot be signed.
    const hashFor = new Map(input.rows.map((r) => [r.id, r.expectedContentHash]));
    for (const row of rows) {
      if (!hashFor.has(row.id)) {
        problems.push({ id: row.id, reason: "this note includes a row the request did not display" });
      }
    }
    for (const asked of input.rows) {
      const row = found.get(asked.id);
      if (!row) {
        problems.push({ id: asked.id, reason: "not found in this case" });
        continue;
      }
      if (!(REVIEW_VISIBLE_STATES as readonly string[]).includes(row.status ?? "AI_DRAFT")) {
        problems.push({ id: asked.id, reason: `historical (${row.status}) and not reviewable` });
        continue;
      }
      // A signature covers the bytes the reviewer saw, for every row in the
      // group — not just the one whose card carried the button.
      if (asked.expectedContentHash && asked.expectedContentHash !== encounterContentHash(row)) {
        problems.push({ id: asked.id, reason: "content changed since it was displayed" });
      }
    }
    // A clean attestation may not be given over an unresolved exception: a
    // contradicted date is not "verified" because the card looked tidy. A
    // REJECT is still allowed — disposing of the row IS how you resolve it.
    if (input.action !== "reject") {
      const blocking = await prisma.recordFinding.findMany({
        where: {
          caseId: params.caseId,
          firmId: ctx.firm.id,
          encounterId: { in: rows.map((r) => r.id) },
          blocking: true,
          status: { in: ["OPEN", "CONFIRMED"] },
        },
        select: { encounterId: true, type: true },
      });
      for (const f of blocking) {
        problems.push({ id: f.encounterId ?? "", reason: `unresolved finding must be dispositioned first (${f.type})` });
      }
    }

    if (problems.length) {
      return ok(
        {
          error: "No row was changed: one or more rows in this group could not be reviewed as displayed.",
          problems,
          applied: 0,
        },
        409,
      );
    }

    const verify = input.action === "verify";
    const now = new Date();
    const actor = ctx.user.id;

    // Membership in the plan's input set, judged BEFORE the writes below.
    const wasPlanInput = rows.some((r) => isCurrentOutput(r));

    // ── All-or-none ────────────────────────────────────────────────────────
    const written = await prisma.$transaction(async (tx) => {
      let count = 0;
      for (const row of rows) {
        // Compare-and-set per row on the version we validated, so a concurrent
        // edit anywhere in the group aborts the whole decision.
        const applied = await tx.extractedEncounter.updateMany({
          where: { id: row.id, updatedAt: row.updatedAt },
          data:
            input.action === "reject"
              ? {
                  status: "SUPERSEDED",
                  staleReason: `Rejected on human review${input.note ? `: ${input.note}` : ""}`,
                  reviewedById: actor,
                  reviewedAt: now,
                }
              : {
                  status: verify ? "VERIFIED" : "REVIEWED",
                  reviewedById: actor,
                  reviewedAt: now,
                  // Each row's hash is computed from ITS OWN persisted content.
                  ...(verify ? { verifiedById: actor, verifiedAt: now, verifiedContentHash: encounterContentHash(row) } : {}),
                  ...(input.note ? { reviewNote: input.note } : {}),
                },
        });
        if (applied.count === 0) {
          throw new ConcurrentChange(row.id);
        }
        count += applied.count;
      }
      // The audit event commits WITH the rows. Written afterwards, a crash
      // between the two would leave changed records with no record of who
      // changed them.
      await tx.auditLog.create({
        data: {
          firmId: ctx.firm.id,
          userId: actor,
          action: `records.encounter_group_${input.action}`,
          targetType: "extractedEncounter",
          targetId: rows[0].id,
          caseId: params.caseId,
          meta: { rows: ids, action: input.action } as never,
        },
      });
      return count;
    });

    // Same dependency rule as a single-row decision.
    const restored = rows.some((r) => !isCurrentOutput(r));
    const invalidatesPlan = input.action === "reject" ? wasPlanInput : restored;
    void refreshCaseRecordsWithRecovery(makeRecordStore(prisma as never), params.caseId)
      .then((outcome) => {
        if (invalidatesPlan && outcome.published) void generatePlan(params.caseId, { userId: actor }).catch(() => {});
      })
      .catch((error) => console.error(`[review] group refresh failed for case ${params.caseId}: ${String(error).slice(0, 200)}`));

    return ok({ applied: written, rows: ids });
  } catch (err) {
    if (err instanceof ConcurrentChange) {
      return ok(
        {
          error: "No row was changed: one row in this group was modified while the decision was being applied. Reload and review again.",
          problems: [{ id: err.rowId, reason: "changed during the write" }],
          applied: 0,
        },
        409,
      );
    }
    return handleError(err);
  }
}

class ConcurrentChange extends Error {
  constructor(readonly rowId: string) {
    super("concurrent change");
    this.name = "ConcurrentChange";
  }
}
