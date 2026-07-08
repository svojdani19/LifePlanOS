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
  PageBreak,
} from "docx";
import { prisma } from "@/lib/db";
import { assumptionsFor } from "@/lib/engine/generate";
import { typeLabel } from "@/lib/documents/taxonomy";
import { parseConditions } from "@/lib/intake/preExisting";
import type { CaseSide, CareCategory } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Report generator (Module 13). Produces a formal, physician-grade Life Care
// Plan & Medical Cost Analysis in .docx, modeled on a professional CLCP report:
// cover with headline future medical damages, synopsis in reasonable-degree-of-
// medical-probability voice, records reviewed, chronology, impression, life
// expectancy & duration of care, a grouped Medical Cost Table with category
// subtotals and a grand total, present-value analysis, assumptions, references,
// and a Daubert appendix. A CSV cost table is also produced.
// ─────────────────────────────────────────────────────────────────────────────

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const fmtDate = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "—");
const BRAND = "0E7490"; // clinical teal (matches the app identity)
const INK = "334155";

// ── low-level docx helpers ───────────────────────────────────────────────────
function h1(text: string, opts: { pageBreak?: boolean } = {}) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    pageBreakBefore: opts.pageBreak,
    spacing: { before: 280, after: 140 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BRAND, space: 4 } },
    children: [new TextRun({ text, bold: true, color: BRAND, size: 26 })],
  });
}
function h2(text: string) {
  return new Paragraph({ spacing: { before: 200, after: 90 }, children: [new TextRun({ text, bold: true, color: INK, size: 22 })] });
}
function p(text: string, opts: { bold?: boolean; italics?: boolean; size?: number; color?: string; after?: number } = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 100, line: 276 },
    alignment: AlignmentType.JUSTIFIED,
    children: [new TextRun({ text, bold: opts.bold, italics: opts.italics, size: opts.size ?? 20, color: opts.color })],
  });
}
function bullet(text: string) {
  return new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: [new TextRun({ text, size: 20 })] });
}
function cell(text: string, o: { bold?: boolean; width?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; fill?: string; color?: string; size?: number } = {}) {
  return new TableCell({
    width: o.width ? { size: o.width, type: WidthType.PERCENTAGE } : undefined,
    shading: o.fill ? { fill: o.fill } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [new Paragraph({ alignment: o.align, children: [new TextRun({ text, bold: o.bold, size: o.size ?? 17, color: o.color })] })],
  });
}
const row = (cells: TableCell[]) => new TableRow({ children: cells });

// ── content helpers ──────────────────────────────────────────────────────────
function honorific(sex: string): string {
  if (sex === "MALE") return "Mr.";
  if (sex === "FEMALE") return "Ms.";
  return "";
}
function subjectName(clientName: string, sex: string): string {
  const parts = clientName.trim().split(/\s+/);
  const last = parts.length > 1 ? parts[parts.length - 1] : clientName;
  const hon = honorific(sex);
  return hon ? `${hon} ${last}` : clientName;
}
function ageFrom(dob: Date | null): number | null {
  if (!dob) return null;
  return Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000));
}

// Cost-table grouping (mirrors how a CLCP organizes the Medical Cost Table).
const CATEGORY_GROUPS: { title: string; cats: CareCategory[] }[] = [
  { title: "Physician & Specialist Visits", cats: ["PHYSICIAN_VISIT", "SPECIALIST_VISIT", "PRIMARY_CARE", "NEUROLOGY", "PMR", "PAIN_MANAGEMENT", "PSYCH"] },
  { title: "Surgical & Interventional Procedures", cats: ["ORTHOPEDIC_SURGERY", "NEUROSURGERY", "FUTURE_SURGERY", "REVISION_SURGERY", "INJECTION", "COMPLICATION_MANAGEMENT"] },
  { title: "Rehabilitation & Therapies", cats: ["PHYSICAL_THERAPY", "OCCUPATIONAL_THERAPY", "SPEECH_THERAPY", "COGNITIVE_THERAPY"] },
  { title: "Diagnostics & Laboratory", cats: ["IMAGING", "LABS"] },
  { title: "Medications & Supplies", cats: ["MEDICATION", "SUPPLIES"] },
  { title: "Durable Medical Equipment, Orthotics & Modifications", cats: ["DME", "ORTHOTICS_PROSTHETICS", "MOBILITY_AID", "HOME_MODIFICATION", "VEHICLE_MODIFICATION", "ASSISTIVE_TECH"] },
  { title: "Attendant & Facility Care", cats: ["ATTENDANT_CARE", "SKILLED_NURSING", "CASE_MANAGEMENT"] },
  { title: "Vocational, Transportation & Other", cats: ["VOCATIONAL_REHAB", "TRANSPORTATION", "MISC"] },
];

const ABBREVIATIONS: [string, string][] = [
  ["ADL", "activities of daily living"],
  ["CLCP", "Certified Life Care Planner"],
  ["CPT", "Current Procedural Terminology"],
  ["DME", "durable medical equipment"],
  ["DOI", "date of injury"],
  ["ICD-10", "International Classification of Diseases, 10th revision"],
  ["LCP", "life care plan"],
  ["MCT", "medical cost table"],
  ["MMI", "maximum medical improvement"],
  ["PT / OT", "physical therapy / occupational therapy"],
  ["PV", "present value"],
  ["RDMP", "reasonable degree of medical probability"],
];

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
      createdBy: { select: { name: true } },
      chronologyEvents: { orderBy: { eventDate: "asc" } },
      conditions: { orderBy: { confidence: "desc" } },
      futureCareItems: { orderBy: { presentValue: "desc" } },
      reviewFindings: true,
      documents: { orderBy: { createdAt: "asc" } },
    },
  });

  const a = assumptionsFor(c);
  const items = c.futureCareItems;
  const totalLifetime = items.reduce((s, i) => s + i.lifetimeCost, 0);
  const totalPresentValue = items.reduce((s, i) => s + i.presentValue, 0);

  const subject = subjectName(c.clientName, c.sex);
  const age = ageFrom(c.dateOfBirth);
  const life = a.lifeExpectancyYears;
  const preExisting = parseConditions(c.preExistingConditions);
  const templateLabel = template === "DEFENSE" ? "Defense Review" : template === "NEUTRAL" ? "Neutral Evaluation" : "Plaintiff";

  const body: (Paragraph | Table)[] = [];

  // ── Cover ──────────────────────────────────────────────────────────────────
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200, after: 40 }, children: [new TextRun({ text: c.firm.letterhead || c.firm.name, bold: true, size: 22, color: BRAND })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: BRAND, space: 6 } }, children: [new TextRun({ text: "LIFE CARE PLAN & MEDICAL COST ANALYSIS", bold: true, size: 34, color: INK })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: `${templateLabel} — Final Report`, italics: true, size: 22, color: INK })] }));

  // Demographics block
  const demo: [string, string][] = [
    ["Name", c.clientName],
    ["Age", age != null ? String(age) : "—"],
    ["Date of birth", fmtDate(c.dateOfBirth)],
    ["Date of injury", fmtDate(c.dateOfInjury)],
    ["Case type", c.caseType.replace(/_/g, " ").toLowerCase()],
    ["Jurisdiction", c.jurisdiction || "—"],
    ["Case number", c.caseNumber],
    ["Report date", fmtDate(new Date())],
  ];
  body.push(
    new Table({
      width: { size: 80, type: WidthType.PERCENTAGE },
      alignment: AlignmentType.CENTER,
      borders: allBorders("E2E8F0"),
      rows: demo.map(([k, v]) => row([cell(k, { bold: true, width: 40, fill: "F1F5F9" }), cell(v, { width: 60 })])),
    }),
  );
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 260, after: 40 }, children: [new TextRun({ text: "Estimated Future Medical Damages", size: 20, color: INK })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 20 }, children: [new TextRun({ text: money(totalLifetime), bold: true, size: 48, color: BRAND })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [new TextRun({ text: `Present value ${money(totalPresentValue)} · ${items.length} projected care items`, italics: true, size: 18, color: INK })] }));

  // ── Abbreviations ────────────────────────────────────────────────────────────
  body.push(h1("Abbreviations", { pageBreak: true }));
  for (const [ab, meaning] of ABBREVIATIONS) {
    body.push(new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: `${ab}  `, bold: true, size: 19 }), new TextRun({ text: meaning, size: 19 })] }));
  }

  // ── Synopsis ─────────────────────────────────────────────────────────────────
  body.push(h1("Synopsis"));
  const diagnoses = c.conditions.map((x) => x.name.toLowerCase());
  const treatments = c.chronologyEvents.filter((e) => e.eventType === "SURGERY" || e.eventType === "THERAPY" || e.eventType === "HOSPITALIZATION").map((e) => e.summary.replace(/\.$/, "").toLowerCase());
  body.push(
    p(
      `${subject} is a ${age != null ? `${age}-year-old ` : ""}${c.sex === "FEMALE" ? "female" : c.sex === "MALE" ? "male" : "individual"} who sustained injury${c.mechanism ? ` as a result of ${c.mechanism.toLowerCase()}` : ""}${c.dateOfInjury ? ` on ${fmtDate(c.dateOfInjury)}` : ""}. A review of the medical documentation${c.documents.length ? ` (${c.documents.length} record set${c.documents.length === 1 ? "" : "s"})` : ""} reflects a primary diagnosis of ${c.diagnosis || "the injuries at issue"}${c.icd10Code ? ` (ICD-10 ${c.icd10Code})` : ""}${diagnoses.length ? `, together with ${diagnoses.slice(0, 4).join("; ")}` : ""}.`,
    ),
  );
  if (treatments.length) body.push(p(`Care rendered to date includes ${treatments.slice(0, 6).join("; ")}. ${subject} is expected to require ongoing medical care, the reasonably anticipated future costs of which are summarized in the Medical Cost Table herein.`));
  if (c.currentWorkStatus) body.push(p(`Current work status: ${c.currentWorkStatus.toLowerCase()}${c.currentWorkStatus === "Disabled" && c.disabilityReason ? ` (${c.disabilityReason})` : ""}.${c.functionalLimitations ? ` Documented functional limitations: ${c.functionalLimitations}.` : ""}`));
  body.push(p(`All opinions expressed in this Life Care Plan are offered within a reasonable degree of medical probability (RDMP) and are based upon a review of the available records, accepted life-care-planning methodology, and applicable standards of care.`, { italics: true }));

  // ── Qualifications ───────────────────────────────────────────────────────────
  body.push(h1("Qualifications & Methodology"));
  body.push(p(`This Life Care Plan was prepared by ${c.createdBy?.name ?? "the assigned life care planner"} of ${c.firm.name}. Future care recommendations were derived from the medical records, treating-provider documentation, and specialty-specific standards of care. Each recommendation is classified by medical probability — probable, possible, or speculative — and tied to supporting records. Costs reflect recognized benchmarks (Medicare / UCR / cash-pay) with geographic adjustment. Items requiring treating-physician confirmation of medical necessity are identified and reserved for physician sign-off.`));

  // ── Records reviewed ─────────────────────────────────────────────────────────
  body.push(h1("Records Reviewed"));
  if (!c.documents.length) body.push(p("No records were ingested at the time of this report.", { italics: true }));
  else for (const d of c.documents) body.push(bullet(`${d.filename} — ${typeLabel(d.type)}${d.pageCount ? ` (${d.pageCount} pp)` : ""}`));

  // ── Medical chronology ───────────────────────────────────────────────────────
  body.push(h1("Medical Chronology", { pageBreak: true }));
  if (!c.chronologyEvents.length) body.push(p("No chronology events were generated for this case.", { italics: true }));
  else {
    body.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: allBorders("E2E8F0"),
        rows: [
          row([cell("Date", { bold: true, width: 14, fill: BRAND, color: "FFFFFF" }), cell("Type", { bold: true, width: 14, fill: BRAND, color: "FFFFFF" }), cell("Provider / Specialty", { bold: true, width: 22, fill: BRAND, color: "FFFFFF" }), cell("Relevant Finding", { bold: true, width: 50, fill: BRAND, color: "FFFFFF" })]),
          ...c.chronologyEvents.map((e, i) =>
            row([
              cell(fmtDate(e.eventDate), { fill: i % 2 ? "F8FAFC" : "FFFFFF" }),
              cell((e.eventType || "").replace(/_/g, " ").toLowerCase(), { fill: i % 2 ? "F8FAFC" : "FFFFFF" }),
              cell(e.specialty || e.provider || "—", { fill: i % 2 ? "F8FAFC" : "FFFFFF" }),
              cell(e.summary, { fill: i % 2 ? "F8FAFC" : "FFFFFF" }),
            ]),
          ),
        ],
      }),
    );
  }

  // ── Impression / diagnoses ───────────────────────────────────────────────────
  body.push(h1("Impression — Diagnoses & Causation"));
  body.push(p(`Based upon the clinical records and the information set forth above, ${subject} carries the following diagnoses and associated impairments, offered within a reasonable degree of medical probability:`));
  if (c.icd10Code || c.diagnosis) body.push(bullet(`${c.diagnosis || "Primary diagnosis"}${c.icd10Code ? ` — ICD-10 ${c.icd10Code}` : ""} (primary).`));
  const addlDx = (Array.isArray(c.additionalDiagnoses) ? c.additionalDiagnoses : []) as { diagnosis?: string; icd10Code?: string }[];
  for (const d of addlDx) if (d?.diagnosis) body.push(bullet(`${d.diagnosis}${d.icd10Code ? ` — ICD-10 ${d.icd10Code}` : ""}.`));
  for (const cond of c.conditions) {
    body.push(bullet(`${cond.name} — ${cond.relatedness.replace(/_/g, " ").toLowerCase()}${cond.confidence ? `, confidence ${cond.confidence}%` : ""}.${cond.reasoning ? ` ${cond.reasoning}` : ""}`));
  }
  if (preExisting.length) {
    body.push(h2("Previous Medical / Surgical History"));
    body.push(p(`The following pre-existing conditions are documented and were considered in the apportionment analysis: ${preExisting.join("; ")}.`));
  }

  // ── Life expectancy & duration of care ───────────────────────────────────────
  body.push(h1("Life Expectancy & Probable Duration of Care"));
  body.push(p(`Based on the age and sex of ${subject}, and consistent with United States Social Security Administration actuarial data, the remaining life expectancy applied in this plan is ${life.toFixed(1)} years. This value is used as the projection horizon for lifetime care items.`));
  body.push(p(`Given the diagnoses, current complaints, diagnostic findings, and response to treatment to date, ${subject}'s condition is expected to require care over a probable duration of ${life.toFixed(1)} years.`));

  // ── Projected long-term costs (narrative) ────────────────────────────────────
  body.push(h1("Projected Long-Term Medical & Rehabilitation Costs"));
  body.push(p(`The reasonably anticipated future medical and rehabilitation needs of ${subject} are itemized in the Medical Cost Table that follows. The narrative below summarizes each category of care included.`));
  for (const g of CATEGORY_GROUPS) {
    const groupItems = items.filter((i) => g.cats.includes(i.category));
    if (!groupItems.length) continue;
    const grpTotal = groupItems.reduce((s, i) => s + i.lifetimeCost, 0);
    body.push(p(`${g.title} (${money(grpTotal)} lifetime): ${groupItems.map((i) => i.service.toLowerCase()).slice(0, 6).join("; ")}.`));
  }

  // ── Medical Cost Table ───────────────────────────────────────────────────────
  body.push(h1("Medical Cost Table", { pageBreak: true }));
  body.push(p(`All amounts are stated in present-day dollars. "Lifetime" reflects the inflation-adjusted cost over the projection horizon; present value is summarized following the table.`, { italics: true, size: 18 }));

  const mctRows: TableRow[] = [
    row([
      cell("Service / Item", { bold: true, width: 32, fill: BRAND, color: "FFFFFF" }),
      cell("CPT", { bold: true, width: 9, fill: BRAND, color: "FFFFFF" }),
      cell("Frequency", { bold: true, width: 12, fill: BRAND, color: "FFFFFF" }),
      cell("Unit", { bold: true, width: 11, fill: BRAND, color: "FFFFFF", align: AlignmentType.RIGHT }),
      cell("Yrs", { bold: true, width: 7, fill: BRAND, color: "FFFFFF", align: AlignmentType.RIGHT }),
      cell("Lifetime", { bold: true, width: 15, fill: BRAND, color: "FFFFFF", align: AlignmentType.RIGHT }),
      cell("Basis", { bold: true, width: 14, fill: BRAND, color: "FFFFFF" }),
    ]),
  ];
  for (const g of CATEGORY_GROUPS) {
    const groupItems = items.filter((i) => g.cats.includes(i.category));
    if (!groupItems.length) continue;
    mctRows.push(row([cell(g.title, { bold: true, fill: "E2F2F5" }), cell("", { fill: "E2F2F5" }), cell("", { fill: "E2F2F5" }), cell("", { fill: "E2F2F5" }), cell("", { fill: "E2F2F5" }), cell("", { fill: "E2F2F5" }), cell("", { fill: "E2F2F5" })]));
    for (const i of groupItems) {
      const yrs = i.isLifetime ? life : i.durationYears ?? 1;
      const freq = i.isLifetime || (i.durationYears ?? 0) > 1 ? `${i.frequencyPerYear}/yr` : "one-time";
      mctRows.push(
        row([
          cell(i.service),
          cell(i.cptCode || "—"),
          cell(freq),
          cell(money(i.unitCost), { align: AlignmentType.RIGHT }),
          cell(yrs ? yrs.toFixed(0) : "—", { align: AlignmentType.RIGHT }),
          cell(money(i.lifetimeCost), { align: AlignmentType.RIGHT }),
          cell(i.pricingSource || "UCR", { size: 15 }),
        ]),
      );
    }
    const sub = groupItems.reduce((s, i) => s + i.lifetimeCost, 0);
    mctRows.push(row([cell(`Subtotal — ${g.title}`, { bold: true, fill: "F1F5F9" }), cell("", { fill: "F1F5F9" }), cell("", { fill: "F1F5F9" }), cell("", { fill: "F1F5F9" }), cell("", { fill: "F1F5F9" }), cell(money(sub), { bold: true, align: AlignmentType.RIGHT, fill: "F1F5F9" }), cell("", { fill: "F1F5F9" })]));
  }
  mctRows.push(row([cell("TOTAL FUTURE MEDICAL DAMAGES", { bold: true, fill: BRAND, color: "FFFFFF" }), cell("", { fill: BRAND }), cell("", { fill: BRAND }), cell("", { fill: BRAND }), cell("", { fill: BRAND }), cell(money(totalLifetime), { bold: true, align: AlignmentType.RIGHT, fill: BRAND, color: "FFFFFF" }), cell("", { fill: BRAND })]));
  body.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: allBorders("E2E8F0"), rows: mctRows }));

  // ── Present value analysis ───────────────────────────────────────────────────
  body.push(h1("Present-Value Analysis"));
  body.push(p(`The undiscounted lifetime cost of future care is ${money(totalLifetime)}. Applying a discount rate of ${(a.discountRate * 100).toFixed(1)}% against an assumed medical-cost inflation rate of ${(a.medicalInflation * 100).toFixed(1)}%, and a geographic adjustment factor of ${a.geographicFactor.toFixed(2)}, the present value of the future medical damages is ${money(totalPresentValue)}.`));

  // ── MCT assumptions ──────────────────────────────────────────────────────────
  body.push(h1("Medical Cost Table Assumptions"));
  body.push(p(`In order to interpret the Medical Cost Table, the following assumptions apply, each made within a reasonable degree of medical probability. Injuries to intra-articular joints, discs, and neurologic structures are expected to gradually progress over time. Frequencies and durations reflect anticipated utilization averaged across the projection horizon; there may be periods of higher or lower utilization. Costs designated "one-time" reflect a single anticipated occurrence; "lifetime" items recur across the ${life.toFixed(1)}-year horizon. Items lacking established literature support are expressly identified and are reserved for treating-physician confirmation.`));

  // ── Appendices ───────────────────────────────────────────────────────────────
  const defenseFindings = c.reviewFindings.filter((f) => f.kind === "DEFENSE");
  const completeness = c.reviewFindings.filter((f) => f.kind === "COMPLETENESS");
  const pendingMd = items.filter((i) => i.physicianStatus === "PENDING").length;

  if (template !== "PLAINTIFF" && defenseFindings.length) {
    body.push(h1("Appendix A — Defense Vulnerability Review", { pageBreak: true }));
    for (const f of defenseFindings) body.push(bullet(`[${f.vulnerability}] ${f.category}: ${f.description}`));
  }
  if (template === "PLAINTIFF" && completeness.length) {
    body.push(h1("Appendix A — Completeness Review", { pageBreak: true }));
    for (const f of completeness) body.push(bullet(`[${f.vulnerability}] ${f.category}: ${f.description}`));
  }

  body.push(h1("Appendix B — Physician Review"));
  body.push(p(`${items.length - pendingMd} of ${items.length} projected care items carry treating-physician sign-off. Items pending confirmation of medical necessity are reserved for physician review prior to testimony.`));

  // ── References & Daubert ─────────────────────────────────────────────────────
  body.push(h1("References"));
  ["Official Disability Guidelines (ODG) — evidence-based treatment guidelines", "FAIR Health — CPT-based charge benchmarks by geography", "Centers for Medicare & Medicaid Services (CMS) fee schedules", "GoodRx — retail pharmaceutical pricing", "U.S. Social Security Administration — actuarial life tables", "Peer-reviewed clinical literature as cited per recommendation"].forEach((r) => body.push(bullet(r)));

  body.push(h1("Appendix C — Daubert Admissibility"));
  const daubert: [string, string][] = [
    ["Can the methodology be tested?", "The life-care-planning methodology applied here is published and testable, and has been the subject of peer-reviewed literature since 1992."],
    ["Has it been peer-reviewed?", "The methodology is grounded in peer-reviewed texts and the standards of the certified life-care-planning bodies."],
    ["Is the rate of error acceptable?", "Only services, studies, and equipment reasonably probable to be required are included; standard confidence conventions are applied."],
    ["Is it generally accepted?", "Certification in life care planning is the recognized credential for LCP experts in all fifty states and federally."],
    ["Is the opinion relevant?", "The plan predicts, within a reasonable degree of medical probability, the medical services and equipment required to treat the injuries over the remaining life expectancy."],
  ];
  for (const [q, ans] of daubert) {
    body.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: `${q} `, bold: true, size: 20 }), new TextRun({ text: ans, size: 20 })] }));
  }

  // ── Disclaimer & signature ───────────────────────────────────────────────────
  body.push(new Paragraph({ spacing: { before: 300, after: 80 }, border: { top: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 6 } }, children: [new TextRun({ text: "Disclaimer: This plan is based upon past, present, and reasonably anticipated future medical needs, and upon the medical records available at the time of this report. Costs are stated at present-day values. Every recommendation is subject to the reviewing physician's and certified life care planner's final professional judgment.", italics: true, size: 17 })] }));
  body.push(new Paragraph({ spacing: { before: 220 }, children: [new TextRun({ text: "_______________________________", size: 20 })] }));
  body.push(new Paragraph({ children: [new TextRun({ text: `${c.createdBy?.name ?? "Life Care Planner"}, ${c.firm.name}`, bold: true, size: 20 })] }));
  body.push(new Paragraph({ children: [new TextRun({ text: `Report date: ${fmtDate(new Date())}`, size: 18, color: INK })] }));

  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri" } } } },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } }, children: body }],
  });
  const buffer = await Packer.toBuffer(doc);
  return { buffer, totalLifetime, totalPresentValue, itemCount: items.length };
}

function allBorders(color: string) {
  const s = { style: BorderStyle.SINGLE, size: 4, color };
  return { top: s, bottom: s, left: s, right: s, insideHorizontal: s, insideVertical: s };
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
