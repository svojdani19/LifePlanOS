import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requireCanonicalPermission, requireCase } from "@/lib/tenant";
import { findCandidates } from "@/lib/literature";
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

const DOI = /\b10\.\d{4,9}\/[^\s"<>]+/i;
const PMID = /^\s*(?:pmid:?\s*)?(\d{6,9})\s*$/i;

export async function POST(req: Request, { params: paramsPromise }: Params) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    // Attaching clinical evidence to a recommendation is a professional act,
    // held to the same permission as attesting to a record.
    requireCanonicalPermission(ctx, "records.verify", { caseId: params.caseId });
    await requireCase(ctx, params.caseId);
    const input = bodySchema.parse(await req.json());

    // Tenant- and case-scoped by construction.
    const item = await prisma.futureCareItem.findFirst({
      where: { id: params.itemId, caseId: params.caseId, supersededAt: null },
      select: { id: true, conditionId: true, service: true },
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
    requireCanonicalPermission(ctx, "records.verify", { caseId: params.caseId });
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
