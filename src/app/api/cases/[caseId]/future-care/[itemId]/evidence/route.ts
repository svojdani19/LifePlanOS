import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase } from "@/lib/tenant";
import { findCandidates } from "@/lib/literature";
import { serviceKeyOf } from "@/lib/engine/persistLedger";
import { EVIDENCE_CLAIMS } from "@/lib/engine/evidenceLedger";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// A clinician's own citation, attached to one recommendation and one claim.
//
// The automated literature pass searches by condition and anatomy. A physician
// reading around a case — in the journals, in a clinical synthesis tool, in
// their own practice — routinely finds the paper that actually answers the
// question, and until now had nowhere to put it.
//
// The article is RESOLVED, never taken on trust: the DOI, PMID or title is
// looked up through the same Europe PMC / Crossref path the rest of the
// literature uses, and only a real, resolvable record is stored. That keeps
// one rule intact — every citation in a plan is a record that exists, with
// text that can be quoted verbatim. A pasted reference nobody can resolve is
// refused rather than printed.
//
// The row is marked with the physician's id, which is what protects it from
// the next plan generation: derived rows are rebuilt, a person's are not.
// ─────────────────────────────────────────────────────────────────────────────

const bodySchema = z.object({
  /** DOI, PMID, or a title to search for. */
  reference: z.string().min(4).max(400),
  /** Which claim about this recommendation the article speaks to. */
  claim: z.enum(EVIDENCE_CLAIMS as unknown as [string, ...string[]]),
  /** Whether it supports the recommendation or argues against it. */
  stance: z.enum(["SUPPORTS", "OPPOSES"]).default("SUPPORTS"),
  /** The physician's own note on why it applies — quoted as their words. */
  note: z.string().max(1000).optional(),
});

type Params = { params: Promise<{ caseId: string; itemId: string }> };

/**
 * The contributor's role and stated credential at the moment of contribution.
 *
 * Snapshotted, not looked up later: a physician who leaves the firm, or whose
 * role changes, must not retroactively alter what a plan says about who chose
 * a citation.
 */
async function resolveContributor(userId: string, firmId: string): Promise<{ role: string; credential: string | null }> {
  // Optional-chained: a client generated before `credentialSummary` existed
  // throws SYNCHRONOUSLY on the call, so `.catch` never gets a promise. An
  // unavailable lookup should cost the attribution, not the citation.
  const user = await prisma.user
    ?.findFirst({ where: { id: userId, firmId }, select: { role: true, credentialSummary: true } })
    .catch(() => null);
  return { role: user?.role ?? "UNKNOWN", credential: user?.credentialSummary ?? null };
}

const DOI = /\b10\.\d{4,9}\/[^\s"<>]+/i;
const PMID = /^\s*(?:pmid:?\s*)?(\d{6,9})\s*$/i;

export async function POST(req: Request, { params: paramsPromise }: Params) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    // The SAME canonical permission the control is gated on. It previously
    // required `records.verify` while the button was drawn from the legacy
    // role permission `futurecare.edit` — two different authorization systems,
    // so the set of people who could see the control and the set who could use
    // it did not have to overlap. `futurecare.edit` is the canonical key for
    // authoring a recommendation, and attaching its evidence is that act.
    requireCanonicalPermission(ctx, "futurecare.edit", { caseId: params.caseId });
    await requireCase(ctx, params.caseId);
    const input = bodySchema.parse(await req.json());

    // Who is contributing, recorded as it was at the time. A section headed
    // "Physician-selected evidence" asserted something a bare user id could
    // not support: planners hold this permission too, and they do legitimate
    // literature work. The row now carries the truth and the heading follows
    // it, rather than the heading asserting something about the row.
    const contributor = await resolveContributor(ctx.user.id, ctx.firm.id);

    // Tenant- and case-scoped by construction.
    const item = await prisma.futureCareItem.findFirst({
      where: { id: params.itemId, caseId: params.caseId, supersededAt: null },
      select: { id: true, conditionId: true, service: true, lineageId: true },
    });
    if (!item) return ok({ error: "That recommendation is not part of this case." }, 404);

    // ── Resolve it ─────────────────────────────────────────────────────────
    const doi = DOI.exec(input.reference)?.[0];
    const pmid = PMID.exec(input.reference)?.[1];
    const query = doi ?? pmid ?? input.reference;
    const candidates = await findCandidates(query, 8).catch(() => []);
    const article =
      candidates.find((a) => doi && a.doi?.toLowerCase() === doi.toLowerCase()) ??
      candidates.find((a) => pmid && a.pmid === pmid) ??
      candidates[0];

    if (!article) {
      return ok(
        {
          error:
            "That reference could not be resolved in Europe PMC or Crossref, so it was not attached. A citation that cannot be looked up cannot be quoted in the plan — check the DOI or paste the full title.",
        },
        422,
      );
    }

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.recommendationEvidence.create({
        data: {
          firmId: ctx.firm.id,
          caseId: params.caseId,
          futureCareItemId: item.id,
          // Identity that survives regeneration. Without these the citation is
          // preserved by the rebuild and then addresses a recommendation that
          // no longer exists.
          lineageId: item.lineageId ?? null,
          serviceKey: serviceKeyOf(item.service),
          conditionId: item.conditionId,
          claim: input.claim,
          stance: input.stance,
          strength: "LITERATURE",
          sourceKind: "PHYSICIAN",
          // The physician's own words on applicability, or the abstract's
          // opening as the neutral fallback. Never a generated summary.
          quote: input.note?.trim() || (article.abstract ?? "").slice(0, 400) || article.title,
          citationTitle: article.title,
          citationJournal: article.journal || null,
          citationYear: article.year || null,
          citationDoi: article.doi || null,
          citationPmid: article.pmid || null,
          citationUrl: article.url || null,
          producerVersion: null,
          addedById: ctx.user.id,
          addedAt: new Date(),
          // Who this was, at the time. A user id alone cannot support a
          // section headed "Physician-selected evidence".
          addedByRole: contributor.role,
          addedByCredential: contributor.credential,
        },
      });
      await tx.auditLog.create({
        data: {
          firmId: ctx.firm.id,
          userId: ctx.user.id,
          action: "futurecare.evidence_added",
          targetType: "futureCareItem",
          targetId: item.id,
          caseId: params.caseId,
          meta: {
            claim: input.claim,
            stance: input.stance,
            doi: article.doi ?? null,
            pmid: article.pmid ?? null,
            source: article.source,
            contributorRole: contributor.role,
          } as never,
        },
      });
      return row;
    });

    return ok({
      evidence: {
        id: created.id,
        claim: created.claim,
        stance: created.stance,
        title: created.citationTitle,
        journal: created.citationJournal,
        year: created.citationYear,
        url: created.citationUrl,
      },
    });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(req: Request, { params: paramsPromise }: Params) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "futurecare.edit", { caseId: params.caseId });
    await requireCase(ctx, params.caseId);
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("evidenceId");
    if (!id) return ok({ error: "No evidence row was named." }, 422);

    // Only a physician-added row may be removed here, and only within this
    // firm's case. Derived rows are the generator's to manage.
    const gone = await prisma.recommendationEvidence.deleteMany({
      where: { id, caseId: params.caseId, firmId: ctx.firm.id, futureCareItemId: params.itemId, addedById: { not: null } },
    });
    if (!gone.count) return ok({ error: "That citation is not one this case can remove." }, 404);

    await prisma.auditLog.create({
      data: {
        firmId: ctx.firm.id,
        userId: ctx.user.id,
        action: "futurecare.evidence_removed",
        targetType: "futureCareItem",
        targetId: params.itemId,
        caseId: params.caseId,
        meta: { evidenceId: id } as never,
      },
    });
    return ok({ removed: gone.count });
  } catch (err) {
    return handleError(err);
  }
}
