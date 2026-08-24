import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase, audit } from "@/lib/tenant";
import { getStructuredRecord } from "@/lib/records/structuredRecord";
import { CHRONOLOGY_REVIEW_WHERE, REVIEW_VISIBLE_WHERE } from "@/lib/records/encounterLifecycle";
import { encounterContentHash } from "@/lib/records/verifiedContent";
import { attestationBlockers } from "@/lib/records/reviewIntegrity";
import { manifestHashOf, planBatchConfirmation, CONFIRMABLE_ROW_STATES, type ConfirmableEvent } from "@/lib/records/batchConfirmation";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// "Confirm all clean records and chronology" — the one human act.
//
// Grouping alone did not reduce the work. It reduced the review UNITS, and the
// metric duly reported fewer required decisions — while the final-export gate
// still refused to release a report until every machine draft had been signed
// one card at a time. The number moved and the job did not, which is the worst
// kind of progress.
//
// GET  returns the plan: how many clean encounters, how many of those carry a
//      caution and what kind, how many exceptions will remain and why, how
//      many chronology drafts are covered and how many are held back — plus a
//      manifest hash of exactly that content.
//
// POST applies it, once, on an explicit click, all-or-none.
//
// The invariants, in the order they matter:
//
//   • MEMBERSHIP AND ELIGIBILITY ARE SERVER-DERIVED. The browser sends an
//     action and a manifest hash. It never sends a row id, an event id, a
//     count or an eligibility claim, so there is nothing for a client to
//     widen. The hash can only make the server do LESS.
//
//   • IT WRITES REVIEW STATE, AND NOTHING ELSE. Status, reviewer and time on
//     eligible rows; review status, reviewer and time on eligible chronology
//     drafts. No claim, excerpt, page, citation, summary, date, provider,
//     facility, classification, canonical membership or chronology sentence is
//     read-modify-written anywhere below. The record says exactly what it said
//     before; a person has now confirmed it.
//
//   • REVIEWED, NEVER VERIFIED. This is factual records review under
//     `records.verify`. It is not a professional attestation, it does not set
//     `verifiedContentHash`, and it never stands in for a physician opinion.
//
//   • AN EXCEPTION IS NOT COVERED BY IT. Anything that cannot be attested as
//     it stands is skipped, counted, explained, and left in exactly the
//     individual correct/review/reject path it was already in.
//
//   • DRIFT ABORTS THE WHOLE THING. The manifest is recomputed here, every row
//     is re-hashed here, and each write is a compare-and-set on the version
//     that was checked. One moved row rolls back all of it.
// ─────────────────────────────────────────────────────────────────────────────

const bodySchema = z.object({
  /**
   * The manifest the reviewer was shown, from GET. REQUIRED.
   *
   * Deliberately the ONLY thing the client contributes. It cannot name rows,
   * add rows or assert that anything is clean; it can only fail to match, in
   * which case nothing happens at all.
   */
  expectedManifestHash: z.string().length(64),
  note: z.string().max(2000).optional(),
});

type Params = { params: Promise<{ caseId: string }> };

class ConcurrentChange extends Error {
  constructor(readonly what: string) {
    super("concurrent change");
    this.name = "ConcurrentChange";
  }
}

/** The plan, derived from persisted state alone. Shared by GET and POST. */
async function derivePlan(caseId: string, firmId: string) {
  const [record, events] = await Promise.all([
    // The SAME canonical notes the Records page renders: one grouping
    // mechanism, one guidance derivation, one CLEAN/CAUTION/EXCEPTION verdict.
    getStructuredRecord(caseId, firmId, { scope: "review" }),
    prisma.chronologyEvent.findMany({
      where: { caseId, ...CHRONOLOGY_REVIEW_WHERE },
      select: { id: true, reviewStatus: true, edited: true, sourceDocumentId: true, eventDate: true, sourceFingerprint: true },
    }),
  ]);
  const notes = record.documents.flatMap((d) => d.notes);
  const plan = planBatchConfirmation({ notes, events: events as ConfirmableEvent[] });
  return { plan, record, events };
}

export async function GET(_req: Request, { params: paramsPromise }: Params) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    // The same capability the individual decision needs. A platform or system
    // administrator does not hold it — factual record review is a firm-role
    // capability, and a batch of it is not a lesser act than one of it.
    requireCanonicalPermission(ctx, "records.verify", { caseId: params.caseId });
    await requireCase(ctx, params.caseId);

    const { plan } = await derivePlan(params.caseId, ctx.firm.id);
    return ok({
      manifestHash: plan.manifestHash,
      counts: plan.counts,
      skippedByReason: plan.skippedByReason,
      cautionsByKind: plan.cautionsByKind,
      basisCounts: plan.basisCounts,
    });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, { params: paramsPromise }: Params) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "records.verify", { caseId: params.caseId });
    await requireCase(ctx, params.caseId);
    const input = bodySchema.parse(await req.json());

    const { plan } = await derivePlan(params.caseId, ctx.firm.id);

    // ── The reviewer confirmed THIS ────────────────────────────────────────
    // Recomputed from persisted state, then compared. A record corrected, a
    // document re-extracted, a grouping changed or an event edited between the
    // dialog opening and the click all move this hash.
    if (plan.manifestHash !== input.expectedManifestHash) {
      return ok(
        {
          error:
            "Nothing was confirmed: the case changed after these counts were shown. Reload the records and review the new figures before confirming.",
          applied: 0,
          manifestHash: plan.manifestHash,
        },
        409,
      );
    }

    if (!plan.rowIds.length && !plan.eventIds.length) {
      return ok(
        {
          error: "Nothing was confirmed: no clean record or chronology draft is currently eligible.",
          applied: 0,
          counts: plan.counts,
          skippedByReason: plan.skippedByReason,
        },
        409,
      );
    }

    // ── Re-read the rows and check them AGAIN, here ────────────────────────
    // The plan was derived from the structured record. This loads the rows
    // themselves, tenant- and case-scoped, and re-applies the same integrity
    // rules the individual endpoint enforces. A screen state is a courtesy; a
    // safeguard is something the server does for itself.
    const rows = await prisma.extractedEncounter.findMany({
      where: { id: { in: plan.rowIds }, caseId: params.caseId, firmId: ctx.firm.id, ...REVIEW_VISIBLE_WHERE },
    });
    const problems: { id: string; reason: string }[] = [];
    if (rows.length !== plan.rowIds.length) {
      problems.push({ id: "", reason: "a record in this batch is no longer reviewable" });
    }
    for (const row of rows) {
      if (!CONFIRMABLE_ROW_STATES.includes(row.status)) {
        problems.push({ id: row.id, reason: `already decided (${row.status})` });
        continue;
      }
      for (const problem of attestationBlockers(row as never)) problems.push({ id: row.id, reason: problem.reason });
    }
    // The bytes, again. The manifest above proves the SET did not change; this
    // proves each row still holds the content that set was built from.
    const manifestRows = rows.map((r) => ({ id: r.id, contentHash: encounterContentHash(r), status: r.status }));
    const events = await prisma.chronologyEvent.findMany({
      where: { id: { in: plan.eventIds }, caseId: params.caseId },
      select: { id: true, reviewStatus: true, edited: true, sourceDocumentId: true, eventDate: true, sourceFingerprint: true },
    });
    if (manifestHashOf(manifestRows, events as ConfirmableEvent[]) !== input.expectedManifestHash) {
      problems.push({ id: "", reason: "the displayed content changed before the confirmation was applied" });
    }
    if (problems.length) {
      return ok(
        {
          error: "Nothing was confirmed: one or more records in this batch could not be confirmed as displayed.",
          problems,
          applied: 0,
        },
        409,
      );
    }

    const now = new Date();
    const actor = ctx.user.id;

    // ── All-or-none ────────────────────────────────────────────────────────
    const result = await prisma.$transaction(async (tx) => {
      let confirmedRows = 0;
      for (const row of rows) {
        // Compare-and-set on the exact version validated above, AND on the
        // status still being a machine draft. Either moving aborts everything.
        const applied = await tx.extractedEncounter.updateMany({
          where: {
            id: row.id,
            updatedAt: row.updatedAt,
            status: { in: CONFIRMABLE_ROW_STATES as string[] },
            caseId: params.caseId,
            firmId: ctx.firm.id,
          },
          // Review state and review metadata. Nothing else — no content field
          // appears here, and none is read-modify-written anywhere above.
          data: {
            status: "REVIEWED",
            reviewedById: actor,
            reviewedAt: now,
            ...(input.note ? { reviewNote: input.note } : {}),
          },
        });
        if (applied.count === 0) throw new ConcurrentChange(`record ${row.id}`);
        confirmedRows += applied.count;
      }

      let confirmedEvents = 0;
      for (const event of events) {
        const applied = await tx.chronologyEvent.updateMany({
          // The predicate IS the compare-and-set: a draft that has since been
          // edited, reviewed or superseded no longer matches.
          where: { id: event.id, caseId: params.caseId, reviewStatus: "AI_DRAFT", edited: false },
          data: { reviewStatus: "REVIEWED", reviewedById: actor, reviewedAt: now },
        });
        if (applied.count === 0) throw new ConcurrentChange(`chronology event ${event.id}`);
        confirmedEvents += applied.count;
      }

      // ── The record of what was confirmed ──────────────────────────────────
      // Committed WITH the writes. A batch decision whose manifest landed
      // separately would be a signature over content nobody can reconstruct.
      await audit(
        ctx,
        "records.batch_confirm",
        {
          type: "case",
          id: params.caseId,
          caseId: params.caseId,
          meta: {
            firmId: ctx.firm.id,
            decision: "REVIEWED",
            attestation: false,
            counts: plan.counts,
            // Exactly what was covered, and exactly the content it held.
            manifestHash: plan.manifestHash,
            rows: manifestRows.map((r) => ({ id: r.id, contentHash: r.contentHash })),
            events: plan.eventIds,
            encounters: plan.encounters
              .filter((e) => e.eligible)
              .map((e) => ({ noteId: e.noteId, level: e.level, guidanceKind: e.guidanceKind, rowIds: e.rowIds })),
            // What the reviewer was told they were also covering.
            cautionsByKind: plan.cautionsByKind,
            // How each covered record's membership was established.
            groupingBasis: plan.basisCounts,
            // What this act did NOT cover, and why.
            skippedEncounters: plan.counts.skippedEncounters,
            skippedByReason: plan.skippedByReason,
            heldChronologyEvents: plan.counts.heldEvents,
            note: input.note ?? null,
          },
        },
        tx as never,
      );

      return { confirmedRows, confirmedEvents };
    });

    return ok({
      applied: result.confirmedRows + result.confirmedEvents,
      rows: result.confirmedRows,
      events: result.confirmedEvents,
      counts: plan.counts,
      skippedByReason: plan.skippedByReason,
      cautionsByKind: plan.cautionsByKind,
    });
  } catch (err) {
    if (err instanceof ConcurrentChange) {
      return ok(
        {
          error: `Nothing was confirmed: ${err.what} changed while the confirmation was being applied. Reload and review the new figures.`,
          applied: 0,
        },
        409,
      );
    }
    return handleError(err);
  }
}
