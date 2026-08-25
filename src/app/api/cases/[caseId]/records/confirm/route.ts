import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase, audit } from "@/lib/tenant";
import { getStructuredRecord, type StructuredRecordClient } from "@/lib/records/structuredRecord";
import { CHRONOLOGY_REVIEW_WHERE, REVIEW_VISIBLE_WHERE } from "@/lib/records/encounterLifecycle";
import { encounterContentHash } from "@/lib/records/verifiedContent";
import { attestationBlockers } from "@/lib/records/reviewIntegrity";
import { caseLockKey } from "@/lib/records/buildRecords";
import { planBatchConfirmation, CONFIRMABLE_ROW_STATES, type ConfirmableEvent } from "@/lib/records/batchConfirmation";
import { CHRONOLOGY_CONTENT_SELECT, chronologyEventContentHash } from "@/lib/records/chronologyContent";
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
//   • DRIFT ABORTS THE WHOLE THING — INSIDE THE TRANSACTION. Checking a
//     manifest before opening a transaction leaves a window, and for chronology
//     events the window was reachable: `ChronologyEvent` has no `updatedAt`, so
//     the write's compare-and-set could only test review state, and the
//     retention job rewrites `sourceQuote` without touching it. A row whose
//     quote had just been purged would have been signed as the one displayed.
//
//     So the whole plan — grouping, findings, eligibility, counts, row content
//     and event content — is re-derived INSIDE the transaction, under the
//     case's own advisory lock and explicit row locks on everything about to
//     be written, and compared there. Nothing is checked in one place and
//     written in another.
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

/** The case moved between the dialog and the write. Rolls the transaction back. */
class StaleConfirmation extends Error {
  constructor(readonly what: string) {
    super("stale confirmation");
    this.name = "StaleConfirmation";
  }
}

/**
 * Postgres gave up rather than allow two transactions to interleave unsafely.
 *
 * Indistinguishable, from the reviewer's side, from any other "the case moved"
 * — and answered the same way: nothing was written, reload and look again.
 */
const isSerializationFailure = (err: unknown): boolean =>
  typeof (err as { code?: string })?.code === "string" && ["40001", "40P01"].includes((err as { code: string }).code);

/** Every client surface this endpoint reads through — the shared one, or a tx. */
type ConfirmClient = StructuredRecordClient & {
  chronologyEvent: { findMany(args: unknown): Promise<unknown[]> };
};

/**
 * The plan, derived from persisted state alone.
 *
 * `db` is the shared client for the preview and a TRANSACTION client for the
 * write, so the eligibility that is written is the eligibility that held under
 * the locks — not one read a moment earlier from outside them.
 */
async function derivePlan(caseId: string, firmId: string, db: ConfirmClient = prisma) {
  const [record, events] = await Promise.all([
    // The SAME canonical notes the Records page renders: one grouping
    // mechanism, one guidance derivation, one CLEAN/CAUTION/EXCEPTION verdict.
    getStructuredRecord(caseId, firmId, { scope: "review", client: db }),
    db.chronologyEvent.findMany({
      where: { caseId, ...CHRONOLOGY_REVIEW_WHERE },
      // Every field the manifest hashes. An event has no `updatedAt` to
      // compare-and-set against, so its CONTENT is the version being
      // confirmed — and a narrower selection here than in the re-check below
      // would differ for a reason that is not a change.
      select: CHRONOLOGY_CONTENT_SELECT,
    }) as Promise<ConfirmableEvent[]>,
  ]);
  const notes = record.documents.flatMap((d) => d.notes);
  // Filenames for the itemized manifest's citations, from the same structured
  // record the notes came from — never a second read that could disagree.
  const filenames = new Map(record.documents.map((d) => [d.documentId, d.filename]));
  const plan = planBatchConfirmation({ notes, events, filenames });
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
      // ── The itemized manifest ────────────────────────────────────────────
      // Exactly the records and chronology entries this confirmation will mark
      // human-reviewed, each with the sentence being confirmed and the citation
      // to find it. The counts below summarise this list; they used to stand in
      // for it, and an aggregate cannot establish that a person saw anything.
      manifestRecords: plan.manifestRecords,
      manifestEvents: plan.manifestEvents,
      counts: plan.counts,
      skippedByReason: plan.skippedByReason,
      // Separate from the exceptions above: a caution is work, but it is not a
      // record that cannot be attested as it stands.
      cautionsByReason: plan.cautionsByReason,
      heldByReason: plan.heldByReason,
      heldEventsByReason: plan.heldEventsByReason,
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

    // ── An early, cheap "no" ───────────────────────────────────────────────
    // Everything here is a COURTESY: it answers a plainly stale request with a
    // useful, per-record explanation before opening a serializable transaction
    // over a whole case. None of it is the safeguard. A check that commits in
    // a different transaction from the write it guards is not a check, and
    // this one deliberately does not pretend otherwise — the binding version
    // of all of it runs inside the transaction below, under the case lock and
    // row locks, and would refuse anything this misses.
    const preview = await prisma.extractedEncounter.findMany({
      where: { id: { in: plan.rowIds }, caseId: params.caseId, firmId: ctx.firm.id, ...REVIEW_VISIBLE_WHERE },
    });
    const problems: { id: string; reason: string }[] = [];
    if (preview.length !== plan.rowIds.length) {
      problems.push({ id: "", reason: "a record in this batch is no longer reviewable" });
    }
    for (const row of preview) {
      if (!CONFIRMABLE_ROW_STATES.includes(row.status)) {
        problems.push({ id: row.id, reason: `already decided (${row.status})` });
        continue;
      }
      for (const problem of attestationBlockers(row as never)) problems.push({ id: row.id, reason: problem.reason });
    }
    // The plan was just re-derived from persisted state by `derivePlan` above,
    // and its `manifestHash` is computed over the literal manifest lines it
    // will render. Recomputing it here from a differently-shaped projection is
    // what let the hash and the screen drift apart; the plan's own hash IS the
    // identity of what would be displayed.
    if (plan.manifestHash !== input.expectedManifestHash) {
      problems.push({ id: "", reason: "the displayed content changed before the confirmation was applied" });
    }
    if (problems.length) {
      return ok(
        {
          error: "Nothing was confirmed: one or more records in this batch could not be confirmed as displayed.",
          problems,
          applied: 0,
          stale: true,
        },
        409,
      );
    }

    const now = new Date();
    const actor = ctx.user.id;

    // ── All-or-none, and all inside the same transaction ───────────────────
    // Everything above this line is a courtesy to the caller: it answers 409
    // early and cheaply when the case has obviously moved. NOTHING above is
    // relied on as a safeguard, because a check that commits in a different
    // transaction from the write it guards is not a check.
    //
    // Serializable, so Postgres itself refuses an unsafe interleaving; and
    // belt and braces beneath it, because a rollback the database chooses is
    // a coarser instrument than knowing exactly which record moved.
    const result = await prisma.$transaction(
      async (tx) => {
        // 1. The case's OWN lock — the same advisory lock the records builder
        //    takes to publish. A rebuild cannot re-segment the documents this
        //    plan is derived from while this transaction holds it.
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock($1)", caseLockKey(params.caseId));

        // 2. Explicit row locks on exactly what is about to be written.
        //    `ChronologyEvent` has no `updatedAt`, so there is no version
        //    column to compare against — and the retention job rewrites
        //    `sourceQuote` without touching review state, so the write's own
        //    predicate could not have caught it. Locking the rows here means
        //    the content read below is the content committed.
        if (plan.eventIds.length) {
          await tx.$queryRawUnsafe(
            'SELECT "id" FROM "ChronologyEvent" WHERE "id" = ANY($1::text[]) AND "caseId" = $2 FOR UPDATE',
            plan.eventIds,
            params.caseId,
          );
        }
        if (plan.rowIds.length) {
          await tx.$queryRawUnsafe(
            'SELECT "id" FROM "ExtractedEncounter" WHERE "id" = ANY($1::text[]) AND "caseId" = $2 AND "firmId" = $3 FOR UPDATE',
            plan.rowIds,
            params.caseId,
            ctx.firm.id,
          );
        }

        // 3. Re-derive the WHOLE plan through the transaction client, under
        //    those locks. Grouping, findings, eligibility, counts, cautions,
        //    row content and event content are all bound by the one hash — so
        //    a finding raised, a document re-segmented or a quote purged since
        //    the dialog opened is caught here, not merely earlier.
        const fresh = await derivePlan(params.caseId, ctx.firm.id, tx as unknown as ConfirmClient);
        if (fresh.plan.manifestHash !== input.expectedManifestHash) {
          throw new StaleConfirmation("the case");
        }

        // 4. And the rows themselves, re-read and re-checked here.
        const locked = await tx.extractedEncounter.findMany({
          where: { id: { in: fresh.plan.rowIds }, caseId: params.caseId, firmId: ctx.firm.id, ...REVIEW_VISIBLE_WHERE },
        });
        if (locked.length !== fresh.plan.rowIds.length) throw new StaleConfirmation("a record in this batch");
        for (const row of locked) {
          if (!CONFIRMABLE_ROW_STATES.includes(row.status)) throw new StaleConfirmation(`record ${row.id}`);
          if (attestationBlockers(row as never).length) throw new StaleConfirmation(`record ${row.id}`);
        }

        let confirmedRows = 0;
        for (const row of locked) {
          // Compare-and-set on the exact version just validated, AND on the
          // status still being a machine draft. Either moving aborts
          // everything — a redundancy under the locks above, kept because a
          // safeguard that depends on another safeguard holding is one
          // safeguard.
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

        const manifestRows = locked.map((r) => ({ id: r.id, contentHash: encounterContentHash(r), status: r.status }));
        const events = fresh.events.filter((e) => fresh.plan.eventIds.includes(e.id));

        let confirmedEvents = 0;
        for (const event of events) {
          const applied = await tx.chronologyEvent.updateMany({
            // Review state only. The CONTENT is guarded by the row lock and
            // the in-transaction manifest above, which is what an event
            // without a version column requires.
            where: { id: event.id, caseId: params.caseId, reviewStatus: "AI_DRAFT", edited: false },
            data: { reviewStatus: "REVIEWED", reviewedById: actor, reviewedAt: now },
          });
          if (applied.count === 0) throw new ConcurrentChange(`chronology event ${event.id}`);
          confirmedEvents += applied.count;
        }

        // ── The record of what was confirmed ────────────────────────────────
        // Committed WITH the writes, and built from the plan re-derived HERE:
        // an audit entry describing a case state that had already moved is a
        // signature over content nobody can reconstruct.
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
              counts: fresh.plan.counts,
              // Exactly what was covered, and exactly the content it held.
              manifestHash: fresh.plan.manifestHash,
              rows: manifestRows.map((r) => ({ id: r.id, contentHash: r.contentHash })),
              events: fresh.plan.eventIds,
              // The content each confirmed chronology entry held, since the
              // event carries no version column of its own.
              eventContentHashes: events.map((e) => ({ id: e.id, contentHash: chronologyEventContentHash(e) })),
              encounters: fresh.plan.encounters
                .filter((e) => e.eligible)
                .map((e) => ({ noteId: e.noteId, level: e.level, guidanceKind: e.guidanceKind, rowIds: e.rowIds })),
              // Cautioned records, which this act did NOT cover and which are
              // NOT counted among the exceptions below.
              cautionEncounters: fresh.plan.counts.cautionEncounters,
              cautionsByKind: fresh.plan.cautionsByKind,
              cautionsByReason: fresh.plan.cautionsByReason,
              // How each covered record's membership was established.
              groupingBasis: fresh.plan.basisCounts,
              // What this act did NOT cover, and why.
              skippedEncounters: fresh.plan.counts.skippedEncounters,
              skippedByReason: fresh.plan.skippedByReason,
              // …and what it passed over without that being anybody's decision:
              // records waiting on an assignment decision elsewhere, or on
              // another appearance of one of their rows.
              heldEncounters: fresh.plan.counts.heldEncounters,
              heldByReason: fresh.plan.heldByReason,
              heldChronologyEvents: fresh.plan.counts.heldEvents,
              heldChronologyByReason: fresh.plan.heldEventsByReason,
              note: input.note ?? null,
            },
          },
          tx as never,
        );

        return { confirmedRows, confirmedEvents, plan: fresh.plan };
      },
      // Postgres refuses an unsafe interleaving itself, beneath the locks. The
      // timeout matches the records builder's: this transaction re-derives a
      // whole case's canonical grouping inside itself.
      { isolationLevel: "Serializable", timeout: 120_000 },
    );

    return ok({
      applied: result.confirmedRows + result.confirmedEvents,
      rows: result.confirmedRows,
      events: result.confirmedEvents,
      counts: result.plan.counts,
      skippedByReason: result.plan.skippedByReason,
      heldByReason: result.plan.heldByReason,
      heldEventsByReason: result.plan.heldEventsByReason,
      cautionsByKind: result.plan.cautionsByKind,
    });
  } catch (err) {
    // Three ways the same thing goes wrong — the case moved — and one answer:
    // nothing was written, look again. Distinguished only in the wording, so a
    // reviewer can tell "somebody edited a record" from "the figures changed".
    if (err instanceof StaleConfirmation) {
      return ok(
        {
          error: `Nothing was confirmed: ${err.what} changed after these counts were shown. Reload the records and review the new figures before confirming.`,
          applied: 0,
          stale: true,
        },
        409,
      );
    }
    if (err instanceof ConcurrentChange) {
      return ok(
        {
          error: `Nothing was confirmed: ${err.what} changed while the confirmation was being applied. Reload and review the new figures.`,
          applied: 0,
          stale: true,
        },
        409,
      );
    }
    if (isSerializationFailure(err)) {
      return ok(
        {
          error:
            "Nothing was confirmed: another change to this case was being applied at the same time. Reload the records and confirm again.",
          applied: 0,
          stale: true,
        },
        409,
      );
    }
    return handleError(err);
  }
}
