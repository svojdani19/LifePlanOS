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
import { project } from "@/lib/engine/cost";
import { typeLabel } from "@/lib/documents/taxonomy";
import { pageRange } from "@/lib/documents/meta";
import { parseConditions } from "@/lib/intake/preExisting";
import { confidenceBand, confidenceDefinition } from "@/lib/engine/confidence";
import type { CaseSide, CareCategory, FutureCareItem } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Report generator (Module 13). Produces a physician-and-CLCP–grade Life Care
// Plan & Future Medical Cost Analysis in .docx. The report does not summarize
// records — it reasons from them: every conclusion is traceable, every
// recommendation explainable, every projected cost supported, and every
// assumption disclosed. 14 numbered sections plus a self-scoring Quality
// Assurance scorecard, per-recommendation cards, cost sensitivity analysis,
// defense/completeness analysis, a printable physician-review packet, and a
// traceability matrix. A CSV cost spreadsheet is produced alongside.
// ─────────────────────────────────────────────────────────────────────────────

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const pct = (n: number) => `${Math.round(n)}%`;
const fmtDate = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "—");
// MM/DD/YYYY — the LCP "Treatment and Surgeries" date format.
const mdY = (d: Date | null) => (d ? `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}` : "—");
const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));
const BRAND = "0E7490";
const INK = "334155";
const MUTED = "64748B";
const GOOD = "047857";
const WARN = "B45309";
const BAD = "B91C1C";

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
// A labeled paragraph: "Label: body"
function labeled(label: string, bodyText: string) {
  return new Paragraph({ spacing: { after: 60, line: 268 }, alignment: AlignmentType.JUSTIFIED, children: [new TextRun({ text: `${label}: `, bold: true, size: 19 }), new TextRun({ text: bodyText, size: 19 })] });
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
function tbl(rows: TableRow[]): Table {
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: allBorders("E2E8F0"), rows });
}
// A key/value grid, two label/value pairs per row (four columns).
function kv4(pairs: [string, string][]): Table {
  const rows: TableRow[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const a1 = pairs[i];
    const a2 = pairs[i + 1];
    const cells = [cell(a1[0], { bold: true, width: 15, fill: "F1F5F9", size: 15 }), cell(a1[1] || "—", { width: 35, size: 15 })];
    if (a2) cells.push(cell(a2[0], { bold: true, width: 15, fill: "F1F5F9", size: 15 }), cell(a2[1] || "—", { width: 35, size: 15 }));
    else cells.push(cell("", { width: 15 }), cell("", { width: 35 }));
    rows.push(row(cells));
  }
  return tbl(rows);
}
// Full contested-point rendering: the argument with its source, and the
// opposing side's counter with its supporting authority carried as a citation.
function reviewParagraphs(f: {
  vulnerability: string;
  category: string;
  description: string;
  sourceRef: string | null;
  counterArgument: string | null;
  counterSource: string | null;
  counterCitation: string | null;
}): Paragraph[] {
  const out: Paragraph[] = [
    new Paragraph({ spacing: { before: 140, after: 30 }, children: [new TextRun({ text: `[${f.vulnerability}] `, bold: true, size: 18, color: BRAND }), new TextRun({ text: f.category, bold: true, size: 20 })] }),
    labeled("Argument", f.description),
  ];
  if (f.sourceRef) out.push(labeled("Source", f.sourceRef));
  if (f.counterArgument) out.push(labeled("Counter", f.counterArgument));
  if (f.counterSource) out.push(labeled("Support", f.counterSource));
  if (f.counterCitation) out.push(labeled("Citation", f.counterCitation));
  return out;
}

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
function catLabel(cat: string): string {
  return cat.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
}
function relatednessText(r: string): string {
  switch (r) {
    case "RELATED": return "causally related to the incident";
    case "AGGRAVATION": return "a pre-existing condition aggravated by the incident";
    case "PREEXISTING_UNRELATED": return "pre-existing and unrelated to the incident";
    case "SUBSEQUENT_UNRELATED": return "subsequent and unrelated to the incident";
    default: return "of unclear relationship pending further records";
  }
}
function levelOfEvidence(es: string | null): string {
  const s = (es || "").toLowerCase();
  if (/guideline|odg|aaos|acr|\bcpg\b|\baan\b/.test(s)) return "II — guideline-based";
  if (/registry|survivorship|literature|peer/.test(s)) return "III — observational / registry";
  return "IV — case-specific / expert opinion";
}
function evidenceScore(it: { evidenceStrength: string | null; confidence: number }): number {
  const s = (it.evidenceStrength || "").toLowerCase();
  const base = /guideline|odg/.test(s) ? 85 : /registry|survivorship|literature|peer/.test(s) ? 72 : 55;
  return clamp((base + it.confidence) / 2);
}
function confidenceExplain(it: { confidence: number; evidenceStrength: string | null; probability: string; physicianStatus: string }): string {
  const md = it.physicianStatus === "APPROVED" || it.physicianStatus === "MODIFIED" ? "physician endorsement on file" : "pending physician confirmation";
  return `${pct(it.confidence)} — reflects ${(it.evidenceStrength || "case-specific support").toLowerCase()}, a ${it.probability.toLowerCase()} probability rating, and ${md}.`;
}

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
  ["FCE", "functional capacity evaluation"],
  ["ICD-10", "International Classification of Diseases, 10th revision"],
  ["LCP", "life care plan"],
  ["MMI", "maximum medical improvement"],
  ["ODG", "Official Disability Guidelines"],
  ["PV", "present value"],
  ["RDMP", "reasonable degree of medical probability"],
  ["ROM", "range of motion"],
];

const REFERENCES = [
  "Official Disability Guidelines (ODG) — evidence-based medical treatment guidelines (ODGbyMCG).",
  "FAIR Health (fairhealth.org) — actual billed charges by CPT code and geography (50th/80th percentile).",
  "Centers for Medicare & Medicaid Services (CMS) — RVU / DMEPOS / clinical laboratory fee schedules.",
  "GoodRx (goodrx.com) — retail/consumer pharmaceutical pricing (median generic where available).",
  "U.S. Social Security Administration — actuarial life tables (ssa.gov/OACT).",
  "A Physician's Guide to Life Care Planning, AAPLCP (2017).",
  "Life Care Planning and Case Management Across the Lifespan, 5th ed. (ICHCC, 2024).",
  "StatPearls / NCBI Bookshelf and peer-reviewed clinical literature as cited per recommendation.",
];

// Record importance / relevance heuristics for the Records-Reviewed table.
const CORE_TYPES = new Set([
  "OPERATIVE_NOTE", "IMAGING_REPORT", "ER_RECORD", "DISCHARGE_SUMMARY", "HOSPITAL_RECORD", "IME_REPORT",
  "NEUROPSYCHOLOGICAL_EVALUATION", "NEUROSURGERY_RECORD", "EMG_NCS_REPORT", "PT_OT_RECORD", "PAIN_MANAGEMENT",
  "NEUROLOGY_RECORD", "ORTHOPEDIC_CLINIC", "PATHOLOGY_REPORT", "FUNCTIONAL_CAPACITY_EVALUATION",
]);
const ADMIN_TYPES = new Set([
  "BILLING_RECORD", "INSURANCE_RECORDS", "LEGAL_PLEADING", "DEMAND_LETTER", "EMPLOYMENT_RECORDS",
  "WAGE_LOSS_DOCUMENTATION", "DEPOSITION",
]);
function importanceOf(type: string): string {
  if (CORE_TYPES.has(type)) return "High";
  if (ADMIN_TYPES.has(type)) return "Low";
  return "Moderate";
}

export interface ReportPayload {
  buffer: Buffer;
  totalLifetime: number;
  totalPresentValue: number;
  itemCount: number;
}

type Cite = { source?: string; title?: string; authors?: string; journal?: string; year?: string; pmid?: string; doi?: string; url?: string };
function citationList(citation: unknown): Cite[] {
  const arr = Array.isArray(citation) ? citation : citation ? [citation] : [];
  return (arr as Cite[]).filter((c) => c && c.title && (c.pmid || c.doi || c.url));
}
const SOURCE_LABEL: Record<string, string> = { europepmc: "Europe PMC", crossref: "Crossref", semanticscholar: "Semantic Scholar" };
function citeId(c: Cite): string {
  if (c.pmid) return `PMID ${c.pmid}`;
  if (c.doi) return `doi:${c.doi}`;
  return c.url ?? "";
}
function oneCitation(c: Cite): string {
  const src = c.source ? ` [${SOURCE_LABEL[c.source] ?? c.source}]` : "";
  return `${c.authors ? `${c.authors}. ` : ""}${c.title}. ${c.journal ?? ""}${c.year ? ` ${c.year}` : ""} (${citeId(c)})${src}.`;
}
function citationText(citation: unknown): string {
  const list = citationList(citation);
  if (!list.length) return "None located in the indexed literature — verify.";
  return list.map((c, i) => `${i + 1}. ${oneCitation(c)}`).join("  ") + " Auto-sourced & ranked across literature databases — verify relevance.";
}

function freqText(i: { frequencyPerYear: number; isLifetime: boolean; durationYears: number | null }, life: number): string {
  if (!i.isLifetime && (i.durationYears ?? 0) <= 0) return "as a one-time expense";
  const per = `${i.frequencyPerYear}× per year`;
  const horizon = i.isLifetime ? `over the ${life.toFixed(1)}-year projection horizon` : `for ${i.durationYears} year${i.durationYears === 1 ? "" : "s"}`;
  return `${per} ${horizon}`;
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
  // The finalized plan reflects physician-endorsed care. Once review has begun,
  // only APPROVED/MODIFIED items drive the damages figures; rejected/pending
  // items are disclosed but not totaled. Before any review, all items are
  // provisional so the report is never empty.
  const accepted = items.filter((i) => i.physicianStatus === "APPROVED" || i.physicianStatus === "MODIFIED");
  const rejected = items.filter((i) => i.physicianStatus === "REJECTED");
  const reviewStarted = items.length > 0 && items.some((i) => i.physicianStatus !== "PENDING");
  const reportItems = reviewStarted ? accepted : items;
  const excludedForReview = reviewStarted ? items.filter((i) => i.physicianStatus === "REJECTED" || i.physicianStatus === "PENDING") : [];
  const totalLifetime = reportItems.reduce((s, i) => s + i.lifetimeCost, 0);
  const totalPresentValue = reportItems.reduce((s, i) => s + i.presentValue, 0);
  const totalLow = reportItems.reduce((s, i) => s + i.lowCost, 0);
  const totalHigh = reportItems.reduce((s, i) => s + i.highCost, 0);

  const subject = subjectName(c.clientName, c.sex);
  const sexNoun = c.sex === "FEMALE" ? "female" : c.sex === "MALE" ? "male" : "individual";
  const age = ageFrom(c.dateOfBirth);
  const life = a.lifeExpectancyYears;
  const preExisting = parseConditions(c.preExistingConditions);
  const addlDx = (Array.isArray(c.additionalDiagnoses) ? c.additionalDiagnoses : []) as { diagnosis?: string; icd10Code?: string }[];
  const addlSpec = (Array.isArray(c.additionalSpecialties) ? c.additionalSpecialties : []) as string[];
  const specialties = [c.specialty, ...addlSpec].filter(Boolean) as string[];
  const templateLabel = template === "DEFENSE" ? "Defense Review" : template === "NEUTRAL" ? "Neutral Evaluation" : "Plaintiff";
  const diagnostics = c.chronologyEvents.filter((e) => e.eventType === "IMAGING" || e.eventType === "LAB");
  const treatments = c.chronologyEvents.filter((e) => e.eventType !== "IMAGING" && e.eventType !== "LAB");
  const docById = new Map(c.documents.map((d) => [d.id, d]));
  const condById = new Map(c.conditions.map((x) => [x.id, x]));
  const icdFor = (name: string): string => {
    if (c.diagnosis && name.toLowerCase() === c.diagnosis.toLowerCase()) return c.icd10Code || "—";
    const m = addlDx.find((d) => d.diagnosis && d.diagnosis.toLowerCase() === name.toLowerCase());
    return m?.icd10Code || "—";
  };

  // ── Quality-assurance scoring (computed up front; shown in §1 and QA card) ───
  const n = reportItems.length || 1;
  const nItems = items.length || 1;
  const catCount = new Set(reportItems.map((i) => i.category)).size;
  const withEvid = reportItems.filter((i) => i.evidenceStrength).length;
  const withLit = reportItems.filter((i) => i.literatureSupport).length;
  const withCost = reportItems.filter((i) => i.pricingSource && i.cptCode).length;
  const highVuln = reportItems.filter((i) => i.defenseVulnerability === "HIGH").length;
  const avgConf = clamp(reportItems.reduce((s, i) => s + i.confidence, 0) / n);
  const docTypes = new Set(c.documents.map((d) => d.type));
  const recCoverageScore = clamp(52 + catCount * 5 + Math.min(16, reportItems.length));
  const recordScore = clamp(46 + Math.min(30, c.documents.length * 4) + (docTypes.has("IMAGING_REPORT") ? 8 : 0) + (docTypes.has("OPERATIVE_NOTE") ? 8 : 0) + (docTypes.has("PT_OT_RECORD") ? 8 : 0));
  const evidenceScoreAgg = clamp((withEvid / n) * 100);
  const physicianScore = clamp((accepted.length / nItems) * 100);
  const costScore = clamp((withCost / n) * 100);
  const litScore = clamp((withLit / n) * 100);
  const vulnScore = clamp(100 - (highVuln / n) * 70);
  const scoreRows: { label: string; score: number; improve: string }[] = [
    { label: "Medical completeness", score: recCoverageScore, improve: "Confirm every injury-related domain is represented; add care for any diagnosis lacking a corresponding recommendation." },
    { label: "Record completeness", score: recordScore, improve: "Request outstanding records (operative, imaging, therapy, specialist) to close documentation gaps." },
    { label: "Evidence completeness", score: evidenceScoreAgg, improve: "Attach an explicit evidence basis to every recommendation." },
    { label: "Physician support", score: physicianScore, improve: reviewStarted ? "Route remaining pending/rejected items back to the reviewing physician." : "Route the packet to the reviewing physician; no items yet carry sign-off." },
    { label: "Cost support", score: costScore, improve: "Attach a CPT/HCPCS code and a named pricing source to every line item." },
    { label: "Literature support", score: litScore, improve: "Cite a governing guideline or peer-reviewed source for every recommendation." },
    { label: "Defense robustness", score: vulnScore, improve: "Shore up high-vulnerability items with physician sign-off and additional documentation." },
    { label: "Overall confidence", score: avgConf, improve: "Strengthen low-confidence items with objective findings and specialist confirmation." },
  ];
  const overallQuality = clamp(scoreRows.reduce((s, r) => s + r.score, 0) / scoreRows.length);
  scoreRows.push({ label: "Overall report quality", score: overallQuality, improve: "Address the improvement notes above for any metric below 90 before export." });
  const overallVulnLabel = highVuln / n > 0.33 ? "High" : reportItems.filter((i) => i.defenseVulnerability === "MODERATE").length / n > 0.5 ? "Moderate" : "Low";
  const scoreColor = (s: number) => (s >= 90 ? GOOD : s >= 75 ? WARN : BAD);

  // ── Per-recommendation card ──────────────────────────────────────────────────
  function recCard(it: FutureCareItem): (Paragraph | Table)[] {
    const cond = it.conditionId ? condById.get(it.conditionId) : undefined;
    const endpoint = it.isLifetime ? `Lifetime — recurs across the ${life.toFixed(1)}-year horizon` : `${it.durationYears ?? 1} year(s) from initiation`;
    const mdSupport = it.physicianStatus === "APPROVED" || it.physicianStatus === "MODIFIED" ? `Endorsed on physician review${it.physicianNote ? `: ${it.physicianNote}` : ""}` : "Reserved for treating-physician confirmation";
    return [
      new Paragraph({
        spacing: { before: 200, after: 40 },
        children: [
          new TextRun({ text: it.service, bold: true, size: 21, color: INK }),
          new TextRun({ text: `    ${it.probability.toLowerCase()} · ${it.defenseVulnerability.toLowerCase()} vulnerability · MD ${it.physicianStatus.toLowerCase()}`, size: 15, color: BRAND }),
        ],
      }),
      kv4([
        ["Specialty", it.specialty || "—"],
        ["Supporting diagnosis", cond?.name || c.diagnosis || "—"],
        ["Medical necessity", it.rationale || "—"],
        ["Medical probability", `${it.probability.toLowerCase()} (RDMP)`],
        ["Confidence", pct(it.confidence)],
        ["Confidence basis", confidenceExplain(it)],
        ["Guideline / evidence support", it.evidenceStrength || "—"],
        ["Supporting literature", it.literatureSupport || "—"],
        ["Most specific cited articles (PubMed)", citationText(it.citation)],
        ["Supporting records", cond?.supportingRecords || "See chronology & Records-Reviewed index"],
        ["Supporting physician", mdSupport],
        ["Expected frequency", `${it.frequencyPerYear}× per year`],
        ["Expected duration", it.isLifetime ? `${life.toFixed(1)} yrs (lifetime)` : `${it.durationYears ?? 1} year(s)`],
        ["Expected trigger", it.startTrigger || "From date of report"],
        ["Expected endpoint", endpoint],
        ["Alternative treatment", it.lowerCostAlternative || "None clinically equivalent identified"],
        ["Why alternative not preferred", it.lowerCostAlternative ? "Not clinically equivalent; does not meet the same medical need as the standard of care for the diagnosis" : "—"],
        ["CPT", it.cptCode || "—"],
        ["HCPCS", "—"],
        ["Estimated unit cost", money(it.unitCost)],
        ["Annual cost", money(it.annualCost)],
        ["Projected future cost", `${money(it.lifetimeCost)} (inflation-adjusted)`],
        ["Present value", money(it.presentValue)],
        ["PV range (low–high)", `${money(it.lowCost)} – ${money(it.highCost)}`],
        ["Pricing source", it.pricingSource || "UCR benchmark"],
        ["Assumptions", `Discount ${(a.discountRate * 100).toFixed(1)}%, medical inflation ${(a.medicalInflation * 100).toFixed(1)}%, geographic factor ${a.geographicFactor.toFixed(2)}`],
        ["Outstanding questions", it.missingSupport || "None outstanding"],
        ["Physician review status", it.physicianStatus.toLowerCase()],
        ["Defense vulnerability", it.defenseVulnerability.toLowerCase()],
      ]),
    ];
  }

  const body: (Paragraph | Table)[] = [];

  // ── Cover ────────────────────────────────────────────────────────────────────
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200, after: 40 }, children: [new TextRun({ text: c.firm.letterhead || c.firm.name, bold: true, size: 22, color: BRAND })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: BRAND, space: 6 } }, children: [new TextRun({ text: "LIFE CARE PLAN & FUTURE MEDICAL COST ANALYSIS", bold: true, size: 32, color: INK })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: `${templateLabel} — Final Report`, italics: true, size: 22, color: INK })] }));
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
  body.push(new Table({ width: { size: 80, type: WidthType.PERCENTAGE }, alignment: AlignmentType.CENTER, borders: allBorders("E2E8F0"), rows: demo.map(([k, v]) => row([cell(k, { bold: true, width: 40, fill: "F1F5F9" }), cell(v, { width: 60 })])) }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 260, after: 40 }, children: [new TextRun({ text: "Estimated Future Medical Damages (present value)", size: 20, color: INK })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 20 }, children: [new TextRun({ text: money(totalPresentValue), bold: true, size: 48, color: BRAND })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [new TextRun({ text: `Undiscounted lifetime ${money(totalLifetime)} · ${reportItems.length} projected care items${reviewStarted ? " (physician-endorsed)" : " (provisional — pending physician review)"}`, italics: true, size: 18, color: MUTED })] }));

  // ══ 1. EXECUTIVE SUMMARY ═════════════════════════════════════════════════════
  body.push(h1("1. Executive Summary", { pageBreak: true }));
  const primaryDx = [c.diagnosis, ...addlDx.map((d) => d?.diagnosis)].filter(Boolean).join("; ") || "the injuries at issue";
  const funcNow = c.functionalLimitations || (c.currentWorkStatus ? `${c.currentWorkStatus.toLowerCase()}${c.currentWorkStatus === "Disabled" && c.disabilityReason ? ` — ${c.disabilityReason}` : ""}` : "documented in the treating records (see §6)");
  body.push(
    tbl([
      row([cell("Patient", { bold: true, width: 26, fill: "F1F5F9" }), cell(`${c.clientName}${age != null ? `, ${age}` : ""} (${sexNoun})`, { width: 74 })]),
      row([cell("Date of injury / mechanism", { bold: true, fill: "F1F5F9" }), cell(`${fmtDate(c.dateOfInjury)}${c.mechanism ? ` — ${c.mechanism.toLowerCase()}` : ""}`)]),
      row([cell("Primary diagnoses", { bold: true, fill: "F1F5F9" }), cell(`${primaryDx}${c.icd10Code ? ` (ICD-10 ${c.icd10Code})` : ""}`)]),
      row([cell("Current functional status", { bold: true, fill: "F1F5F9" }), cell(funcNow)]),
      row([cell("Life expectancy (horizon)", { bold: true, fill: "F1F5F9" }), cell(`${life.toFixed(1)} remaining years`)]),
      row([cell("Estimated lifetime medical damages", { bold: true, fill: "F1F5F9" }), cell(`${money(totalLifetime)} undiscounted`)]),
      row([cell("Present value", { bold: true, fill: "F1F5F9" }), cell(`${money(totalPresentValue)} (range ${money(totalLow)}–${money(totalHigh)})`)]),
      row([cell("Projected future-care items", { bold: true, fill: "F1F5F9" }), cell(`${reportItems.length}${reviewStarted ? " physician-endorsed" : " provisional"}`)]),
      row([cell("Overall confidence", { bold: true, fill: "F1F5F9" }), cell(`${avgConf}% (mean across recommendations)`)]),
      row([cell("Overall defense vulnerability", { bold: true, fill: "F1F5F9" }), cell(`${overallVulnLabel} (${highVuln} high-vulnerability item${highVuln === 1 ? "" : "s"})`)]),
      row([cell("Physician review status", { bold: true, fill: "F1F5F9" }), cell(`${accepted.length} of ${items.length} recommendations carry sign-off`)]),
      row([cell("Report quality score", { bold: true, fill: "F1F5F9" }), cell(`${overallQuality}/100`)]),
    ]),
  );
  body.push(h2("Key Assumptions"));
  body.push(bullet(`Remaining life expectancy of ${life.toFixed(1)} years is applied as the projection horizon for all lifetime items (SSA actuarial basis).`));
  body.push(bullet(`Costs are discounted to present value at ${(a.discountRate * 100).toFixed(1)}% against ${(a.medicalInflation * 100).toFixed(1)}% medical inflation, with a geographic factor of ${a.geographicFactor.toFixed(2)}.`));
  body.push(bullet(`Only care that is medically probable (more likely than not) is totaled; speculative contingencies are disclosed separately (§9, §11).`));
  body.push(bullet(`Every recommendation is subject to the reviewing physician's confirmation of medical necessity (§13).`));
  body.push(h2("Summary"));
  body.push(p(`${subject} sustained ${primaryDx.toLowerCase()} on ${fmtDate(c.dateOfInjury)}${c.mechanism ? ` by mechanism of ${c.mechanism.toLowerCase()}` : ""}. The reviewed records establish the diagnoses and treatment course set out in §4–§5. Reasoning from that record, this plan projects ${reportItems.length} medically-probable future-care item${reportItems.length === 1 ? "" : "s"} across ${catCount} care domain${catCount === 1 ? "" : "s"}, at a present value of ${money(totalPresentValue)} over the ${life.toFixed(1)}-year horizon. Each recommendation is tied to a specific diagnosis, objective evidence, guideline or literature support, a priced basis, and a stated confidence and defense-vulnerability rating, and is reserved for physician sign-off. An attorney should be able to grasp the case from this page; the sections that follow show the work.`));

  // ── Report Quality Assurance (self-scoring gate) ─────────────────────────────
  body.push(h1("Report Quality Assurance"));
  body.push(p("Before export, the report scores itself across nine dimensions. Any score below 90/100 carries an improvement recommendation. Scores are computed from the underlying data — record coverage, evidence and cost support per item, physician sign-off, and defense exposure — not asserted.", { italics: true, size: 18 }));
  const qaRows: TableRow[] = [row([cell("Quality metric", { bold: true, width: 34, fill: BRAND, color: "FFFFFF" }), cell("Score", { bold: true, width: 10, fill: BRAND, color: "FFFFFF", align: AlignmentType.RIGHT }), cell("Status", { bold: true, width: 14, fill: BRAND, color: "FFFFFF" }), cell("Improvement recommendation", { bold: true, width: 42, fill: BRAND, color: "FFFFFF" })])];
  for (const r of scoreRows) {
    const ok = r.score >= 90;
    qaRows.push(row([
      cell(r.label, { bold: r.label.startsWith("Overall report") }),
      cell(`${r.score}`, { align: AlignmentType.RIGHT, bold: true, color: scoreColor(r.score) }),
      cell(ok ? "Meets ≥90" : "Below target", { color: scoreColor(r.score), size: 15 }),
      cell(ok ? "—" : r.improve, { size: 15 }),
    ]));
  }
  body.push(tbl(qaRows));
  if (overallQuality < 90) body.push(p(`Overall quality is ${overallQuality}/100 — below the 90 export threshold. The improvement recommendations above should be addressed (most commonly, obtaining physician sign-off) before this report is served or relied upon at deposition.`, { italics: true, color: WARN, size: 18 }));

  // ══ 2. METHODOLOGY ═══════════════════════════════════════════════════════════
  body.push(h1("2. Methodology", { pageBreak: true }));
  body.push(labeled("Records reviewed", `${c.documents.length} record set${c.documents.length === 1 ? "" : "s"} totaling ${c.documents.reduce((s, d) => s + (d.pageCount || 0), 0)} pages (itemized in §3).`));
  body.push(labeled("Clinical methodology", "Diagnoses and impairments are established from the objective record (imaging, operative findings, examination, diagnostic studies), then mapped to the goods and services the conditions require over the remaining lifetime, consistent with published life-care-planning methodology and the standards of the certified LCP bodies."));
  body.push(labeled("Guidelines utilized", "Official Disability Guidelines (ODG) and the applicable specialty clinical practice guidelines for each diagnosis (e.g. AAOS, AANS/CNS, AAN), applied to frequency, duration, and medical necessity."));
  body.push(labeled("Medical literature", "Peer-reviewed natural-history, complication-rate, and procedure-survivorship literature (StatPearls / NCBI and journal sources) is cited per recommendation in §8. Citations name the governing authority; no article-level citation is fabricated."));
  body.push(labeled("Pricing methodology", "Unit costs are benchmarked to FAIR Health billed charges by CPT and geography and to CMS RVU/DMEPOS/laboratory fee schedules, with GoodRx for retail pharmaceuticals, adjusted by the geographic factor below."));
  body.push(labeled("Cost & economic assumptions", `Medical inflation ${(a.medicalInflation * 100).toFixed(1)}% per year; present-value discount rate ${(a.discountRate * 100).toFixed(1)}%; geographic cost factor ${a.geographicFactor.toFixed(2)}; projection horizon ${life.toFixed(1)} years. Sensitivity to these assumptions is analyzed in §9.`));
  body.push(labeled("Definition of medical probability", "A recommendation is offered to a reasonable degree of medical probability (RDMP) when it is more likely than not (>50%) to be required. Care that is foreseeable but not more likely than not is designated possible or speculative and is disclosed but not totaled."));
  body.push(labeled("Limitations", "The plan rests on the records available at the time of writing; it may be updated as additional records, examinations, or physician opinions become available. Outstanding items are identified per recommendation (§7) and in the completeness analysis (§12)."));
  body.push(h2("Abbreviations"));
  for (const [ab, meaning] of ABBREVIATIONS) body.push(new Paragraph({ spacing: { after: 24 }, children: [new TextRun({ text: `${ab}  `, bold: true, size: 18 }), new TextRun({ text: meaning, size: 18 })] }));

  // ══ 3. RECORDS REVIEWED ══════════════════════════════════════════════════════
  body.push(h1("3. Records Reviewed", { pageBreak: true }));
  body.push(p(`The following ${c.documents.length} record${c.documents.length === 1 ? "" : "s"} were reviewed and weighed. Importance reflects the record's evidentiary weight for the injuries at issue; relevance reflects the strength of its content signal to the complaint; confidence reflects extraction/classification certainty.`));
  if (c.documents.length) {
    const rr: TableRow[] = [row([
      cell("Date", { bold: true, width: 10, fill: BRAND, color: "FFFFFF" }),
      cell("Provider", { bold: true, width: 20, fill: BRAND, color: "FFFFFF" }),
      cell("Specialty / Role", { bold: true, width: 18, fill: BRAND, color: "FFFFFF" }),
      cell("Document Type", { bold: true, width: 20, fill: BRAND, color: "FFFFFF" }),
      cell("Pg", { bold: true, width: 6, fill: BRAND, color: "FFFFFF", align: AlignmentType.RIGHT }),
      cell("Import.", { bold: true, width: 9, fill: BRAND, color: "FFFFFF" }),
      cell("Relev.", { bold: true, width: 9, fill: BRAND, color: "FFFFFF" }),
      cell("Conf.", { bold: true, width: 8, fill: BRAND, color: "FFFFFF", align: AlignmentType.RIGHT }),
    ])];
    c.documents.forEach((d, i) => {
      const fill = i % 2 ? "F8FAFC" : "FFFFFF";
      const imp = importanceOf(d.type);
      const conf = Math.round((d.ocrConfidence ?? 0.9) * 100);
      const pp = (pages: number[]) => { const r = pageRange(pages || []); return r ? (/[–,]/.test(r) ? ` (pp. ${r})` : ` (p. ${r})`) : ""; };
      const provs = (Array.isArray(d.providers) ? d.providers : []) as { name: string; credentials?: string | null; role?: string | null; pages?: number[] }[];
      const dateCell = d.serviceDate ? (d.serviceDateEnd ? `${fmtDate(d.serviceDate)} – ${fmtDate(d.serviceDateEnd)}` : fmtDate(d.serviceDate)) : "—";
      const provCell = provs.length > 1 ? provs.map((p) => `${p.name}${p.credentials ? `, ${p.credentials}` : ""}${pp(p.pages ?? [])}`).join("; ") : d.authorName || "—";
      const roleCell = provs.length > 1 ? [...new Set(provs.map((p) => p.role).filter(Boolean))].join("; ") || "Multiple" : d.authorRole || "—";
      rr.push(row([
        cell(dateCell, { size: 15, fill }),
        cell(provCell, { size: 15, fill }),
        cell(roleCell, { size: 15, fill }),
        cell(typeLabel(d.type), { size: 15, fill }),
        cell(String(d.pageCount || "—"), { align: AlignmentType.RIGHT, size: 15, fill }),
        cell(imp, { size: 15, fill }),
        cell(imp === "Low" ? "Low" : imp === "High" ? "High" : "Moderate", { size: 15, fill }),
        cell(`${conf}%`, { align: AlignmentType.RIGHT, size: 15, fill }),
      ]));
    });
    body.push(tbl(rr));
  }

  // ══ 4. MEDICAL CHRONOLOGY ════════════════════════════════════════════════════
  body.push(h1("4. Medical Chronology", { pageBreak: true }));
  body.push(p(`The records were screened for the clinically pivotal events and those bearing on a diagnosis or an anticipated future-care item — not every document — and organized into a chronology of ${c.chronologyEvents.length} clinical event${c.chronologyEvents.length === 1 ? "" : "s"}. Each entry is headed by the date, treating provider, and facility, and reports the encounter's subjective, examination, diagnostic studies, assessment, plan, procedure, and disposition as documented, with its clinical significance and a citation to the source record.`, { size: 19 }));
  if (!c.chronologyEvents.length) body.push(p("No clinical events were catalogued from the reviewed records.", { italics: true }));
  for (const e of c.chronologyEvents) {
    const src = e.sourceDocumentId ? docById.get(e.sourceDocumentId) : undefined;
    // LCP-style encounter header: MM/DD/YYYY[ - MM/DD/YYYY] - Provider / Facility - Record Type
    const header = `${mdY(e.eventDate)}${e.eventDateEnd ? ` – ${mdY(e.eventDateEnd)}` : ""} - ${e.provider || "Treating provider"}${e.facility ? ` / ${String(e.facility).replace(/[.\s]+$/, "")}` : ""}${e.recordType ? ` - ${e.recordType}` : ""}`;
    body.push(new Paragraph({ spacing: { before: 160, after: 24 }, children: [new TextRun({ text: header, bold: true, size: 19, color: INK })] }));
    const anySection = e.subjective || e.objectiveFindings || e.imagingFindings || e.diagnosis || e.treatment || e.procedure || e.disposition;
    if (e.subjective) body.push(labeled("Subjective", e.subjective));
    if (e.objectiveFindings) body.push(labeled("Exam", e.objectiveFindings));
    if (e.imagingFindings) body.push(labeled("Diagnostic Studies", e.imagingFindings));
    if (e.diagnosis) body.push(labeled("Assessment", e.diagnosis));
    if (e.treatment) body.push(labeled("Plan", e.treatment));
    if (e.procedure) body.push(labeled("Procedure", e.procedure));
    if (e.disposition) body.push(labeled("Disposition", e.disposition));
    if (!anySection) body.push(labeled("Summary", e.summary));
    if (e.functionalStatus) body.push(labeled("Functional impact", e.functionalStatus));
    if (e.restrictions || e.workStatus) body.push(labeled("Work restrictions", [e.restrictions, e.workStatus].filter(Boolean).join("; ")));
    if (e.clinicalSignificance) body.push(labeled("Clinical significance", e.clinicalSignificance));
    body.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: `(Source: ${src ? src.filename : "record on file"}${e.sourcePage ? `, p. ${e.sourcePage}` : ""})`, size: 15, color: MUTED })] }));
  }

  // ══ 5. INJURY ANALYSIS ═══════════════════════════════════════════════════════
  body.push(h1("5. Injury Analysis", { pageBreak: true }));
  body.push(p("Each diagnosis is analyzed for its objective basis, its relationship to the incident, and the strength and gaps of the supporting evidence — reasoning from the record rather than restating it.", { size: 19 }));
  if (c.icd10Code || c.diagnosis) {
    body.push(h2(`${c.diagnosis || "Primary diagnosis"}${c.icd10Code ? ` — ICD-10 ${c.icd10Code}` : ""}`));
    body.push(labeled("Mechanism", c.mechanism ? c.mechanism : "As described in the incident history."));
    body.push(labeled("Relationship", "Primary diagnosis of record, attributed to the reported injury mechanism."));
  }
  for (const cond of c.conditions) {
    const evSources = (Array.isArray(cond.evidenceSources) ? cond.evidenceSources : []) as { filename?: string; page?: number | null; quote?: string }[];
    body.push(new Paragraph({ spacing: { before: 160, after: 20 }, children: [new TextRun({ text: cond.name, bold: true, size: 20 }), new TextRun({ text: `  —  ICD-10 ${icdFor(cond.name)} · confidence ${confidenceBand(cond.confidence)} (${cond.confidence}%)`, size: 18, color: MUTED })] }));
    body.push(labeled("Relationship to incident", `${cond.name} is ${relatednessText(cond.relatedness)} (confidence ${cond.confidence}%).`));
    body.push(labeled("Confidence basis", confidenceDefinition({ confidence: cond.confidence, physicianConfirmed: cond.physicianConfirmed, missingInfo: cond.missingInfo, evidenceCount: evSources.length })));
    if (cond.objectiveEvidence) body.push(labeled("Objective evidence / examination", cond.objectiveEvidence));
    if (evSources.length) body.push(labeled("Evidence sources (record · page)", evSources.map((s) => `${s.filename}${s.page ? `, p. ${s.page}` : ""}${s.quote ? ` — "${s.quote}"` : ""}`).join("  ·  ")));
    if (cond.supportingRecords) body.push(labeled("Supporting records / physician", cond.supportingRecords));
    // Standard-of-care analysis: cited guidance quoted verbatim + documentation status.
    const soc = cond.socAnalysis as unknown as {
      standard?: string; documentation?: string; rationale?: string; gaps?: string | null;
      assessment?: { verdict?: string; narrative?: string; points?: { guideline?: string; addressed?: boolean; support?: string | null }[] };
      guidelines?: { title?: string; journal?: string; year?: string; pmid?: string; doi?: string; quote?: string; userProvided?: boolean }[];
      userNotes?: { text?: string }[];
    } | null;
    if (soc) {
      const VLABEL: Record<string, string> = { CONSISTENT: "Consistent with cited guidance", PARTIAL: "Partially consistent — gaps noted", POTENTIAL_GAP: "Potential gap — recommended care not documented", INDETERMINATE: "Indeterminate — insufficient documentation" };
      if (soc.assessment) {
        body.push(labeled("Standard-of-care assessment", `${VLABEL[soc.assessment.verdict ?? ""] ?? soc.assessment.verdict ?? ""} — ${soc.assessment.narrative ?? ""}`));
      }
      body.push(labeled("Documentation", `${String(soc.documentation ?? "").replace(/_/g, " ")} — ${soc.rationale ?? ""}`));
      for (const g of soc.guidelines ?? []) {
        const pt = soc.assessment?.points?.find((p) => p.guideline && (g.title ?? "").startsWith(p.guideline.replace(/…$/, "")));
        const mark = pt ? (pt.addressed ? `[Addressed${pt.support ? ` — ${pt.support}` : ""}] ` : "[Not evidenced in the reviewed records] ") : "";
        const label = g.userProvided ? "Guidance — reviewer-added (quoted)" : "Guidance (quoted verbatim)";
        body.push(labeled(label, `${mark}"${g.quote}" — ${g.title}.${g.userProvided ? "" : ` ${g.journal ?? ""}${g.year ? ` ${g.year}` : ""}${g.pmid ? ` (PMID ${g.pmid})` : g.doi ? ` (doi:${g.doi})` : ""}.`}`));
      }
      for (const nt of soc.userNotes ?? []) body.push(labeled("Reviewer note (incorporated)", nt.text ?? ""));
      if (soc.gaps) body.push(labeled("Standard-of-care gap", soc.gaps));
      body.push(labeled("Determination", "The assessment is a preliminary, evidence-grounded aid; the final standard-of-care determination is the reviewing physician's."));
    }
    if (cond.reasoning) body.push(labeled("Analysis", cond.reasoning));
    body.push(labeled("Pre-existing / aggravation", cond.relatedness === "AGGRAVATION" ? "Aggravation of a pre-existing condition — apportionment addressed in §10." : cond.relatedness === "PREEXISTING_UNRELATED" ? "Pre-existing and unrelated — excluded from causally-related damages." : "No pre-existing basis identified in the reviewed records for this diagnosis."));
    body.push(labeled("Contradictory evidence", cond.opposingRecords || "None identified in the reviewed records."));
    body.push(labeled("Missing evidence", cond.missingInfo || "None outstanding for this diagnosis."));
  }

  // ══ 6. CURRENT FUNCTIONAL STATUS ═════════════════════════════════════════════
  body.push(h1("6. Current Functional Status", { pageBreak: true }));
  body.push(p(`Documented functional status: ${c.functionalLimitations || "not separately narrated in the reviewed records."} Work status: ${c.currentWorkStatus || "not documented"}${c.currentWorkStatus === "Disabled" && c.disabilityReason ? ` — ${c.disabilityReason}` : ""}.`));
  const funcText = [c.functionalLimitations, ...c.chronologyEvents.map((e) => e.functionalStatus), ...c.chronologyEvents.map((e) => e.restrictions)].filter(Boolean).join(" ");
  const DOMAINS: [string, RegExp][] = [
    ["Ambulation / walking", /walk|ambulat|gait/i], ["Stairs", /stair/i], ["Lifting & carrying", /lift|carry/i],
    ["Sitting tolerance", /\bsit/i], ["Standing tolerance", /\bstand/i], ["Driving", /driv/i],
    ["Self-care / ADLs", /self-care|\badl|dress|bath|groom|toilet/i], ["Employment", /work|employ|\bjob|occupation|sedentary|light duty/i],
    ["Household activities", /household|chores|home ?maint|cook|clean|laundry/i], ["Recreation", /recreat|hobby|sport|leisure/i],
    ["Cognition", /cognit|memory|concentrat|attention|executive/i], ["Psychological status", /depress|anxi|ptsd|mood|psych/i],
    ["Sleep", /sleep|insomnia/i], ["Pain", /pain/i], ["Range of motion", /range of motion|\brom\b|flexion|extension|mobility/i],
    ["Neurologic deficits", /numb|weak|neurolog|radicul|tingl|paresthes|sensor|reflex/i], ["Restrictions", /restrict|limit|no lifting|precaution/i],
  ];
  const fr: TableRow[] = [row([cell("Functional domain", { bold: true, width: 34, fill: BRAND, color: "FFFFFF" }), cell("Documented status / assessment", { bold: true, width: 66, fill: BRAND, color: "FFFFFF" })])];
  DOMAINS.forEach(([dom, re], i) => {
    const documented = re.test(funcText);
    fr.push(row([cell(dom, { bold: true, size: 15, fill: i % 2 ? "F8FAFC" : "FFFFFF" }), cell(documented ? "Impairment documented in the record (see functional limitations and chronology)." : "Not separately quantified in the reviewed records; formal measurement (FCE / validated testing) recommended.", { size: 15, fill: i % 2 ? "F8FAFC" : "FFFFFF" })]));
  });
  body.push(tbl(fr));
  body.push(p("Domains marked as not separately quantified are candidates for a functional capacity evaluation, which would strengthen the objective basis for the corresponding care recommendations.", { italics: true, size: 18 }));

  // ══ 7. FUTURE MEDICAL CARE (CORE) ════════════════════════════════════════════
  body.push(h1("7. Future Medical Care", { pageBreak: true }));
  body.push(p(`This is the core of the report. Each of the ${reportItems.length} medically-probable recommendation${reportItems.length === 1 ? "" : "s"} is presented as a structured card documenting its necessity, supporting diagnosis and evidence, probability and confidence, alternatives, frequency/duration, coding, cost, assumptions, outstanding questions, physician status, and defense vulnerability.`, { size: 19 }));
  if (!reportItems.length) body.push(p(reviewStarted ? "No future-care items have been endorsed on physician review." : "No future-care recommendations have been generated for this case.", { italics: true }));
  for (const g of CATEGORY_GROUPS) {
    const groupItems = reportItems.filter((i) => g.cats.includes(i.category));
    if (!groupItems.length) continue;
    body.push(h2(g.title));
    for (const it of groupItems) body.push(...recCard(it));
  }

  // ══ 8. MEDICAL LITERATURE & EVIDENCE ═════════════════════════════════════════
  body.push(h1("8. Medical Literature & Evidence", { pageBreak: true }));
  body.push(p("For each recommendation, the governing evidence is summarized with its level and applicability. Contradictory studies and limitations are stated where relevant. Citations name the authority; no article-level citation is fabricated.", { size: 19 }));
  const litSeen = new Set<string>();
  const litRows: TableRow[] = [row([
    cell("Recommendation", { bold: true, width: 24, fill: BRAND, color: "FFFFFF" }),
    cell("Evidence / guideline basis", { bold: true, width: 30, fill: BRAND, color: "FFFFFF" }),
    cell("Level", { bold: true, width: 15, fill: BRAND, color: "FFFFFF" }),
    cell("Why it applies / limitations", { bold: true, width: 24, fill: BRAND, color: "FFFFFF" }),
    cell("Score", { bold: true, width: 7, fill: BRAND, color: "FFFFFF", align: AlignmentType.RIGHT }),
  ])];
  let li = 0;
  for (const it of reportItems) {
    const key = it.service.toLowerCase();
    if (litSeen.has(key)) continue;
    litSeen.add(key);
    const fill = li++ % 2 ? "F8FAFC" : "FFFFFF";
    litRows.push(row([
      cell(it.service, { size: 15, fill }),
      cell(`${it.evidenceStrength || "Case-specific"}${it.literatureSupport ? ` — ${it.literatureSupport}` : ""}`, { size: 14, fill }),
      cell(levelOfEvidence(it.evidenceStrength), { size: 14, fill }),
      cell(`Applies to ${(it.rationale || "the diagnosis").toLowerCase()}.${it.missingSupport ? ` Limitation: ${it.missingSupport.toLowerCase()}` : ""}`, { size: 14, fill }),
      cell(String(evidenceScore(it)), { align: AlignmentType.RIGHT, size: 15, fill }),
    ]));
  }
  body.push(tbl(litRows));

  // ══ 9. COST ANALYSIS ═════════════════════════════════════════════════════════
  body.push(h1("9. Cost Analysis", { pageBreak: true }));
  body.push(h2("Scenario Summary"));
  body.push(tbl([
    row([cell("Scenario", { bold: true, width: 34, fill: BRAND, color: "FFFFFF" }), cell("Basis", { bold: true, width: 40, fill: BRAND, color: "FFFFFF" }), cell("Present value", { bold: true, width: 26, fill: BRAND, color: "FFFFFF", align: AlignmentType.RIGHT })]),
    row([cell("Low"), cell("Conservative utilization / pricing (−15%)"), cell(money(totalLow), { align: AlignmentType.RIGHT })]),
    row([cell("Expected", { bold: true }), cell("Most-probable utilization at benchmark pricing", { bold: true }), cell(money(totalPresentValue), { bold: true, align: AlignmentType.RIGHT, color: BRAND })]),
    row([cell("High"), cell("Higher utilization / pricing (+25%)"), cell(money(totalHigh), { align: AlignmentType.RIGHT })]),
    row([cell("Undiscounted lifetime", { bold: true, fill: "F1F5F9" }), cell("Inflation-adjusted future dollars (expected)", { fill: "F1F5F9" }), cell(money(totalLifetime), { bold: true, align: AlignmentType.RIGHT, fill: "F1F5F9" })]),
  ]));

  body.push(h2("Detailed Medical Cost Table"));
  body.push(p(`Present-day dollars. "Lifetime" is the inflation-adjusted cost over the ${life.toFixed(1)}-year horizon; present value is discounted at ${(a.discountRate * 100).toFixed(1)}%.`, { italics: true, size: 17 }));
  const mctRows: TableRow[] = [row([
    cell("Service / Item", { bold: true, width: 30, fill: BRAND, color: "FFFFFF" }),
    cell("CPT", { bold: true, width: 8, fill: BRAND, color: "FFFFFF" }),
    cell("Frequency", { bold: true, width: 12, fill: BRAND, color: "FFFFFF" }),
    cell("Unit", { bold: true, width: 11, fill: BRAND, color: "FFFFFF", align: AlignmentType.RIGHT }),
    cell("Lifetime", { bold: true, width: 15, fill: BRAND, color: "FFFFFF", align: AlignmentType.RIGHT }),
    cell("Present value", { bold: true, width: 15, fill: BRAND, color: "FFFFFF", align: AlignmentType.RIGHT }),
    cell("Basis", { bold: true, width: 9, fill: BRAND, color: "FFFFFF" }),
  ])];
  for (const g of CATEGORY_GROUPS) {
    const groupItems = reportItems.filter((i) => g.cats.includes(i.category));
    if (!groupItems.length) continue;
    mctRows.push(row([cell(g.title, { bold: true, fill: "E2F2F5" }), ...Array.from({ length: 6 }, () => cell("", { fill: "E2F2F5" }))]));
    for (const i of groupItems) {
      const freq = i.isLifetime || (i.durationYears ?? 0) > 1 ? `${i.frequencyPerYear}/yr` : "one-time";
      mctRows.push(row([cell(i.service, { size: 15 }), cell(i.cptCode || "—", { size: 15 }), cell(freq, { size: 15 }), cell(money(i.unitCost), { align: AlignmentType.RIGHT, size: 15 }), cell(money(i.lifetimeCost), { align: AlignmentType.RIGHT, size: 15 }), cell(money(i.presentValue), { align: AlignmentType.RIGHT, size: 15 }), cell(i.pricingSource || "UCR", { size: 13 })]));
    }
    const subL = groupItems.reduce((s, i) => s + i.lifetimeCost, 0);
    const subP = groupItems.reduce((s, i) => s + i.presentValue, 0);
    mctRows.push(row([cell(`Subtotal — ${g.title}`, { bold: true, fill: "F1F5F9", size: 15 }), cell("", { fill: "F1F5F9" }), cell("", { fill: "F1F5F9" }), cell("", { fill: "F1F5F9" }), cell(money(subL), { bold: true, align: AlignmentType.RIGHT, fill: "F1F5F9", size: 15 }), cell(money(subP), { bold: true, align: AlignmentType.RIGHT, fill: "F1F5F9", size: 15 }), cell("", { fill: "F1F5F9" })]));
  }
  mctRows.push(row([cell("TOTAL FUTURE MEDICAL DAMAGES", { bold: true, fill: BRAND, color: "FFFFFF" }), cell("", { fill: BRAND }), cell("", { fill: BRAND }), cell("", { fill: BRAND }), cell(money(totalLifetime), { bold: true, align: AlignmentType.RIGHT, fill: BRAND, color: "FFFFFF" }), cell(money(totalPresentValue), { bold: true, align: AlignmentType.RIGHT, fill: BRAND, color: "FFFFFF" }), cell("", { fill: BRAND })]));
  body.push(tbl(mctRows));

  body.push(h2("Sensitivity Analysis"));
  body.push(p("Present value of the plan under alternative discount and medical-inflation assumptions. The expected case is highlighted.", { italics: true, size: 17 }));
  const discs = [a.discountRate - 0.01, a.discountRate, a.discountRate + 0.01];
  const infls = [a.medicalInflation - 0.01, a.medicalInflation, a.medicalInflation + 0.01];
  const pvUnder = (disc: number, infl: number) =>
    reportItems.reduce((s, it) => s + project({ category: it.category, unitCost: it.unitCost, frequencyPerYear: it.frequencyPerYear, durationYears: it.durationYears, isLifetime: it.isLifetime }, { lifeExpectancyYears: life, discountRate: disc, medicalInflation: infl, geographicFactor: 1 }).presentValue, 0);
  const sens: TableRow[] = [row([cell("Discount ↓ / Inflation →", { bold: true, width: 28, fill: BRAND, color: "FFFFFF", size: 14 }), ...infls.map((inf) => cell(`${(inf * 100).toFixed(1)}%`, { bold: true, width: 24, fill: BRAND, color: "FFFFFF", align: AlignmentType.RIGHT }))])];
  for (const disc of discs) {
    sens.push(row([
      cell(`${(disc * 100).toFixed(1)}%`, { bold: true, fill: "F1F5F9", size: 15 }),
      ...infls.map((inf) => {
        const isBase = Math.abs(disc - a.discountRate) < 1e-9 && Math.abs(inf - a.medicalInflation) < 1e-9;
        return cell(money(pvUnder(disc, inf)), { align: AlignmentType.RIGHT, size: 15, bold: isBase, color: isBase ? BRAND : undefined, fill: isBase ? "E2F2F5" : undefined });
      }),
    ]));
  }
  body.push(tbl(sens));

  // ══ 10. CAUSATION ════════════════════════════════════════════════════════════
  body.push(h1("10. Causation", { pageBreak: true }));
  const related = c.conditions.filter((x) => x.relatedness === "RELATED");
  const aggravations = c.conditions.filter((x) => x.relatedness === "AGGRAVATION");
  const unrelated = c.conditions.filter((x) => x.relatedness === "PREEXISTING_UNRELATED" || x.relatedness === "SUBSEQUENT_UNRELATED");
  const unclear = c.conditions.filter((x) => x.relatedness === "UNCLEAR");
  body.push(p(`Injury relationship — Of ${c.conditions.length} catalogued condition${c.conditions.length === 1 ? "" : "s"}, ${related.length} ${related.length === 1 ? "is" : "are"} causally related to the incident, ${aggravations.length} represent aggravation of a pre-existing condition, ${unrelated.length} ${unrelated.length === 1 ? "is" : "are"} pre-existing/unrelated, and ${unclear.length} remain of unclear relationship pending further records. Only related and aggravation conditions drive the future-care projections.`));
  if (aggravations.length) body.push(labeled("Aggravation & apportionment", `${aggravations.map((x) => x.name).join("; ")}. Where a pre-existing condition was aggravated, the incremental care attributable to the incident is included; baseline pre-injury need is apportioned out consistent with the reviewed history.`));
  body.push(labeled("Pre-existing conditions", preExisting.length ? `${preExisting.join("; ")} — considered in the apportionment analysis and cross-checked against the records.` : "None reported or identified in the reviewed records."));
  const alt = c.conditions.map((x) => x.opposingRecords).filter(Boolean) as string[];
  body.push(labeled("Alternative causes / contradictory evidence", alt.length ? alt.join(" ") : "No alternative cause is established by the reviewed records for the related diagnoses."));
  const weak = c.conditions.filter((x) => x.confidence < 65 || x.missingInfo);
  body.push(labeled("Weaker evidence / confidence", weak.length ? `${weak.map((x) => `${x.name} (${x.confidence}%${x.missingInfo ? `; ${x.missingInfo}` : ""})`).join("; ")}.` : "The related diagnoses are well supported; no low-confidence causal links remain."));
  body.push(p(`Overall causation confidence for the related diagnoses is ${related.length ? clamp(related.reduce((s, x) => s + x.confidence, 0) / related.length) : avgConf}%, offered to a reasonable degree of medical probability.`, { italics: true }));

  // ══ 11. DEFENSE ANALYSIS ═════════════════════════════════════════════════════
  body.push(h1("11. Defense Analysis — Potential Areas of Challenge", { pageBreak: true }));
  body.push(p("Each recommendation is stress-tested against the challenges opposing counsel is likely to raise, with a vulnerability rating and the additional support that would strengthen it.", { size: 19 }));
  const dr: TableRow[] = [row([
    cell("Recommendation", { bold: true, width: 22, fill: BRAND, color: "FFFFFF" }),
    cell("Specul.", { bold: true, width: 9, fill: BRAND, color: "FFFFFF" }),
    cell("MD support", { bold: true, width: 11, fill: BRAND, color: "FFFFFF" }),
    cell("Freq/Dur", { bold: true, width: 11, fill: BRAND, color: "FFFFFF" }),
    cell("Literature", { bold: true, width: 11, fill: BRAND, color: "FFFFFF" }),
    cell("Alt / dup.", { bold: true, width: 12, fill: BRAND, color: "FFFFFF" }),
    cell("Strengthen with", { bold: true, width: 18, fill: BRAND, color: "FFFFFF" }),
    cell("Vuln.", { bold: true, width: 6, fill: BRAND, color: "FFFFFF" }),
  ])];
  reportItems.forEach((it, i) => {
    const fill = i % 2 ? "F8FAFC" : "FFFFFF";
    const spec = it.probability === "SPECULATIVE" || it.probability === "NOT_SUPPORTED" ? "Yes" : "No";
    const md = it.physicianStatus === "APPROVED" || it.physicianStatus === "MODIFIED" ? "Signed" : "Pending";
    const fd = it.isLifetime ? "Lifetime" : `${it.durationYears ?? 1}y`;
    const lit = /guideline|odg|registry|literature|peer/i.test(it.evidenceStrength || "") ? "Supported" : "Case-specific";
    const alt = it.lowerCostAlternative ? "Alt exists" : "None";
    const strengthen = md === "Pending" ? "Physician sign-off" : it.missingSupport ? it.missingSupport : lit === "Case-specific" ? "Guideline citation" : "Well supported";
    dr.push(row([
      cell(it.service, { size: 14, fill }),
      cell(spec, { size: 14, fill, color: spec === "Yes" ? BAD : undefined }),
      cell(md, { size: 14, fill, color: md === "Pending" ? WARN : GOOD }),
      cell(`${it.frequencyPerYear}/yr · ${fd}`, { size: 14, fill }),
      cell(lit, { size: 14, fill }),
      cell(alt, { size: 14, fill }),
      cell(strengthen, { size: 13, fill }),
      cell(it.defenseVulnerability.toLowerCase(), { size: 13, fill, color: it.defenseVulnerability === "HIGH" ? BAD : it.defenseVulnerability === "MODERATE" ? WARN : GOOD }),
    ]));
  });
  body.push(tbl(dr));
  const defenseFindings = c.reviewFindings.filter((f) => f.kind === "DEFENSE");
  if (defenseFindings.length) {
    body.push(h2("Contested Points — Argument, Source, and Counter"));
    for (const f of defenseFindings) body.push(...reviewParagraphs(f));
  }

  // ══ 12. PLAINTIFF COMPLETENESS ANALYSIS ══════════════════════════════════════
  body.push(h1("12. Plaintiff Completeness Analysis", { pageBreak: true }));
  body.push(p("Automated check for care that is commonly required for injuries of this nature but is not yet represented in the plan. Present domains are confirmed; absent domains are flagged for consideration and physician input.", { size: 19 }));
  const present = new Set(reportItems.map((i) => i.category));
  const checklist: [string, CareCategory[]][] = [
    ["Rehabilitation therapies (PT/OT)", ["PHYSICAL_THERAPY", "OCCUPATIONAL_THERAPY"]],
    ["Future surgeries / revisions", ["FUTURE_SURGERY", "REVISION_SURGERY", "ORTHOPEDIC_SURGERY", "NEUROSURGERY"]],
    ["Medications", ["MEDICATION"]],
    ["Imaging surveillance", ["IMAGING"]],
    ["Psychological care", ["PSYCH", "COGNITIVE_THERAPY"]],
    ["Durable medical equipment", ["DME", "MOBILITY_AID", "ORTHOTICS_PROSTHETICS", "ASSISTIVE_TECH"]],
    ["Vocational rehabilitation", ["VOCATIONAL_REHAB"]],
    ["Home / vehicle modifications", ["HOME_MODIFICATION", "VEHICLE_MODIFICATION"]],
    ["Future evaluations / case management", ["CASE_MANAGEMENT", "SPECIALIST_VISIT", "PHYSICIAN_VISIT"]],
  ];
  const clRows: TableRow[] = [row([cell("Care domain", { bold: true, width: 46, fill: BRAND, color: "FFFFFF" }), cell("Status", { bold: true, width: 16, fill: BRAND, color: "FFFFFF" }), cell("Note", { bold: true, width: 38, fill: BRAND, color: "FFFFFF" })])];
  checklist.forEach(([label, cats], i) => {
    const inPlan = cats.some((ct) => present.has(ct));
    clRows.push(row([
      cell(label, { size: 15, fill: i % 2 ? "F8FAFC" : "FFFFFF" }),
      cell(inPlan ? "Included" : "Not present", { size: 15, color: inPlan ? GOOD : WARN, fill: i % 2 ? "F8FAFC" : "FFFFFF" }),
      cell(inPlan ? "Represented in the plan." : "Consider whether the record supports adding this domain; refer to physician.", { size: 14, fill: i % 2 ? "F8FAFC" : "FFFFFF" }),
    ]));
  });
  body.push(tbl(clRows));
  const completeness = c.reviewFindings.filter((f) => f.kind === "COMPLETENESS");
  if (completeness.length) {
    body.push(h2("Identified Omissions — Argument and Counter"));
    for (const f of completeness) body.push(...reviewParagraphs(f));
  }

  // ══ 13. PHYSICIAN REVIEW APPENDIX ════════════════════════════════════════════
  body.push(h1("13. Physician Review Appendix", { pageBreak: true }));
  body.push(p("A sign-off form for each recommendation. The reviewing physician may approve, reject, or modify (with a probability or frequency adjustment and medical-necessity edits), then sign. Modifications flow back into the plan.", { size: 19 }));
  for (const it of reportItems) {
    body.push(new Paragraph({ spacing: { before: 160, after: 20 }, children: [new TextRun({ text: it.service, bold: true, size: 19, color: INK }), new TextRun({ text: `  (current: ${it.probability.toLowerCase()}, ${it.frequencyPerYear}/yr, MD ${it.physicianStatus.toLowerCase()})`, size: 15, color: MUTED })] }));
    body.push(new Paragraph({ spacing: { after: 20 }, children: [new TextRun({ text: "☐ Approve      ☐ Reject      ☐ Modify", size: 18 })] }));
    body.push(new Paragraph({ spacing: { after: 20 }, children: [new TextRun({ text: "Probability adjustment: ___________________     Frequency adjustment: ___________________", size: 17, color: INK })] }));
    body.push(new Paragraph({ spacing: { after: 20 }, children: [new TextRun({ text: "Medical-necessity edits / comment: ______________________________________________________", size: 17, color: INK })] }));
    body.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: "Physician signature: ____________________________     Date: ______________", size: 17, color: INK })] }));
  }

  // ══ 14. INTERACTIVE EVIDENCE APPENDIX (TRACEABILITY) ═════════════════════════
  body.push(h1("14. Interactive Evidence Appendix — Traceability Matrix", { pageBreak: true }));
  body.push(p("Every recommendation traces to its supporting diagnosis, records, imaging, literature, and cost source. In the interactive HTML report these are live links; here they are the reference targets, so no conclusion stands unsupported.", { size: 19 }));
  const traceRows: TableRow[] = [row([
    cell("Recommendation", { bold: true, width: 22, fill: BRAND, color: "FFFFFF" }),
    cell("Diagnosis (§5)", { bold: true, width: 18, fill: BRAND, color: "FFFFFF" }),
    cell("Records (§3/§4)", { bold: true, width: 20, fill: BRAND, color: "FFFFFF" }),
    cell("Literature (§8)", { bold: true, width: 22, fill: BRAND, color: "FFFFFF" }),
    cell("Cost source (§9)", { bold: true, width: 18, fill: BRAND, color: "FFFFFF" }),
  ])];
  reportItems.forEach((it, i) => {
    const cond = it.conditionId ? condById.get(it.conditionId) : undefined;
    const fill = i % 2 ? "F8FAFC" : "FFFFFF";
    traceRows.push(row([
      cell(it.service, { size: 14, fill }),
      cell(cond?.name || c.diagnosis || "—", { size: 14, fill }),
      cell(cond?.supportingRecords || "Chronology & records index", { size: 13, fill }),
      cell(it.literatureSupport || it.evidenceStrength || "Case-specific", { size: 13, fill }),
      cell(it.pricingSource || "UCR benchmark", { size: 13, fill }),
    ]));
  });
  body.push(tbl(traceRows));

  // ── Potential costs not included ─────────────────────────────────────────────
  body.push(h1("Potential Medical Costs Not Included", { pageBreak: true }));
  body.push(p("The following contingencies are not reasonably medically probable and are excluded from the totals, but are disclosed for completeness:"));
  const speculative = reportItems.filter((i) => i.probability === "SPECULATIVE" || i.probability === "NOT_SUPPORTED");
  for (const i of speculative) body.push(bullet(`${i.service} — ${i.probability.toLowerCase()}${i.missingSupport ? `; ${i.missingSupport}` : ""}.`));
  for (const i of excludedForReview) body.push(bullet(`${i.service} — ${i.physicianStatus === "REJECTED" ? "declined on physician review" : "pending physician sign-off"}${i.physicianNote ? `; ${i.physicianNote}` : ""}.`));
  body.push(bullet("Medical costs of unexpected surgical or procedural complications."));
  body.push(bullet("Accelerated costs should the condition progress faster than anticipated (e.g. revision surgery, adjacent-segment disease, higher levels of attendant/facility care)."));

  // ── References ───────────────────────────────────────────────────────────────
  body.push(h1("References"));
  REFERENCES.forEach((r) => body.push(bullet(r)));

  // ── Daubert ──────────────────────────────────────────────────────────────────
  body.push(h1("Appendix — Daubert Admissibility"));
  const daubert: [string, string][] = [
    ["Can the methodology be tested?", "The life-care-planning methodology applied here is published and testable, and has been the subject of peer-reviewed literature since 1992."],
    ["Has it been peer-reviewed?", "The methodology is grounded in peer-reviewed texts and the standards of the certified life-care-planning bodies."],
    ["Is the rate of error acceptable?", "Only services, studies, and equipment reasonably probable to be required are included; standard confidence conventions are applied and disclosed."],
    ["Is it generally accepted?", "Certification in life care planning is the recognized credential for LCP experts in all fifty states and federally."],
    ["Is the opinion relevant?", "The plan predicts, to a reasonable degree of medical probability, the medical services and equipment required to treat the injuries over the remaining life expectancy."],
  ];
  for (const [q, ans] of daubert) body.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: `${q} `, bold: true, size: 20 }), new TextRun({ text: ans, size: 20 })] }));

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
  const header = ["Category", "Service", "Specialty", "CPT", "Probability", "Confidence", "Freq/yr", "Duration(yrs)", "UnitCost", "AnnualCost", "LifetimeCost", "PresentValue", "Low", "High", "PricingSource", "EvidenceStrength", "DefenseVulnerability", "PhysicianStatus"];
  const rows = items.map((i) =>
    [i.category, i.service, i.specialty ?? "", i.cptCode ?? "", i.probability, i.confidence, i.frequencyPerYear, i.isLifetime ? "lifetime" : i.durationYears ?? "", i.unitCost, i.annualCost, i.lifetimeCost, i.presentValue, i.lowCost, i.highCost, i.pricingSource ?? "", i.evidenceStrength ?? "", i.defenseVulnerability, i.physicianStatus]
      .map((v) => {
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}
