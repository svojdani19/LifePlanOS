// ─────────────────────────────────────────────────────────────────────────────
// Evidence graph (P2). Materializes the relationships the pipeline already
// derives — diagnosis → record evidence, recommendation → diagnosis,
// recommendation → literature, diagnosis → guideline, contradictions — as
// EvidenceLink rows, so the Evidence Explorer (and any future consumer) can
// query provenance instead of parsing free text. NO new inference happens
// here: every link is lifted from structured fields the engines populated.
// Derived data — rebuilt after each generation, replaced atomically.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";

export interface LinkRow {
  kind: "DIAGNOSIS_EVIDENCE" | "REC_DIAGNOSIS" | "REC_LITERATURE" | "DIAGNOSIS_GUIDELINE" | "CONTRADICTS";
  fromType: "condition" | "futureCareItem";
  fromId: string;
  toType: "document" | "condition" | "citation" | "guideline";
  toId: string | null;
  documentId?: string | null;
  page?: number | null;
  quote?: string | null;
  meta?: unknown;
}

interface CondIn {
  id: string;
  name: string;
  opposingRecords?: string | null;
  evidenceSources?: unknown;
  socAnalysis?: unknown;
}
interface ItemIn {
  id: string;
  conditionId?: string | null;
  citation?: unknown;
  supersededAt?: Date | null;
}

/** Pure: derive the link rows from already-structured engine output. */
export function buildLinks(conditions: CondIn[], items: ItemIn[]): LinkRow[] {
  const out: LinkRow[] = [];
  for (const c of conditions) {
    // Diagnosis → record evidence (document, page, verbatim quote).
    const sources = (Array.isArray(c.evidenceSources) ? c.evidenceSources : []) as { documentId?: string; filename?: string; page?: number | null; quote?: string }[];
    for (const s of sources) {
      out.push({ kind: "DIAGNOSIS_EVIDENCE", fromType: "condition", fromId: c.id, toType: "document", toId: s.documentId ?? null, documentId: s.documentId ?? null, page: s.page ?? null, quote: s.quote ?? null, meta: { filename: s.filename } });
    }
    // Diagnosis → guideline (verbatim-quoted clinical guidance from SoC).
    const soc = c.socAnalysis as { guidelines?: { title?: string; year?: string; pmid?: string; doi?: string; url?: string; quote?: string; relevance?: { evidenceLabel?: string; whyRelevant?: string; supports?: string; limitations?: string | null } }[] } | null;
    for (const g of soc?.guidelines ?? []) {
      if (!g?.title) continue;
      out.push({ kind: "DIAGNOSIS_GUIDELINE", fromType: "condition", fromId: c.id, toType: "guideline", toId: null, quote: g.quote ?? null, meta: { title: g.title, year: g.year, pmid: g.pmid, doi: g.doi, url: g.url, evidenceLabel: g.relevance?.evidenceLabel, whyRelevant: g.relevance?.whyRelevant, supports: g.relevance?.supports, limitations: g.relevance?.limitations } });
    }
    // Contradictory evidence, when the causation analysis recorded any.
    if (c.opposingRecords) {
      out.push({ kind: "CONTRADICTS", fromType: "condition", fromId: c.id, toType: "document", toId: null, quote: c.opposingRecords });
    }
  }
  for (const it of items) {
    if (it.supersededAt) continue; // graph reflects the current plan
    if (it.conditionId) {
      out.push({ kind: "REC_DIAGNOSIS", fromType: "futureCareItem", fromId: it.id, toType: "condition", toId: it.conditionId });
    }
    const cites = (Array.isArray(it.citation) ? it.citation : it.citation ? [it.citation] : []) as { title?: string; authors?: string; journal?: string; year?: string; pmid?: string; doi?: string; url?: string; relevance?: { evidenceLabel?: string; whyRelevant?: string; supports?: string; limitations?: string | null; score?: number } }[];
    for (const cc of cites) {
      if (!cc?.title) continue;
      // Claim-based: every literature link carries WHAT CLAIM it supports, why
      // it was selected, and its limitations — never a bare article listing.
      out.push({ kind: "REC_LITERATURE", fromType: "futureCareItem", fromId: it.id, toType: "citation", toId: null, meta: { title: cc.title, authors: cc.authors, journal: cc.journal, year: cc.year, pmid: cc.pmid, doi: cc.doi, url: cc.url, evidenceLabel: cc.relevance?.evidenceLabel, whyRelevant: cc.relevance?.whyRelevant, supports: cc.relevance?.supports, limitations: cc.relevance?.limitations } });
    }
  }
  return out;
}

/** Rebuild the case's evidence graph from current data (atomic replace). */
export async function rebuildEvidenceGraph(caseId: string, firmId: string): Promise<number> {
  const [conditions, items] = await Promise.all([
    prisma.condition.findMany({ where: { caseId } }),
    prisma.futureCareItem.findMany({ where: { caseId, supersededAt: null } }),
  ]);
  const links = buildLinks(conditions as unknown as CondIn[], items as unknown as ItemIn[]);
  await prisma.$transaction([
    prisma.evidenceLink.deleteMany({ where: { caseId } }),
    ...(links.length
      ? [prisma.evidenceLink.createMany({ data: links.map((l) => ({ ...l, meta: (l.meta as never) ?? undefined, caseId, firmId })) })]
      : []),
  ]);
  return links.length;
}
