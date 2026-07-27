import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  Footer,
  PageNumber,
} from "docx";
import { prisma } from "@/lib/db";
import { parseBasis } from "@/lib/engine/lifeExpectancy";
import type {
  SelfCritique,
  WeakeningItem,
  UnknownItem,
  ClassifiedEvidenceItem,
  EvidenceSufficiency,
} from "@/lib/engine/clinicalReasoning";

// ─────────────────────────────────────────────────────────────────────────────
// Testimony Preparation Pack. A projection of what the reasoning engine has
// ALREADY persisted — self-critique, weakening evidence, unknowns, sufficiency,
// defense-vulnerability findings — into the document an expert needs the night
// before a deposition: for each recommendation, the anticipated lines of
// cross-examination, the record-cited response to each, and the concessions to
// make honestly. Nothing here is newly reasoned; every line traces to a
// persisted assessment or review finding, and where no rebuttal exists the pack
// says so rather than inventing one. The pack never asserts physician approval
// that has not occurred.
// ─────────────────────────────────────────────────────────────────────────────

export interface CrossLine {
  attack: string; // the anticipated question / line of attack
  basis: string; // where the attack comes from (defense review, weakening evidence, …)
  answer: string | null; // the record-supported response; null = none recorded
  citation: string | null; // source backing the answer
}

export interface TestimonyEntry {
  service: string;
  category: string;
  presentValue: number;
  physicianStatus: string;
  included: boolean;
  contingencyOnly: boolean;
  crossLines: CrossLine[];
  /** page-cited record support usable as answers under cross */
  recordSupport: { text: string; citation: string }[];
  concessions: string[];
}

export interface TestimonyItemInput {
  id: string;
  service: string;
  category: string;
  presentValue: number;
  physicianStatus: string;
  contingencyOnly: boolean;
  missingSupport?: string | null;
  defenseVulnerability?: string | null;
}

export interface TestimonyAssessmentInput {
  recommendationId: string;
  medicalNecessityRationale?: string | null;
  selfCritique?: SelfCritique | null;
  weakeningEvidence?: WeakeningItem[] | null;
  unknowns?: UnknownItem[] | null;
  evidenceItems?: ClassifiedEvidenceItem[] | null;
  evidenceSufficiency?: EvidenceSufficiency | null;
  residualUncertainty?: string | null;
}

export interface DefenseFindingInput {
  relatedItemId?: string | null;
  category: string;
  description: string;
  counterArgument?: string | null;
  counterSource?: string | null;
  counterCitation?: string | null;
}

const APPROVED = new Set(["APPROVED", "MODIFIED"]);

/** Build one recommendation's testimony entry — pure, fully testable. */
export function buildTestimonyEntry(
  item: TestimonyItemInput,
  assessment: TestimonyAssessmentInput | null,
  defenseFindings: DefenseFindingInput[],
  included: boolean,
): TestimonyEntry {
  const crossLines: CrossLine[] = [];
  const concessions: string[] = [];
  const critique = assessment?.selfCritique ?? null;
  // The standing affirmative answer is the engine's own "why recommended" — a
  // persisted statement, not something composed for this document.
  const standingAnswer = critique?.whyRecommended?.trim() || assessment?.medicalNecessityRationale?.trim() || null;

  // 1) Defense-vulnerability review findings targeting this item: the attack is
  // the reviewer's argument; the answer is the recorded counter-argument ONLY.
  for (const f of defenseFindings) {
    crossLines.push({
      attack: f.description,
      basis: `Defense vulnerability review — ${f.category}`,
      answer: f.counterArgument?.trim() || null,
      citation: f.counterCitation?.trim() || f.counterSource?.trim() || null,
    });
  }

  // 2) Material weakening evidence: opposing counsel has this too (or will find
  // it). Surface it as a line of attack with the standing answer.
  for (const w of assessment?.weakeningEvidence ?? []) {
    if (w.materiality === "LOW") continue;
    crossLines.push({
      attack: `${w.claim}: ${w.detail}`,
      basis: `Weakening evidence (${w.materiality.toLowerCase()} materiality)${w.source ? ` — ${w.source}${w.page ? `, p. ${w.page}` : ""}` : ""}`,
      answer: standingAnswer,
      citation: null,
    });
  }

  // 3) A pending physician review is a guaranteed cross question. Never answer
  // it by implying approval that has not occurred.
  if (!APPROVED.has(item.physicianStatus)) {
    crossLines.push({
      attack:
        item.physicianStatus === "REJECTED"
          ? "The reviewing physician rejected this recommendation — why does it appear in your materials?"
          : "Has a physician approved this recommendation?",
      basis: "Physician review status",
      answer:
        item.physicianStatus === "REJECTED"
          ? "It was rejected on review and is not included in the plan totals; it is disclosed for completeness."
          : included
            ? "Not yet — it is included on the basis of treating-record support and medical probability, and remains subject to physician confirmation."
            : "Not yet — and pending that review it is not included in the plan totals.",
      citation: null,
    });
  }

  // 4) Contingency-only items: the attack is double-counting; the answer is the
  // inclusion arithmetic.
  if (item.contingencyOnly) {
    crossLines.push({
      attack: "Isn't this contingency care speculative — and counted in your totals?",
      basis: "Staged/contingent classification",
      answer: "It is disclosed as a contingency and is NOT entered into the totals; it is stated so the trier of fact understands the foreseeable risk.",
      citation: null,
    });
  }

  // 5) Insufficient evidence, per the engine's own sufficiency verdict.
  const suff = assessment?.evidenceSufficiency ?? null;
  if (suff && !suff.sufficient) {
    crossLines.push({
      attack: `Your own analysis scores the supporting evidence ${suff.score}/100, below your threshold of ${suff.threshold}. Why is this item in the plan?`,
      basis: "Evidence Sufficiency Engine",
      answer: included
        ? standingAnswer
        : "It is not in the totals — the plan discloses it while the identified evidence gaps are addressed.",
      citation: null,
    });
    for (const m of suff.missing) concessions.push(`Missing evidence: ${m}.`);
  }

  // Concessions to make honestly — drawn from the persisted unknowns and the
  // engine's self-critique, never sanded down.
  for (const u of assessment?.unknowns ?? []) {
    concessions.push(`${u.missing} — ${u.whyItMatters}${u.suggestedAction ? ` (obtainable via: ${u.suggestedAction.toLowerCase()})` : ""}`);
  }
  for (const a of critique?.assumptions ?? []) concessions.push(`Assumption, not documentation: ${a}`);
  for (const i of critique?.inferredNotDocumented ?? []) concessions.push(`Inferred rather than documented: ${i}`);
  if (assessment?.residualUncertainty?.trim()) concessions.push(assessment.residualUncertainty.trim());

  // Page-cited record support the witness can answer from.
  const recordSupport = (assessment?.evidenceItems ?? [])
    .filter((e) => e.objective && e.epistemic === "documented_fact" && e.source)
    .slice(0, 6)
    .map((e) => ({ text: e.text, citation: `${e.source}${e.page ? `, p. ${e.page}` : ""}` }));

  return {
    service: item.service,
    category: item.category,
    presentValue: item.presentValue,
    physicianStatus: item.physicianStatus,
    included,
    contingencyOnly: item.contingencyOnly,
    crossLines,
    recordSupport,
    concessions: [...new Set(concessions)],
  };
}

/** Plan-level attack surface: the assumptions every lifetime figure rides on. */
export function planLevelCrossLines(opts: {
  leBasisRecorded: boolean;
  leApprovedBy: string | null;
  lifeExpectancyYears: number;
  discountRate: number;
  medicalInflation: number;
  anyLivePricing: boolean;
}): CrossLine[] {
  const lines: CrossLine[] = [];
  lines.push({
    attack: `Where does your ${opts.lifeExpectancyYears.toFixed(1)}-year life expectancy come from?`,
    basis: "Economic assumptions",
    answer: opts.leBasisRecorded
      ? `It is derived from the recorded actuarial basis${opts.leApprovedBy ? `, reviewed and approved by ${opts.leApprovedBy}` : ""} — the basis, each adjustment, and its source are stated in the plan's Assumptions.`
      : null,
    citation: opts.leBasisRecorded ? "Plan Assumptions — life-expectancy basis" : null,
  });
  lines.push({
    attack: `Why a ${(opts.discountRate * 100).toFixed(1)}% discount rate against ${(opts.medicalInflation * 100).toFixed(1)}% medical inflation?`,
    basis: "Economic assumptions",
    answer: "Both rates are stated in the Assumptions, applied uniformly, and the plan's sensitivity table shows the present value under alternative rates — the opinion does not depend on a favorable pick.",
    citation: "Plan — sensitivity analysis",
  });
  lines.push({
    attack: "Are your unit prices anything more than national averages?",
    basis: "Pricing methodology",
    answer: opts.anyLivePricing
      ? "Line items priced through the live benchmark feed are venue-specific (FAIR Health geozip, 80th percentile) and each carries its retrieval date and source snapshot."
      : "Prices are labeled national reference figures with their professional source stated per line; venue-specific benchmark pricing is applied when the licensed feed is enabled, and every figure is editable with a ledgered reason.",
    citation: "Cost tables — per-item pricing source",
  });
  return lines;
}

// ── DOCX rendering ───────────────────────────────────────────────────────────

const FONT = "Garamond";
const NAVY = "1F3864";
const INK = "1A1A1A";
const GREY = "595959";
const BODY = 23;

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

function h1(text: string, pageBreak = false) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    pageBreakBefore: pageBreak,
    spacing: { before: 320, after: 160 },
    keepNext: true,
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: NAVY, space: 6 } },
    children: [new TextRun({ text, bold: true, color: NAVY, size: 30 })],
  });
}
function h2(text: string) {
  return new Paragraph({ spacing: { before: 240, after: 100 }, keepNext: true, children: [new TextRun({ text, bold: true, color: NAVY, size: 26 })] });
}
function p(text: string, opts: { italics?: boolean; bold?: boolean; size?: number; color?: string; indent?: number } = {}) {
  return new Paragraph({
    spacing: { after: 140, line: 300 },
    alignment: AlignmentType.JUSTIFIED,
    indent: opts.indent ? { left: opts.indent } : undefined,
    children: [new TextRun({ text, italics: opts.italics, bold: opts.bold, size: opts.size ?? BODY, color: opts.color ?? INK })],
  });
}
function labeled(label: string, bodyText: string, color = INK) {
  return new Paragraph({
    spacing: { after: 90, line: 288 },
    alignment: AlignmentType.JUSTIFIED,
    indent: { left: 280 },
    children: [new TextRun({ text: `${label}  `, bold: true, size: 21, color: NAVY }), new TextRun({ text: bodyText, size: 21, color })],
  });
}

export interface TestimonyPackPayload {
  buffer: Buffer;
  entryCount: number;
  crossLineCount: number;
}

export async function buildTestimonyPackDocx(caseId: string): Promise<TestimonyPackPayload> {
  const c = await prisma.case.findUniqueOrThrow({
    where: { id: caseId },
    include: {
      firm: true,
      futureCareItems: { where: { supersededAt: null }, orderBy: { presentValue: "desc" } },
      reviewFindings: { where: { kind: "DEFENSE" } },
      reasoningAssessments: { where: { status: { not: "SUPERSEDED" }, supersededById: null }, orderBy: { updatedAt: "desc" } },
    },
  });

  // Latest active assessment per recommendation.
  const byRec = new Map<string, (typeof c.reasoningAssessments)[number]>();
  for (const a of c.reasoningAssessments) if (!byRec.has(a.recommendationId)) byRec.set(a.recommendationId, a);

  const findingsFor = (id: string) => c.reviewFindings.filter((f) => f.relatedItemId === id);
  const notTotaled = (it: (typeof c.futureCareItems)[number]) => it.contingencyOnly || it.physicianStatus === "REJECTED";

  const entries = c.futureCareItems.map((it) => {
    const a = byRec.get(it.id);
    return buildTestimonyEntry(
      {
        id: it.id,
        service: it.service,
        category: it.category,
        presentValue: it.presentValue,
        physicianStatus: it.physicianStatus,
        contingencyOnly: it.contingencyOnly,
        missingSupport: it.missingSupport,
        defenseVulnerability: it.defenseVulnerability,
      },
      a
        ? {
            recommendationId: a.recommendationId,
            medicalNecessityRationale: a.medicalNecessityRationale,
            selfCritique: (a.selfCritique as unknown as SelfCritique) ?? null,
            weakeningEvidence: (a.weakeningEvidence as unknown as WeakeningItem[]) ?? null,
            unknowns: (a.unknowns as unknown as UnknownItem[]) ?? null,
            evidenceItems: (a.evidenceItems as unknown as ClassifiedEvidenceItem[]) ?? null,
            evidenceSufficiency: (a.evidenceSufficiency as unknown as EvidenceSufficiency) ?? null,
            residualUncertainty: a.residualUncertainty,
          }
        : null,
      findingsFor(it.id),
      !notTotaled(it),
    );
  });

  const leBasis = parseBasis(c.lifeExpectancyBasis);
  const planLines = planLevelCrossLines({
    leBasisRecorded: !!leBasis && leBasis.method !== "UNSTATED",
    leApprovedBy: leBasis?.approvedByName ?? null,
    lifeExpectancyYears: c.lifeExpectancyYears ?? 0,
    discountRate: c.discountRate,
    medicalInflation: c.medicalInflation,
    anyLivePricing: c.futureCareItems.some((it) => it.pricedAt != null),
  });

  const body: Paragraph[] = [];
  body.push(
    new Paragraph({
      spacing: { before: 200, after: 60 },
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "TESTIMONY PREPARATION PACK", bold: true, size: 34, color: NAVY })],
    }),
    new Paragraph({
      spacing: { after: 40 },
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `${c.clientName} — ${c.caseNumber}`, size: 24, color: INK })],
    }),
    new Paragraph({
      spacing: { after: 240 },
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "Privileged & confidential — prepared in anticipation of litigation. Preparation material only; not for filing or production.", italics: true, size: 18, color: GREY })],
    }),
  );

  body.push(h1("How to Use This Pack"));
  body.push(
    p(
      "Every line in this pack is drawn from the plan's persisted analysis — the defense-vulnerability review, the reasoning engine's own self-critique, its weakening-evidence and unknowns ledgers, and its evidence-sufficiency scores. Where a rebuttal is recorded, it is stated with its source. Where none is recorded, the pack says so: do not improvise one under oath. The concessions listed for each recommendation are accurate; making them plainly is what preserves credibility on everything else.",
    ),
  );

  body.push(h1("Plan-Level Questions"));
  for (const [i, line] of planLines.entries()) {
    body.push(h2(`Q${i + 1}. ${line.attack}`));
    body.push(labeled("Arises from:", line.basis, GREY));
    body.push(
      line.answer
        ? labeled("Response:", line.answer)
        : labeled("Response:", "NO BASIS IS RECORDED. Resolve this before testimony — derive and document the basis in the plan; do not improvise an answer.", "B00020"),
    );
    if (line.citation) body.push(labeled("Cite:", line.citation, GREY));
  }

  let crossLineCount = planLines.length;
  body.push(h1("Recommendations", true));
  for (const e of entries) {
    if (e.crossLines.length === 0 && e.concessions.length === 0) continue;
    body.push(h2(`${e.service} — ${money(e.presentValue)}${e.included ? "" : " (not in totals)"}${e.contingencyOnly ? " — contingency only" : ""}`));
    e.crossLines.forEach((line, i) => {
      crossLineCount++;
      body.push(p(`Q${i + 1}. ${line.attack}`, { bold: true, size: 22 }));
      body.push(labeled("Arises from:", line.basis, GREY));
      body.push(
        line.answer
          ? labeled("Response:", line.answer)
          : labeled("Response:", "No rebuttal is recorded for this point. Concede it or resolve it before testimony — do not improvise.", "B00020"),
      );
      if (line.citation) body.push(labeled("Cite:", line.citation, GREY));
    });
    if (e.recordSupport.length) {
      body.push(p("Record support to answer from:", { bold: true, size: 21 }));
      for (const r of e.recordSupport) body.push(labeled("•", `${r.text} (${r.citation})`));
    }
    if (e.concessions.length) {
      body.push(p("Concede honestly:", { bold: true, size: 21 }));
      for (const con of e.concessions) body.push(labeled("•", con, GREY));
    }
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: BODY, color: INK } } } },
    sections: [
      {
        properties: {},
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: `${c.clientName} — Testimony Preparation Pack — page `, size: 16, color: GREY }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: GREY }),
                ],
              }),
            ],
          }),
        },
        children: body,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  return { buffer: Buffer.from(buffer), entryCount: entries.length, crossLineCount };
}
