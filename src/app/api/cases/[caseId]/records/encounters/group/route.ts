import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase, audit } from "@/lib/tenant";
import { encounterContentHash } from "@/lib/records/verifiedContent";
import { REVIEW_VISIBLE_STATES, REVIEW_VISIBLE_WHERE, isCurrentOutput } from "@/lib/records/encounterLifecycle";
import { parseCanonicalNoteId } from "@/lib/records/reviewBurden";
import { groupCanonicalEncounters } from "@/lib/records/canonicalEncounters";
import { attestationBlockers } from "@/lib/records/reviewIntegrity";
import { makeRecordStore, refreshCaseRecordsWithRecovery } from "@/lib/records/buildRecords";
import { PipelineBusyError, PipelineLeaseLostError } from "@/lib/engine/pipelineLock";
import { runCasePipeline } from "@/lib/engine/runPipeline";
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
   * The canonical note being decided. REQUIRED: membership is resolved from
   * this id against the persisted segments, so a client cannot define which
   * rows its own signature covers. Optional, it was never read at all — the
   * server fell back to whatever rows the request happened to name.
   */
  canonicalNoteId: z.string().min(1),
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

    const askedIds = input.rows.map((r) => r.id);
    if (new Set(askedIds).size !== askedIds.length) {
      return ok({ error: "No row was changed: the request named the same row more than once.", problems: [], applied: 0 }, 409);
    }

    // ── Server-derived membership ──────────────────────────────────────────
    // The note's members are resolved from the CANONICAL NOTE ID against the
    // persisted segments. The previous version anchored on `asked[0]` — the
    // first row of an unordered findMany — and, when that row belonged to no
    // segment, kept the client's own list. Two unrelated same-case rows could
    // then be signed as one record.
    const { documentId, rowIds: claimedRowIds } = parseCanonicalNoteId(input.canonicalNoteId);
    if (!documentId || !claimedRowIds.length) {
      return ok({ error: "No row was changed: that is not a canonical note identifier.", problems: [], applied: 0 }, 422);
    }
    // Tenant- and case-scoped by construction.
    const doc = await prisma.document.findFirst({
      where: { id: documentId, caseId: params.caseId, firmId: ctx.firm.id },
      select: { id: true, segments: true },
    });
    if (!doc) {
      return ok({ error: "No row was changed: that note is not part of this case.", problems: [], applied: 0 }, 409);
    }

    const segments = Array.isArray(doc.segments) ? (doc.segments as { rowIds?: unknown }[]) : [];
    // ── EXACT set, not a subset ─────────────────────────────────────────────
    // Matching a note id that is merely CONTAINED in a segment let a shortened
    // identifier resolve to a larger group: a request naming two rows of a
    // five-row note would be answered with all five, and the audit event would
    // then record a decision under an identifier that never described it. The
    // id has to BE the note.
    const owning = segments
      .map((seg) => (Array.isArray(seg?.rowIds) ? (seg.rowIds as unknown[]).filter((x): x is string => typeof x === "string") : []))
      .find((rowIds) => sameRowSet(rowIds, claimedRowIds));

    // Rows of THIS document only, under this case and firm. Loaded before the
    // branch below so the compatibility grouping has something to run over;
    // when a persisted segment owns the note, none of this is consulted.
    const derivedGroups = owning?.length
      ? null
      : await (async () => {
          const docRows = await prisma.extractedEncounter.findMany({
            where: { caseId: params.caseId, firmId: ctx.firm.id, sourceDocumentId: documentId, ...REVIEW_VISIBLE_WHERE },
            select: {
              id: true, sourceDocumentId: true, encounterDate: true, dateStatus: true, analysisClass: true,
              provider: true, facility: true, page: true, pageEnd: true, substanceClass: true, segmentKey: true, claims: true,
            },
          });
          const groups = groupCanonicalEncounters({
            documents: [{ id: documentId, segments: doc.segments }],
            rows: docRows.map((r) => ({
              id: r.id,
              sourceDocumentId: r.sourceDocumentId,
              encounterDate: r.encounterDate,
              dateStatus: r.dateStatus,
              analysisClass: r.analysisClass,
              provider: r.provider,
              facility: r.facility,
              page: r.page,
              pageEnd: r.pageEnd,
              substanceClass: r.substanceClass,
              segmentKey: r.segmentKey,
              claims: Array.isArray(r.claims) ? (r.claims as { field: string; value: string; excerpt?: string | null; page?: number | null }[]) : [],
            })),
          });
          return {
            // Same exact-set rule as the persisted path above.
            exact: groups.find((g) => sameRowSet(g.rowIds, claimedRowIds))?.rowIds ?? null,
            // …and the group the identifier merely sits INSIDE, so a partial
            // identifier is refused outright rather than quietly falling
            // through to the note-of-one path below and being answered there.
            containing: groups.find((g) => claimedRowIds.every((id) => g.rowIds.includes(id)))?.rowIds ?? null,
          };
        })();
    const fallbackOwning = derivedGroups?.exact ?? null;

    let ids: string[];
    if (owning?.length) {
      // A real canonical note: its live members, exactly.
      const live = await prisma.extractedEncounter.findMany({
        where: { id: { in: owning }, caseId: params.caseId, firmId: ctx.firm.id, ...REVIEW_VISIBLE_WHERE },
        select: { id: true },
      });
      ids = live.map((r) => r.id);
    } else if (fallbackOwning?.length) {
      // ── The compatibility path, derived HERE ────────────────────────────
      // A document whose segments still carry the ingest-time shape has no
      // stored row membership, so the review surface resolves its encounters
      // with the shared canonical grouping. The server must resolve them the
      // same way or the card would offer a decision this endpoint refuses.
      //
      // It is derived, never accepted: the grouping runs over rows loaded
      // under this case, this firm and THIS document, so a compatibility path
      // can no more widen scope than the persisted one can. The client still
      // does not get to say which rows its signature covers.
      const live = await prisma.extractedEncounter.findMany({
        where: { id: { in: fallbackOwning }, caseId: params.caseId, firmId: ctx.firm.id, sourceDocumentId: documentId, ...REVIEW_VISIBLE_WHERE },
        select: { id: true },
      });
      ids = live.map((r) => r.id);
    } else if (derivedGroups?.containing?.length) {
      // The identifier names PART of a record. Answering it with the whole
      // record would sign more than the id described; answering it with the
      // named rows alone would sign half a note. Neither is a decision, so
      // this is refused.
      return ok(
        {
          error: "No row was changed: that identifier names part of a canonical note, not a note.",
          problems: claimedRowIds.map((id) => ({ id, reason: "this note includes rows the identifier did not name" })),
          applied: 0,
        },
        409,
      );
    } else if (claimedRowIds.length === 1) {
      // A legacy or orphan row no segment claims. It is reviewable — but only
      // ever as a note of ONE. An orphan fallback that accepted a second row
      // is exactly the hole the anchor bug left open.
      const live = await prisma.extractedEncounter.findMany({
        where: { id: claimedRowIds[0], caseId: params.caseId, firmId: ctx.firm.id, sourceDocumentId: documentId, ...REVIEW_VISIBLE_WHERE },
        select: { id: true },
      });
      ids = live.map((r) => r.id);
    } else {
      return ok(
        {
          error: "No row was changed: no canonical note in this document matches that identifier.",
          problems: claimedRowIds.map((id) => ({ id, reason: "not a member of any persisted note" })),
          applied: 0,
        },
        409,
      );
    }

    if (!ids.length) {
      return ok({ error: "No row was changed: this note has no rows left to review.", problems: [], applied: 0 }, 409);
    }

    // ── Exact set match ────────────────────────────────────────────────────
    // Not "no extras" and not "no gaps" — both. A decision covers exactly the
    // record the reviewer was shown, or it does not happen.
    const derived = new Set(ids);
    const extras = askedIds.filter((id) => !derived.has(id));
    const missing = ids.filter((id) => !askedIds.includes(id));
    if (extras.length || missing.length) {
      return ok(
        {
          error: "No row was changed: the rows submitted are not exactly the rows of this canonical note.",
          problems: [
            ...extras.map((id) => ({ id, reason: "not a member of this note" })),
            ...missing.map((id) => ({ id, reason: "this note includes a row the request did not display" })),
          ],
          applied: 0,
        },
        409,
      );
    }

    const rows = await prisma.extractedEncounter.findMany({ where: { id: { in: ids }, caseId: params.caseId, firmId: ctx.firm.id } });

    // ── Validate every row BEFORE writing any of them ──────────────────────
    const problems: { id: string; reason: string }[] = [];
    const found = new Map(rows.map((r) => [r.id, r]));
    // Every derived member arrives with the hash it was displayed as — the
    // exact-set match above already guarantees one per member.
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
    // ── Integrity, enforced HERE ───────────────────────────────────────────
    // A clean attestation may not be given over an unresolved exception: a
    // contradicted date is not "verified" because the card looked tidy. The
    // row's own state is checked directly rather than trusted to a disabled
    // button — a UI control is a courtesy, not a safeguard, and the finding
    // table was the only thing being consulted while it was empty in
    // production. A REJECT is still allowed: disposing of the row IS how an
    // unsupported entry is resolved.
    if (input.action !== "reject") {
      for (const row of rows) {
        // The same rules the batch confirmation and the final gate apply, from
        // one definition — three near-copies of "may this be attested?" is how
        // a corrected record came to be refused here and blocked there for
        // opposite reasons. `attestationBlockers` carries the reasoning: the
        // machine's grade governs only while the machine's draft is what the
        // row still holds, and a live dispute or contradiction is answered by
        // nobody's status.
        for (const problem of attestationBlockers(row as never)) {
          problems.push({ id: row.id, reason: problem.reason });
        }
      }
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
      // Rejecting an entry moots the findings ABOUT that entry — there is no
      // longer an entry for them to be about. It moots nothing else: the
      // document is still incomplete, the page is still unreadable, and the
      // case-level blocker is not answered by deleting a row near it.
      if (input.action === "reject") {
        await tx.recordFinding.updateMany({
          where: {
            caseId: params.caseId,
            firmId: ctx.firm.id,
            encounterId: { in: ids },
            scope: { in: ["ENTRY", "CLAIM", "NOTE"] },
            status: { in: ["OPEN", "CONFIRMED"] },
          },
          data: {
            status: "RESOLVED",
            dispositionReason: "the entry this finding was about was rejected on human review",
            reviewedById: actor,
            reviewedAt: now,
          },
        });
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
        // One at a time per case: this fires on every published group, so a
        // reviewer working the queue used to launch overlapping regenerations
        // that each wrote a whole plan. Contention now means the run in flight
        // owes one more pass, so nothing is lost by not running here.
        if (invalidatesPlan && outcome.published) {
          void runCasePipeline(params.caseId, ctx.firm.id, { userId: actor }).catch((e) => {
            if (e instanceof PipelineBusyError || e instanceof PipelineLeaseLostError) return;
            console.error(`[review] plan regeneration failed for case ${params.caseId}: ${String(e).slice(0, 200)}`);
          });
        }
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

/**
 * Do these name exactly the same rows?
 *
 * Set equality, order- and duplicate-insensitive: a canonical note id is the
 * SET of rows it consolidates, so an identifier that names some of them names
 * a different note — not a shorter spelling of this one.
 */
function sameRowSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}
