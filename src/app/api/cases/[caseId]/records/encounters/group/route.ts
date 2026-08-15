import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase, audit } from "@/lib/tenant";
import { encounterContentHash } from "@/lib/records/verifiedContent";
import { REVIEW_VISIBLE_STATES, isCurrentOutput } from "@/lib/records/encounterLifecycle";
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
  rows: z
    .array(
      z.object({
        id: z.string().min(1),
        /** Hash of the content the reviewer was actually looking at. */
        expectedContentHash: z.string().length(64).optional(),
      }),
    )
    .min(1)
    .max(50),
});

type Params = { params: Promise<{ caseId: string }> };

export async function POST(req: Request, { params: paramsPromise }: Params) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "records.verify", { caseId: params.caseId });
    await requireCase(ctx, params.caseId);
    const input = bodySchema.parse(await req.json());

    const ids = [...new Set(input.rows.map((r) => r.id))];
    const rows = await prisma.extractedEncounter.findMany({
      where: { id: { in: ids }, caseId: params.caseId, firmId: ctx.firm.id },
    });

    // ── Validate every row BEFORE writing any of them ──────────────────────
    const problems: { id: string; reason: string }[] = [];
    const found = new Map(rows.map((r) => [r.id, r]));
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
      return count;
    });

    await audit(ctx, `records.encounter_group_${input.action}`, {
      type: "extractedEncounter",
      id: rows[0].id,
      caseId: params.caseId,
      meta: { rows: ids, action: input.action },
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
