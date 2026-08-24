import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase } from "@/lib/tenant";
import { encounterContentHash } from "@/lib/records/verifiedContent";
import { REVIEW_VISIBLE_STATES, REVIEW_VISIBLE_WHERE, isCurrentOutput } from "@/lib/records/encounterLifecycle";
import { parseCanonicalNoteId } from "@/lib/records/reviewBurden";
import { groupCanonicalEncounters } from "@/lib/records/canonicalEncounters";
import { REVIEWER_ASSIGNABLE_CLASSES, requiresDate } from "@/lib/documents/analysisClass";
import { classifyEncounterSubstance } from "@/lib/records/encounterSubstance";
import { makeRecordStore, refreshCaseRecordsWithRecovery } from "@/lib/records/buildRecords";
import { generatePlan } from "@/lib/engine/generate";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// One structural correction, applied to a whole canonical note, atomically.
//
// A note's date and classification describe the RECORD, so correcting one
// fragment and not the others leaves a note that disagrees with itself. The
// browser used to loop a PATCH per fragment, discard every response, and
// trigger a case rebuild per row — so a correction could land on two of three
// fragments, report success, and rebuild the case three times over an
// inconsistent state.
//
// Here it is one request: membership derived from the canonical note id,
// every row's displayed content hash checked, compare-and-set per row, all of
// it in one transaction with one audit event and one downstream rebuild.
//
// Deliberately NOT here: factual summary, provider, excerpt and claim
// corrections. Those are about one fragment's exact content and stay on the
// per-row endpoint, where their evidence lives.
// ─────────────────────────────────────────────────────────────────────────────

/** The only fields that describe the note rather than one fragment of it. */
const NOTE_WIDE_FIELDS = ["encounterDate", "analysisClass", "substanceClass"] as const;

const bodySchema = z
  .object({
    canonicalNoteId: z.string().min(1),
    reviewNote: z.string().max(2000).optional(),
    rows: z
      .array(z.object({ id: z.string().min(1), expectedContentHash: z.string().length(64) }))
      .min(1)
      .max(500),
    encounterDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    analysisClass: z.enum(REVIEWER_ASSIGNABLE_CLASSES as unknown as [string, ...string[]]).optional(),
    substanceClass: z.enum(["CLINICAL", "ANCILLARY", "ADMINISTRATIVE"]).optional(),
  })
  .refine((b) => NOTE_WIDE_FIELDS.some((f) => b[f] !== undefined), {
    message: "No note-wide field was supplied. Summary and claim corrections belong on the individual entry.",
  });

type Params = { params: Promise<{ caseId: string }> };

class ConcurrentChange extends Error {
  constructor(readonly rowId: string) {
    super("concurrent change");
    this.name = "ConcurrentChange";
  }
}

export async function POST(req: Request, { params: paramsPromise }: Params) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "records.verify", { caseId: params.caseId });
    await requireCase(ctx, params.caseId);
    const input = bodySchema.parse(await req.json());

    const askedIds = input.rows.map((r) => r.id);
    if (new Set(askedIds).size !== askedIds.length) {
      return ok({ error: "No row was changed: the request named the same row more than once.", applied: 0 }, 409);
    }

    // ── Membership, from the note id (see the group review route) ───────────
    const { documentId, rowIds: claimedRowIds } = parseCanonicalNoteId(input.canonicalNoteId);
    if (!documentId || !claimedRowIds.length) {
      return ok({ error: "No row was changed: that is not a canonical note identifier.", applied: 0 }, 422);
    }
    const doc = await prisma.document.findFirst({
      where: { id: documentId, caseId: params.caseId, firmId: ctx.firm.id },
      select: { id: true, segments: true },
    });
    if (!doc) return ok({ error: "No row was changed: that note is not part of this case.", applied: 0 }, 409);

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
      // Orphan row: correctable, but only ever as a note of one.
      const live = await prisma.extractedEncounter.findMany({
        where: { id: claimedRowIds[0], caseId: params.caseId, firmId: ctx.firm.id, sourceDocumentId: documentId, ...REVIEW_VISIBLE_WHERE },
        select: { id: true },
      });
      ids = live.map((r) => r.id);
    } else {
      return ok({ error: "No row was changed: no canonical note in this document matches that identifier.", applied: 0 }, 409);
    }
    if (!ids.length) return ok({ error: "No row was changed: this note has no rows left to correct.", applied: 0 }, 409);

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
    const hashFor = new Map(input.rows.map((r) => [r.id, r.expectedContentHash]));
    const revokesVerification = rows.some((r) => r.status === "VERIFIED");
    for (const row of rows) {
      if (!(REVIEW_VISIBLE_STATES as readonly string[]).includes(row.status ?? "AI_DRAFT")) {
        problems.push({ id: row.id, reason: `historical (${row.status}) and not correctable` });
        continue;
      }
      if (hashFor.get(row.id) !== encounterContentHash(row)) {
        problems.push({ id: row.id, reason: "content changed since it was displayed" });
      }
    }
    // Revoking a verification — even as a side effect of correcting the note
    // it belongs to — requires saying why.
    if (revokesVerification && !input.reviewNote) {
      problems.push({ id: rows.find((r) => r.status === "VERIFIED")!.id, reason: "correcting verified content revokes its verification; a documented reason is required" });
    }
    if (problems.length) {
      return ok({ error: "No row was changed: this note could not be corrected as displayed.", problems, applied: 0 }, 409);
    }

    const now = new Date();
    const actor = ctx.user.id;
    const dateProvided = input.encounterDate !== undefined;
    const touched = NOTE_WIDE_FIELDS.filter((f) => input[f] !== undefined);
    // Judged BEFORE the writes: was the plan built without these rows?
    const restoredToOutput = rows.some((r) => !isCurrentOutput(r));

    const applied = await prisma.$transaction(async (tx) => {
      let count = 0;
      for (const row of rows) {
        const editedFields = new Set<string>(Array.isArray(row.editedFields) ? (row.editedFields as string[]) : []);
        for (const f of touched) editedFields.add(f);
        // Compare-and-set on the version validated above: a concurrent edit
        // anywhere in the note aborts the whole correction.
        const changed = await tx.extractedEncounter.updateMany({
          where: { id: row.id, updatedAt: row.updatedAt },
          data: {
            ...(input.substanceClass !== undefined
              ? { substanceClass: input.substanceClass, substanceReason: "Classified by reviewer." }
              : {}),
            ...(input.analysisClass !== undefined
              ? {
                  analysisClass: input.analysisClass,
                  classificationMethod: "REVIEWER_ASSIGNED",
                  // Reassigning the KIND re-derives substance from it, per row,
                  // unless the reviewer set substance explicitly in the same edit.
                  ...(input.substanceClass === undefined
                    ? (() => {
                        const v = classifyEncounterSubstance({
                          analysisClass: input.analysisClass,
                          encounterType: row.encounterType,
                          factualSummary: row.factualSummary,
                          claims: row.claims as never,
                        });
                        return { substanceClass: v.class, substanceReason: `Reclassified by reviewer as ${input.analysisClass!.replace(/_/g, " ").toLowerCase()}. ${v.reason}` };
                      })()
                    : {}),
                }
              : {}),
            ...(dateProvided
              ? input.encounterDate
                ? { encounterDate: new Date(`${input.encounterDate}T00:00:00Z`), dateStatus: "DOCUMENTED" }
                : { encounterDate: null, dateStatus: "UNKNOWN" }
              : {}),
            ...(input.reviewNote !== undefined ? { reviewNote: input.reviewNote } : {}),
            editedFields: [...editedFields] as never,
            status: "HUMAN_EDITED",
            ...(row.status === "VERIFIED" ? { verifiedContentHash: null } : {}),
            reviewedById: actor,
            reviewedAt: now,
          },
        });
        if (changed.count === 0) throw new ConcurrentChange(row.id);
        count += changed.count;
      }
      // ONE audit event describing the whole note-wide change, committed with
      // the rows it describes.
      await tx.auditLog.create({
        data: {
          firmId: ctx.firm.id,
          userId: actor,
          action: "records.note_correct",
          targetType: "extractedEncounter",
          targetId: rows[0].id,
          caseId: params.caseId,
          meta: {
            canonicalNoteId: input.canonicalNoteId,
            rows: ids,
            fields: touched,
            ...(input.analysisClass !== undefined ? { reclassifiedTo: input.analysisClass, requiresDate: requiresDate(input.analysisClass as never) } : {}),
            ...(revokesVerification ? { revokedVerification: true, reason: input.reviewNote } : {}),
          } as never,
        },
      });
      return count;
    });

    // ONE downstream rebuild for the whole note, not one per fragment. Every
    // note-wide field is a plan input, so the plan follows the records.
    void refreshCaseRecordsWithRecovery(makeRecordStore(prisma as never), params.caseId)
      .then((outcome) => {
        if (outcome.published) void generatePlan(params.caseId, { userId: actor }).catch(() => {});
      })
      .catch((error) => console.error(`[review] note correction refresh failed for case ${params.caseId}: ${String(error).slice(0, 200)}`));

    return ok({
      applied,
      rows: ids,
      fields: touched,
      regenerationTriggered: true,
      regenerationReason: restoredToOutput
        ? "This correction restored the record to the case, so the chronology and care plan are being rebuilt to include it."
        : "A field the care plan depends on changed, so the chronology and care plan are being rebuilt from the corrected record.",
    });
  } catch (err) {
    if (err instanceof ConcurrentChange) {
      return ok(
        {
          error: "No row was changed: one row in this note was modified while the correction was being applied. Reload and correct it again.",
          problems: [{ id: err.rowId, reason: "changed during the write" }],
          applied: 0,
        },
        409,
      );
    }
    return handleError(err);
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
