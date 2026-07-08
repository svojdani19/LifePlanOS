import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
} from "docx";
import { prisma } from "@/lib/db";
import { assumptionsFor } from "@/lib/engine/generate";
import type { CaseSide } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Report generator (Module 13). Produces a real .docx life care plan with the
// standard sections, and a CSV cost table. Template (plaintiff/defense/neutral)
// changes framing and which appendices lead.
// ─────────────────────────────────────────────────────────────────────────────

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const fmtDate = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—");

function h(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_2) {
  return new Paragraph({ text, heading: level, spacing: { before: 240, after: 120 } });
}
function p(text: string, opts: { bold?: boolean; italics?: boolean } = {}) {
  return new Paragraph({ children: [new TextRun({ text, bold: opts.bold, italics: opts.italics })], spacing: { after: 80 } });
}
function cell(text: string, opts: { bold?: boolean; width?: number } = {}) {
  return new TableCell({
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text, bold: opts.bold, size: 18 })] })],
  });
}
function row(cells: TableCell[]) {
  return new TableRow({ children: cells });
}

export interface ReportPayload {
  buffer: Buffer;
  totalLifetime: number;
  totalPresentValue: number;
  itemCount: number;
}

export async function buildReportDocx(caseId: string, template: CaseSide): Promise<ReportPayload> {
  const c = await prisma.case.findUniqueOrThrow({
    where: { id: caseId },
    include: {
      firm: true,
      chronologyEvents: { orderBy: { eventDate: "asc" } },
      conditions: true,
      futureCareItems: { orderBy: { presentValue: "desc" } },
      reviewFindings: true,
      documents: true,
    },
  });
  const a = assumptionsFor(c);
  const items = c.futureCareItems;
  const totalLifetime = items.reduce((s, i) => s + i.lifetimeCost, 0);
  const totalPresentValue = items.reduce((s, i) => s + i.presentValue, 0);

  const framing =
    template === "DEFENSE"
      ? "This neutral-to-defense review emphasizes the evidentiary support and vulnerabilities of each recommendation."
      : template === "NEUTRAL"
        ? "This neutral life care plan presents medically probable future care with transparent support."
        : "This life care plan sets out the future care reasonably required as a result of the injuries at issue.";

  const body: (Paragraph | Table)[] = [];

  // Letterhead + title
  body.push(new Paragraph({ children: [new TextRun({ text: c.firm.letterhead || c.firm.name, bold: true, size: 20 })], alignment: AlignmentType.CENTER }));
  body.push(new Paragraph({ text: "LIFE CARE PLAN", heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }));
  body.push(new Paragraph({ children: [new TextRun({ text: `${c.clientName} · ${c.caseNumber}`, italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 240 } }));

  // Executive summary
  body.push(h("Executive Summary", HeadingLevel.HEADING_1));
  body.push(p(framing));
  body.push(p(`This plan identifies ${items.length} future care recommendations with a total undiscounted lifetime cost of ${money(totalLifetime)} and a present value of ${money(totalPresentValue)} (discount rate ${(a.discountRate * 100).toFixed(1)}%, medical inflation ${(a.medicalInflation * 100).toFixed(1)}%).`));

  // Qualifications placeholder
  body.push(h("Qualifications"));
  body.push(p("[Life care planner qualifications, certifications (CLCP), and CV to be inserted here.]", { italics: true }));

  // Records reviewed
  body.push(h("Records Reviewed"));
  if (c.documents.length === 0) body.push(p("No records ingested at time of report.", { italics: true }));
  for (const d of c.documents) body.push(p(`• ${d.filename} — ${d.type.replace(/_/g, " ").toLowerCase()} (${d.pageCount} pp)`));

  // Methodology
  body.push(h("Methodology"));
  body.push(p("Future care recommendations were developed from the medical records, the treating providers' documentation, and specialty-specific standards of care. Each item is classified by medical probability (probable, possible, speculative) and tied to supporting records. Costs reflect Medicare/UCR/cash-pay benchmarks with geographic adjustment. Recommendations designated as requiring physician confirmation are noted and reserved for treating-physician sign-off."));

  // Injury / current condition / causation
  body.push(h("Injury Summary & Causation"));
  body.push(p(`Mechanism of injury: ${c.mechanism || "—"}. Date of injury: ${fmtDate(c.dateOfInjury)}. Jurisdiction: ${c.jurisdiction || "—"}.`));
  for (const cond of c.conditions) {
    body.push(p(`${cond.name} — ${cond.relatedness.replace(/_/g, " ").toLowerCase()} (confidence ${cond.confidence}%). ${cond.reasoning ?? ""}`));
  }

  // Chronology table
  body.push(h("Medical Chronology"));
  if (c.chronologyEvents.length) {
    body.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          row([cell("Date", { bold: true, width: 15 }), cell("Provider", { bold: true, width: 25 }), cell("Event", { bold: true, width: 45 }), cell("Rel.", { bold: true, width: 15 })]),
          ...c.chronologyEvents.map((e) => row([cell(fmtDate(e.eventDate)), cell(e.provider || "—"), cell(e.summary), cell(String(e.relevanceScore))])),
        ],
      }),
    );
  }

  // Future care + cost table
  body.push(h("Future Care Recommendations & Costs"));
  body.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        row([
          cell("Service", { bold: true, width: 30 }),
          cell("Prob.", { bold: true, width: 12 }),
          cell("Freq/yr", { bold: true, width: 10 }),
          cell("Annual", { bold: true, width: 16 }),
          cell("Lifetime", { bold: true, width: 16 }),
          cell("Present Value", { bold: true, width: 16 }),
        ]),
        ...items.map((i) =>
          row([
            cell(i.service),
            cell(i.probability.toLowerCase()),
            cell(String(i.frequencyPerYear)),
            cell(money(i.annualCost)),
            cell(money(i.lifetimeCost)),
            cell(money(i.presentValue)),
          ]),
        ),
        row([cell("TOTAL", { bold: true }), cell(""), cell(""), cell(""), cell(money(totalLifetime), { bold: true }), cell(money(totalPresentValue), { bold: true })]),
      ],
    }),
  );

  // Assumptions
  body.push(h("Assumptions & Present Value"));
  body.push(p(`Life expectancy: ${a.lifeExpectancyYears.toFixed(1)} remaining years. Discount rate: ${(a.discountRate * 100).toFixed(1)}%. Medical inflation: ${(a.medicalInflation * 100).toFixed(1)}%. Geographic factor: ${a.geographicFactor.toFixed(2)}.`));

  // Appendices — order depends on template
  const defenseFindings = c.reviewFindings.filter((f) => f.kind === "DEFENSE");
  const completeness = c.reviewFindings.filter((f) => f.kind === "COMPLETENESS");
  if (defenseFindings.length) {
    body.push(h("Appendix: Defense Vulnerability Review"));
    for (const f of defenseFindings) body.push(p(`[${f.vulnerability}] ${f.category}: ${f.description}`));
  }
  if (template === "PLAINTIFF" && completeness.length) {
    body.push(h("Appendix: Completeness Review"));
    for (const f of completeness) body.push(p(`[${f.vulnerability}] ${f.category}: ${f.description}`));
  }

  // Physician appendix
  body.push(h("Appendix: Physician Review"));
  const pending = items.filter((i) => i.physicianStatus === "PENDING");
  body.push(p(`${items.length - pending.length} of ${items.length} items have physician sign-off. Items pending confirmation are reserved for treating-physician review.`));

  body.push(new Paragraph({ children: [new TextRun({ text: "Every recommendation herein is subject to the reviewing physician's and certified life care planner's final professional judgment.", italics: true, size: 16 })], spacing: { before: 240 }, border: { top: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 6 } } }));

  const doc = new Document({ sections: [{ children: body }] });
  const buffer = await Packer.toBuffer(doc);
  return { buffer, totalLifetime, totalPresentValue, itemCount: items.length };
}

export async function buildCostCsv(caseId: string): Promise<string> {
  const items = await prisma.futureCareItem.findMany({ where: { caseId }, orderBy: { presentValue: "desc" } });
  const header = ["Category", "Service", "Specialty", "CPT", "Probability", "Freq/yr", "Duration(yrs)", "UnitCost", "AnnualCost", "LifetimeCost", "PresentValue", "Low", "High", "PricingSource", "PhysicianStatus"];
  const rows = items.map((i) =>
    [
      i.category,
      i.service,
      i.specialty ?? "",
      i.cptCode ?? "",
      i.probability,
      i.frequencyPerYear,
      i.isLifetime ? "lifetime" : (i.durationYears ?? ""),
      i.unitCost,
      i.annualCost,
      i.lifetimeCost,
      i.presentValue,
      i.lowCost,
      i.highCost,
      i.pricingSource ?? "",
      i.physicianStatus,
    ]
      .map((v) => {
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}
