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
  Header,
  Footer,
  PageNumber,
  TabStopType,
  TabStopPosition,
} from "docx";
import { prisma } from "@/lib/db";
import { assumptionsFor } from "@/lib/engine/generate";
import { runIntegrityCheck, reviewLabel, evaluateCitation, functionalFinding, hasPatientRecordSupport, type RecInput, type CondInput, type PerItem, type IntegrityFinding } from "@/lib/engine/integrity";
import { buildRecommendationDossier, type DossierCondition, type DossierChronoEvent, type DossierCase, type EvidenceItem } from "@/lib/engine/medicalNecessity";
import { referencesFor, guidelineSourcesFor } from "@/lib/references/sources";
import { bodyRegion } from "@/lib/engine/integrity";
import { project } from "@/lib/engine/cost";
import { typeLabel } from "@/lib/documents/taxonomy";
import { parseConditions } from "@/lib/intake/preExisting";
import type { CaseSide, CareCategory, FutureCareItem } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Report generator. Produces a Life Care Plan & Future Medical Cost Analysis in
// .docx, written and typeset to read like a premium physician-authored expert
// report prepared for litigation — classic serif typography, dark-blue section
// headers, restrained tables, a running header/footer, and a narrative,
// first-person clinical voice. It reasons from the record rather than
// summarizing it; every conclusion remains traceable and every cost supported.
// Internal analytics (confidence, defense vulnerability, quality scoring) are
// preserved in the data model and the application, but deliberately do NOT
// appear in the finished document.
// ─────────────────────────────────────────────────────────────────────────────

// ── Design system ────────────────────────────────────────────────────────────
const FONT = "Garamond";
const NAVY = "1F3864"; // dark-blue section headers & table header fill
const INK = "1A1A1A"; // body text (near-black)
const GREY = "595959"; // captions, running header/footer, source lines
const RULE = "B7BDC7"; // thin table borders
const ALT = "F3F5F8"; // alternating row shading
const SOFT = "EAEEF4"; // subtotal / emphasis fill
// Body ~11.5pt, section header 15pt, subheader 13pt, tables 10pt (docx = half-pt).
const BODY = 23;
const H1 = 30;
const H2 = 26;
const TBL = 20;
const CAPTION = 18;

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const fmtDate = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "—");
const mdY = (d: Date | null) => (d ? `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}` : "—");
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lc = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const period = (s: string) => { const t = (s || "").trim(); return t ? (/[.!?]$/.test(t) ? t : t + ".") : ""; };

// ── Paragraph & heading builders ─────────────────────────────────────────────
function h1(text: string, opts: { pageBreak?: boolean } = {}) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    pageBreakBefore: opts.pageBreak,
    spacing: { before: 320, after: 160 },
    keepNext: true,
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: NAVY, space: 6 } },
    children: [new TextRun({ text, bold: true, color: NAVY, size: H1, allCaps: false })],
  });
}
function h2(text: string) {
  return new Paragraph({ spacing: { before: 240, after: 100 }, keepNext: true, children: [new TextRun({ text, bold: true, color: NAVY, size: H2 })] });
}
function p(text: string, opts: { italics?: boolean; size?: number; color?: string; after?: number; bold?: boolean } = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 160, line: 300 },
    alignment: AlignmentType.JUSTIFIED,
    children: [new TextRun({ text, italics: opts.italics, bold: opts.bold, size: opts.size ?? BODY, color: opts.color ?? INK })],
  });
}
function caption(text: string) {
  return new Paragraph({ spacing: { after: 120, line: 264 }, children: [new TextRun({ text, italics: true, size: CAPTION, color: GREY })] });
}
// Inline-labeled paragraph: bold "Label. " then body — used inside the chronology.
function labeled(label: string, bodyText: string) {
  return new Paragraph({ spacing: { after: 70, line: 288 }, alignment: AlignmentType.JUSTIFIED, indent: { left: 240 }, children: [new TextRun({ text: `${label}.  `, bold: true, size: 21, color: NAVY }), new TextRun({ text: bodyText, size: 21, color: INK })] });
}
function bullet(text: string) {
  return new Paragraph({ bullet: { level: 0 }, spacing: { after: 70, line: 288 }, children: [new TextRun({ text, size: BODY, color: INK })] });
}
function sourceLine(text: string) {
  return new Paragraph({ spacing: { after: 120 }, indent: { left: 240 }, children: [new TextRun({ text, size: 17, italics: true, color: GREY })] });
}

// ── Table builders ───────────────────────────────────────────────────────────
const thin = { style: BorderStyle.SINGLE, size: 3, color: RULE };
function tableBorders() {
  return { top: thin, bottom: thin, left: thin, right: thin, insideHorizontal: thin, insideVertical: thin };
}
type CellOpts = { width?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; fill?: string; bold?: boolean; color?: string; size?: number; header?: boolean };
function td(text: string, o: CellOpts = {}) {
  return new TableCell({
    width: o.width ? { size: o.width, type: WidthType.PERCENTAGE } : undefined,
    shading: o.header ? { fill: NAVY } : o.fill ? { fill: o.fill } : undefined,
    margins: { top: 60, bottom: 60, left: 110, right: 110 },
    children: [new Paragraph({ alignment: o.align, spacing: { line: 264 }, children: [new TextRun({ text, bold: o.header || o.bold, size: o.size ?? TBL, color: o.header ? "FFFFFF" : o.color ?? INK })] })],
  });
}
const rowOf = (cells: TableCell[]) => new TableRow({ children: cells });
function table(rows: TableRow[], width = 100): Table {
  return new Table({ width: { size: width, type: WidthType.PERCENTAGE }, borders: tableBorders(), rows });
}
// A two-column "label / value" spec grid, two pairs per row (four columns).
function specGrid(pairs: [string, string][]): Table {
  const rows: TableRow[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const a = pairs[i];
    const b = pairs[i + 1];
    const cells = [td(a[0], { bold: true, width: 20, fill: SOFT }), td(a[1] || "—", { width: 30 })];
    if (b) cells.push(td(b[0], { bold: true, width: 20, fill: SOFT }), td(b[1] || "—", { width: 30 }));
    else cells.push(td("", { width: 20 }), td("", { width: 30 }));
    rows.push(rowOf(cells));
  }
  return table(rows);
}
// A vertical label/value fact table (single column of rows).
function factTable(pairs: [string, string][], labelWidth = 34): Table {
  return table(pairs.map(([k, v]) => rowOf([td(k, { bold: true, width: labelWidth, fill: SOFT }), td(v || "—", { width: 100 - labelWidth })])));
}

// ── Small domain helpers ─────────────────────────────────────────────────────
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
function relatednessText(r: string): string {
  switch (r) {
    case "RELATED": return "causally related to the incident";
    case "AGGRAVATION": return "a pre-existing condition that was aggravated by the incident";
    case "PREEXISTING_UNRELATED": return "pre-existing and unrelated to the incident";
    case "SUBSEQUENT_UNRELATED": return "subsequent to, and unrelated to, the incident";
    default: return "of a relationship to the incident that remains to be clarified pending further records";
  }
}
const pronoun = (sex: string) => (sex === "FEMALE" ? { subj: "she", obj: "her", poss: "her" } : sex === "MALE" ? { subj: "he", obj: "him", poss: "his" } : { subj: "the patient", obj: "the patient", poss: "the patient's" });

const CATEGORY_GROUPS: { title: string; cats: CareCategory[] }[] = [
  { title: "Physician & Specialist Care", cats: ["PHYSICIAN_VISIT", "SPECIALIST_VISIT", "PRIMARY_CARE", "NEUROLOGY", "PMR", "PAIN_MANAGEMENT", "PSYCH"] },
  { title: "Surgical & Interventional Procedures", cats: ["ORTHOPEDIC_SURGERY", "NEUROSURGERY", "FUTURE_SURGERY", "REVISION_SURGERY", "INJECTION", "COMPLICATION_MANAGEMENT"] },
  { title: "Rehabilitation & Therapies", cats: ["PHYSICAL_THERAPY", "OCCUPATIONAL_THERAPY", "SPEECH_THERAPY", "COGNITIVE_THERAPY"] },
  { title: "Diagnostics & Laboratory", cats: ["IMAGING", "LABS"] },
  { title: "Medications & Supplies", cats: ["MEDICATION", "SUPPLIES"] },
  { title: "Durable Medical Equipment, Orthotics & Home Modifications", cats: ["DME", "ORTHOTICS_PROSTHETICS", "MOBILITY_AID", "HOME_MODIFICATION", "VEHICLE_MODIFICATION", "ASSISTIVE_TECH"] },
  { title: "Attendant & Facility Care", cats: ["ATTENDANT_CARE", "SKILLED_NURSING", "CASE_MANAGEMENT"] },
  { title: "Vocational, Transportation & Other", cats: ["VOCATIONAL_REHAB", "TRANSPORTATION", "MISC"] },
];

const ABBREVIATIONS: [string, string][] = [
  ["ADL", "activities of daily living"],
  ["CPT", "Current Procedural Terminology"],
  ["DME", "durable medical equipment"],
  ["FCE", "functional capacity evaluation"],
  ["ICD-10", "International Classification of Diseases, 10th revision"],
  ["MMI", "maximum medical improvement"],
  ["ODG", "Official Disability Guidelines"],
  ["PV", "present value"],
  ["RDMP", "reasonable degree of medical probability"],
  ["ROM", "range of motion"],
];

// Methodology texts that are always disclosed; the specific pricing, guideline,
// and evidence SOURCES are drawn per-case from the reference registry so the
// appendix lists only what the plan actually relied upon.
const METHODOLOGY_REFS = [
  "United States Social Security Administration actuarial life tables (ssa.gov/OACT).",
  "A Physician's Guide to Life Care Planning, AAPLCP (2017).",
  "Life Care Planning and Case Management Across the Lifespan, 5th ed. (ICHCC, 2024).",
  "Peer-reviewed clinical literature and the applicable specialty clinical practice guidelines, cited per recommendation.",
];

export interface ReportPayload {
  buffer: Buffer;
  totalLifetime: number;
  totalPresentValue: number;
  itemCount: number;
}

// ── Citations (clean academic form; no tool/AI phrasing) ─────────────────────
type Cite = { source?: string; title?: string; authors?: string; journal?: string; year?: string; pmid?: string; doi?: string; url?: string };
function citationList(citation: unknown): Cite[] {
  const arr = Array.isArray(citation) ? citation : citation ? [citation] : [];
  return (arr as Cite[]).filter((c) => c && c.title && (c.pmid || c.doi || c.url));
}
function citeId(c: Cite): string {
  if (c.pmid) return `PMID ${c.pmid}`;
  if (c.doi) return `doi:${c.doi}`;
  return c.url ?? "";
}
function oneCitation(c: Cite): string {
  const id = citeId(c);
  return `${c.authors ? `${c.authors}. ` : ""}${c.title}. ${c.journal ?? ""}${c.year ? ` ${c.year}` : ""}${id ? ` (${id})` : ""}.`.replace(/\s+/g, " ").trim();
}
function citationSentence(citation: unknown): string | null {
  const list = citationList(citation);
  if (!list.length) return null;
  return list.map(oneCitation).join("  ");
}

function freqText(i: { frequencyPerYear: number; isLifetime: boolean; durationYears: number | null }): string {
  if (!i.isLifetime && (i.durationYears ?? 0) <= 0) return "one-time";
  return `${i.frequencyPerYear}× per year`;
}
function durationText(i: { isLifetime: boolean; durationYears: number | null }, life: number): string {
  if (i.isLifetime) return `Lifetime (${life.toFixed(1)} yrs)`;
  if ((i.durationYears ?? 0) <= 0) return "One-time";
  return `${i.durationYears} year${i.durationYears === 1 ? "" : "s"}`;
}

export async function buildReportDocx(caseId: string, template: CaseSide): Promise<ReportPayload> {
  const c = await prisma.case.findUniqueOrThrow({
    where: { id: caseId },
    include: {
      firm: true,
      createdBy: { select: { name: true } },
      // Only the designated preparing physician's identity & credentials appear.
      preparingPhysician: { select: { name: true, role: true, credentialSummary: true, credentials: { select: { id: true, type: true, label: true, filename: true }, orderBy: { createdAt: "asc" } } } },
      chronologyEvents: { orderBy: { eventDate: "asc" } },
      conditions: { orderBy: { confidence: "desc" } },
      futureCareItems: { where: { supersededAt: null }, orderBy: { presentValue: "desc" } },
      reviewFindings: true,
      documents: { orderBy: { createdAt: "asc" } },
      treatingProviders: { where: { status: "CONFIRMED" }, orderBy: { createdAt: "asc" } },
      interviewFindings: { orderBy: { createdAt: "asc" } },
    },
  });

  // EPIC-011 — interviews woven into each recommendation's dossier + a Current
  // Complaints section. Provider names resolved for provider opinions.
  const providerName = new Map(c.treatingProviders.map((p) => [p.id, `${p.name}${p.credentials ? `, ${p.credentials}` : ""}`]));
  const dossierInterviews = c.interviewFindings.map((f) => ({
    subject: f.subject as "PATIENT" | "PROVIDER",
    category: f.category,
    text: f.text,
    quote: f.quote,
    conditionId: f.conditionId,
    futureCareItemId: f.futureCareItemId,
    providerName: f.providerId ? providerName.get(f.providerId) ?? null : null,
  }));

  const a = assumptionsFor(c);
  const items = c.futureCareItems;
  const accepted = items.filter((i) => i.physicianStatus === "APPROVED" || i.physicianStatus === "MODIFIED");
  // ── Integrity / correction layer ───────────────────────────────────────────
  // A deterministic check maps each recommendation to the correct diagnosis by
  // body region, validates its coding/pricing, and decides — honestly — whether
  // it may enter the damages total. An item is included only when it is
  // region-matched, free of a critical coding defect, and either
  // physician-approved or record-supported and medically probable. "Offered for
  // confirmation" alone does NOT include an unsupported item.
  const hasRecordSupport = (rec: RecInput, matched: CondInput | null): boolean =>
    hasPatientRecordSupport(rec as unknown as FutureCareItem, matched as (CondInput & { evidenceSources?: unknown }) | null);
  const integrity = runIntegrityCheck({ recommendations: items as unknown as RecInput[], conditions: c.conditions as unknown as CondInput[], hasRecordSupport });
  const perItemOf = (it: FutureCareItem): PerItem => integrity.perItem.get(it as unknown as RecInput)!;
  const reportItems = items.filter((i) => perItemOf(i).includedInTotal);
  const excludedForReview = items.filter((i) => !perItemOf(i).includedInTotal);
  const reviewStarted = items.length > 0 && items.some((i) => i.physicianStatus !== "PENDING");
  const totalLifetime = reportItems.reduce((s, i) => s + i.lifetimeCost, 0);
  const totalPresentValue = reportItems.reduce((s, i) => s + i.presentValue, 0);
  const totalLow = reportItems.reduce((s, i) => s + i.lowCost, 0);
  const totalHigh = reportItems.reduce((s, i) => s + i.highCost, 0);

  const subject = subjectName(c.clientName, c.sex);
  // Graceful phrasing when the date of injury is not in the record, so prose
  // never reads "sustained on —".
  const doiText = c.dateOfInjury ? fmtDate(c.dateOfInjury) : "the date of injury";
  const nCare = reportItems.length;
  const careCategories = `${nCare} categor${nCare === 1 ? "y" : "ies"} of care`;
  const pr = pronoun(c.sex);
  const sexNoun = c.sex === "FEMALE" ? "woman" : c.sex === "MALE" ? "man" : "individual";
  const age = ageFrom(c.dateOfBirth);
  const life = a.lifeExpectancyYears;
  const preExisting = parseConditions(c.preExistingConditions);
  const addlDx = (Array.isArray(c.additionalDiagnoses) ? c.additionalDiagnoses : []) as { diagnosis?: string; icd10Code?: string }[];
  const primaryDx = [c.diagnosis, ...addlDx.map((d) => d?.diagnosis)].filter(Boolean).join("; ") || "the injuries at issue";
  const templateLabel = template === "DEFENSE" ? "Defense Medical Review" : template === "NEUTRAL" ? "Neutral Medical Evaluation" : "Life Care Plan";
  const docById = new Map(c.documents.map((d) => [d.id, d]));
  const condById = new Map(c.conditions.map((x) => [x.id, x]));
  const catCount = new Set(reportItems.map((i) => i.category)).size;
  // Authorship: the designated preparing physician when set (their name,
  // credentials, and signature appear — and ONLY theirs); otherwise the case
  // creator, with no credentials rendered.
  const preparerName = c.preparingPhysician?.name ?? c.createdBy?.name ?? "the undersigned";
  const preparerCredentials = c.preparingPhysician?.credentials ?? [];
  const preparerCredSummary = c.preparingPhysician?.credentialSummary?.trim() ?? null;
  const preparer = preparerName;
  const icdFor = (name: string): string => {
    if (c.diagnosis && name.toLowerCase() === c.diagnosis.toLowerCase()) return c.icd10Code || "";
    const m = addlDx.find((d) => d.diagnosis && d.diagnosis.toLowerCase() === name.toLowerCase());
    return m?.icd10Code || "";
  };

  // ── Per-recommendation: a patient-specific rationale, then a compact spec
  //    table. The supporting diagnosis is taken from the integrity mapping (by
  //    body region), NOT the stored primary-condition default. To keep the
  //    section readable, the full "In my opinion…" narrative and the
  //    natural-history sentence are reserved for high-cost / complex items;
  //    routine items get a single specific sentence (§9). ──────────────────────
  const MAJOR_ITEM_PV = 100_000;
  const adultPatient = age == null ? true : age >= 18;
  // Each recommendation is a complete, physician-quality dossier that can stand
  // on its own: medical necessity, structured probability, potential challenges,
  // organized & traceable supporting evidence, contradictory evidence, unknowns,
  // literature, and a clinical-confidence score. (Design unchanged — this is
  // content logic; the DOCX styling helpers are the same.)
  const dossierCase: DossierCase = { subject, pronounPoss: pr.poss, lifeExpectancyYears: life, adult: adultPatient };
  const evLines = (label: string, items: EvidenceItem[], cap2 = 3) => {
    if (!items.length) return null;
    return labeled(label, items.slice(0, cap2).map((e) => `${e.text.replace(/\s+/g, " ").trim()}${e.source ? ` (${e.source})` : ""}`).join("; "));
  };
  function careRecommendation(it: FutureCareItem): (Paragraph | Table)[] {
    const per = perItemOf(it);
    const cond = per.mapping.condition as unknown as (typeof c.conditions)[number] | null;
    const dxName = cond?.name || c.diagnosis || "the injuries at issue";
    const recordSupport = hasRecordSupport(it as unknown as RecInput, cond as unknown as CondInput | null);
    const dossier = buildRecommendationDossier(it as never, cond as unknown as DossierCondition | null, c.chronologyEvents as unknown as DossierChronoEvent[], dossierCase, dossierInterviews as never);
    const out: (Paragraph | Table)[] = [];
    out.push(new Paragraph({ spacing: { before: 260, after: 60 }, keepNext: true, children: [new TextRun({ text: it.service, bold: true, size: 22, color: NAVY })] }));

    // Spec table — frequency, duration, lifetime quantity, cost, coding, status.
    const years = it.isLifetime ? life : it.durationYears ?? 0;
    const lifetimeQty = Math.round(it.frequencyPerYear * Math.max(0, years)) || (years === 0 ? 1 : 0);
    out.push(
      specGrid([
        ["Supporting diagnosis", dxName],
        ["Specialty", it.specialty || "—"],
        ["Frequency", freqText(it)],
        ["Duration", durationText(it, life)],
        ["Lifetime quantity", lifetimeQty > 0 ? `${lifetimeQty}` : "one-time"],
        ["CPT", it.cptCode || (per.code.status === "Missing code" ? "Pending coding review" : "—")],
        ["Unit cost", money(it.unitCost)],
        ["Projected lifetime cost", `${money(it.lifetimeCost)} (inflation-adjusted)`],
        ["Present value", money(it.presentValue)],
        ["Physician review", reviewLabel(it.physicianStatus, recordSupport)],
      ]),
    );

    // Medical necessity — the physician narrative (why, patient-specific).
    out.push(new Paragraph({ spacing: { before: 120, after: 40 }, children: [new TextRun({ text: "Medical necessity.", bold: true, size: 21, color: NAVY })] }));
    out.push(p(dossier.medicalNecessity));

    // Probability assessment (structured + percentage).
    const probPresent = dossier.probability.factors.filter((f) => f.present).map((f) => lc(f.label));
    out.push(labeled("Probability", `${dossier.probability.statement}${probPresent.length ? ` This assessment is supported by ${probPresent.join(", ")}.` : ""}`));

    // Supporting clinical evidence — organized and source-traceable.
    const se = dossier.supportingEvidence;
    const evBlock = [
      evLines("Supporting objective findings", se.objectiveFindings),
      evLines("Supporting imaging", se.imaging),
      evLines("Supporting examination findings", se.examination),
      evLines("Supporting functional limitations", se.functionalLimitations),
      evLines("Supporting prior treatment", se.priorTreatment),
      evLines("Supporting treating-physician documentation", se.physicianDocumentation),
      evLines("Supporting clinical guidelines", se.guidelines),
    ].filter(Boolean) as Paragraph[];
    out.push(...evBlock);

    // Applicable treatment-guideline sources (ODG first, then specialty-apt) —
    // the basis on which medical necessity now/in future is assessed (§9).
    const guideBasis = guidelineSourcesFor(it.category as CareCategory, bodyRegion(`${it.service} ${dxName}`)).slice(0, 3).map((s) => s.label);
    if (guideBasis.length) out.push(labeled("Guideline basis", `${guideBasis.join("; ")} — applied to determine whether this care is medically necessary now or in the future.`));

    // Literature — each article stating exactly what it supports + limitations.
    if (dossier.literature.length) {
      for (const l of dossier.literature) {
        out.push(
          new Paragraph({
            spacing: { after: 60, line: 288 },
            indent: { left: 240 },
            children: [
              new TextRun({ text: `${l.authors ? `${l.authors}. ` : ""}${l.title}. ${l.journal ?? ""}${l.year ? ` ${l.year}` : ""}${l.pmid ? ` (PMID ${l.pmid})` : l.doi ? ` (doi:${l.doi})` : ""}. `, size: 19, color: INK }),
              new TextRun({ text: `${l.studyType}. Supports ${lc(l.supports)}.${l.limitations ? ` Limitation: ${lc(l.limitations)}.` : ""}`, size: 18, italics: true, color: GREY }),
            ],
          }),
        );
      }
    } else {
      out.push(sourceLine("Direct published literature specific to this recommendation is limited; it rests on the applicable clinical guidance and the treating record."));
    }

    // Contradictory evidence, unknowns, potential challenges — never hidden.
    if (dossier.contradictoryEvidence.length) out.push(labeled("Contradictory evidence", dossier.contradictoryEvidence.slice(0, 3).join(" ")));
    if (dossier.unknowns.length) out.push(labeled("Unknowns", dossier.unknowns.slice(0, 3).join(" ")));
    out.push(labeled("Potential challenges", dossier.potentialChallenges.slice(0, 4).join(" ")));

    // Functional basis (§12) — the documented limitation this care addresses.
    if (dossier.functionalLink) {
      const fl = dossier.functionalLink;
      out.push(labeled("Functional basis", `${fl.domain} — ${fl.limitation}${fl.source ? ` (${fl.source})` : ""}${fl.quantified ? "; quantified in the record" : ""}. ${fl.relationship}`));
    }

    // Staged / conditional (§10) — trigger, prerequisite, timing, and whether it
    // replaces another recommendation or is a contingency only.
    const staged = [
      it.startTrigger && `Trigger: ${it.startTrigger}`,
      it.prerequisite && `Prerequisite: ${it.prerequisite}`,
      it.earliestTiming && `Earliest expected timing: ${it.earliestTiming}`,
      it.replacesService && `Replaces if triggered: ${it.replacesService}`,
      it.contingencyOnly && "Disclosed as a contingency — not entered into the totals",
    ].filter(Boolean) as string[];
    if (staged.length) out.push(labeled("Staged / conditional", staged.join(". ") + "."));

    // Clinical confidence.
    out.push(labeled("Clinical confidence", `${dossier.confidence.level}. ${dossier.confidence.explanation}`));

    // Recommendation consistency — whether another recommendation conflicts with
    // this one, and how the conflict was resolved (§16).
    const cnote = integrity.consistency.notes.get(it.id);
    if (cnote && cnote.conflictsWith.length) {
      const rel =
        cnote.relationship === "mutually_exclusive" ? "is mutually exclusive with"
          : cnote.relationship === "sequential" ? "is sequenced with"
          : cnote.relationship === "duplicate" ? "overlaps with"
          : "relates to";
      const uniq = [...new Set(cnote.conflictsWith)];
      out.push(labeled("Recommendation consistency", `This recommendation ${rel} ${uniq.join(", ")}.${cnote.resolution ? ` ${cnote.resolution}` : ""}`));
    }
    return out;
  }

  const body: (Paragraph | Table)[] = [];

  // ══ TITLE PAGE ═══════════════════════════════════════════════════════════════
  // §10 — when a critical validation issue remains unresolved, the document is a
  // DRAFT (visible banner on the title page and in the running header).
  const isDraft = integrity.blocking;
  if (isDraft) body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200, after: 200 }, children: [new TextRun({ text: "DRAFT — CONTAINS UNRESOLVED CRITICAL VALIDATION ISSUES · NOT FOR SERVICE", bold: true, size: 24, color: "B91C1C" })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: isDraft ? 200 : 720, after: 40 }, children: [new TextRun({ text: c.firm.letterhead || c.firm.name, bold: true, size: 26, color: NAVY })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 480 }, children: [new TextRun({ text: c.firm.letterhead ? "" : "Certified Life Care Planning", size: 20, color: GREY })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 360, after: 20 }, children: [new TextRun({ text: "LIFE CARE PLAN", bold: true, size: 40, color: INK })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [new TextRun({ text: "& Future Medical Cost Analysis", size: 30, color: INK })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 520 }, border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: NAVY, space: 8 } }, children: [new TextRun({ text: templateLabel === "Life Care Plan" ? "" : templateLabel, italics: true, size: 24, color: GREY })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 30 }, children: [new TextRun({ text: "Prepared with respect to", size: 20, color: GREY })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [new TextRun({ text: c.clientName, bold: true, size: 30, color: NAVY })] }));
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 400 }, children: [new TextRun({ text: `Date of Injury: ${fmtDate(c.dateOfInjury)}`, size: 20, color: INK })] }));
  body.push(
    new Table({
      width: { size: 76, type: WidthType.PERCENTAGE },
      alignment: AlignmentType.CENTER,
      borders: tableBorders(),
      rows: (
        [
          ["Patient", `${c.clientName}${age != null ? `, age ${age}` : ""}`],
          ["Date of Birth", fmtDate(c.dateOfBirth)],
          ["Date of Injury", fmtDate(c.dateOfInjury)],
          ["Matter", c.caseType.replace(/_/g, " ").toLowerCase()],
          ["Jurisdiction", c.jurisdiction || "—"],
          ["File Number", c.caseNumber],
          ["Prepared By", `${preparer}, ${c.firm.name}`],
          ["Report Date", fmtDate(new Date())],
        ] as [string, string][]
      ).map(([k, v]) => rowOf([td(k, { bold: true, width: 38, fill: SOFT }), td(v, { width: 62 })])),
    }),
  );
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 560 }, children: [new TextRun({ text: "CONFIDENTIAL — PREPARED IN ANTICIPATION OF LITIGATION", size: 18, color: GREY, bold: true })] }));

  // ══ EXECUTIVE SUMMARY ════════════════════════════════════════════════════════
  body.push(h1("Executive Summary", { pageBreak: true }));
  body.push(
    p(
      `I have been asked to evaluate the future medical care that ${subject}, a ${age != null ? `${age}-year-old ` : ""}${sexNoun}, will more likely than not require as a result of the injuries ${pr.subj} sustained on ${doiText}${c.mechanism ? ` by mechanism of ${lc(c.mechanism)}` : ""}, and to reduce that care to a lifetime cost stated at present value. This report sets out that opinion. It rests on my review of the medical records identified herein, the objective findings they document, the natural history of the diagnoses at issue, and the published life-care-planning methodology described below.`,
    ),
  );
  body.push(
    p(
      `Reasoning from the record, it is my opinion, held to a reasonable degree of medical probability, that ${subject} will require the ${careCategories} set out in this plan across ${catCount} domain${catCount === 1 ? "" : "s"} of medicine. The reasonable and necessary future medical cost of that care is ${money(totalPresentValue)} at present value, corresponding to ${money(totalLifetime)} in undiscounted future dollars over the ${life.toFixed(1)}-year projection horizon. Each recommendation is tied to a specific diagnosis, to the objective evidence supporting it, to the applicable clinical standard, and to a documented pricing basis, and is stated for the reviewing physician's confirmation.`,
    ),
  );
  body.push(h2("Summary of Key Facts"));
  body.push(
    factTable([
      ["Patient", `${c.clientName}${age != null ? `, age ${age}` : ""} (${sexNoun})`],
      ["Date & mechanism of injury", `${fmtDate(c.dateOfInjury)}${c.mechanism ? ` — ${lc(c.mechanism)}` : ""}`],
      ["Diagnoses at issue", `${primaryDx}${c.icd10Code ? ` (ICD-10 ${c.icd10Code})` : ""}`],
      ["Current functional status", c.functionalLimitations || (c.currentWorkStatus ? c.currentWorkStatus.toLowerCase() : "as documented in the treating records")],
      ["Remaining life expectancy", `${life.toFixed(1)} years (projection horizon)`],
      ["Categories of future care", `${reportItems.length}, across ${catCount} domain${catCount === 1 ? "" : "s"}`],
      ["Future medical cost — undiscounted", money(totalLifetime)],
      ["Future medical cost — present value", `${money(totalPresentValue)} (range ${money(totalLow)}–${money(totalHigh)})`],
    ]),
  );
  // §6 — an honest accounting of review status; does not imply universal sign-off.
  const ic = integrity.counts;
  body.push(
    p(
      `Of ${ic.proposed} recommendation${ic.proposed === 1 ? "" : "s"} proposed, ${ic.recordSupported} ${ic.recordSupported === 1 ? "is" : "are"} supported in the treating records and ${ic.physicianApproved} ${ic.physicianApproved === 1 ? "has" : "have"} been formally approved on physician review; ${ic.awaitingReview} ${ic.awaitingReview === 1 ? "remains" : "remain"} awaiting physician confirmation. ${ic.excluded === 0 ? "All proposed items met the threshold for inclusion in the total." : `${ic.excluded} item${ic.excluded === 1 ? " was" : "s were"} not included in the total pending further support, coding correction, or physician review, and ${ic.excluded === 1 ? "is" : "are"} disclosed in the Limitations.`}`,
      { size: BODY },
    ),
  );

  // ══ SYNOPSIS ═════════════════════════════════════════════════════════════════
  body.push(h1("Synopsis", { pageBreak: true }));
  const firstEvt = c.chronologyEvents[0];
  const lastEvt = c.chronologyEvents[c.chronologyEvents.length - 1];
  body.push(
    p(
      `${subject} is a ${age != null ? `${age}-year-old ` : ""}${sexNoun} who sustained ${lc(primaryDx)} on ${doiText}${c.mechanism ? `, the result of ${lc(c.mechanism)}` : ""}. ${cap(pr.subj)} came under medical care ${firstEvt ? `beginning ${fmtDate(firstEvt.eventDate)}` : "in the period that followed"} and has been followed through ${lastEvt ? fmtDate(lastEvt.eventDate) : "the date of the most recent records reviewed"}, as detailed in the medical chronology that follows.`,
    ),
  );
  body.push(
    p(
      `The reviewed records establish the diagnoses analyzed in this report and document the course of treatment ${subject} has undergone to date. Notwithstanding that treatment, the records reflect residual impairment that, in my opinion, will require ongoing and future medical care. The nature, frequency, duration, and cost of that care are the subject of this plan.`,
    ),
  );

  // ══ PURPOSE OF REPORT ════════════════════════════════════════════════════════
  body.push(h1("Purpose of Report", { pageBreak: true }));
  body.push(
    p(
      `The purpose of this report is to identify, to a reasonable degree of medical probability, the future medical care, services, equipment, and supplies that ${subject} will require as a result of the injuries at issue, and to state the reasonable cost of that care over ${pr.poss} remaining life expectancy. The plan is intended to assist the trier of fact in understanding the nature and extent of ${subject}'s future medical needs and their associated cost.`,
    ),
  );
  body.push(
    p(
      `A life care plan is a dynamic document. This report reflects the records and information available to me at the time of its preparation, and I reserve the right to supplement or amend my opinions should additional records, examinations, or information become available.`,
    ),
  );

  // ══ QUALIFICATIONS OF REVIEWER ═══════════════════════════════════════════════
  body.push(h1("Qualifications of Reviewer", { pageBreak: true }));
  // EPIC-011 — when the preparer's seat carries a credential summary and/or
  // uploaded documents, render a real Glazer-style Qualifications paragraph and
  // reference the documents; otherwise the generic "under separate cover" text.
  const preparerCreds = preparerCredentials;
  const credSummary = preparerCredSummary;
  body.push(
    p(
      `This Life Care Plan was prepared by ${preparer} of ${c.firm.name}.${credSummary ? ` ${period(credSummary)}` : ""} The opinions expressed herein are offered to a reasonable degree of medical probability and are based upon my professional training and experience, my review of the records identified in this report, and the published life-care-planning methodology and clinical guidelines described in the section that follows.`,
    ),
  );
  if (preparerCreds.length) {
    const CRED_LABEL: Record<string, string> = { BOARD_CERTIFICATION: "Board certification", CV: "Curriculum vitae", LICENSE: "License", OTHER: "Credential" };
    body.push(p(`My qualifications are documented in the following materials, appended to or produced with this report:`));
    for (const cr of preparerCreds) body.push(bullet(`${CRED_LABEL[cr.type] ?? "Credential"}${cr.label ? ` — ${cr.label}` : ""} (${cr.filename}).`));
    body.push(p(`A statement of compensation and a list of matters in which I have testified are available upon request.`));
  } else {
    body.push(
      p(
        `A curriculum vitae setting out my professional qualifications, certifications, publications, and prior testimony is available under separate cover and is incorporated by reference. A statement of compensation and a list of matters in which I have testified are likewise available upon request.`,
      ),
    );
  }

  // ══ METHODOLOGY ══════════════════════════════════════════════════════════════
  body.push(h1("Methodology", { pageBreak: true }));
  body.push(
    p(
      `I began by reviewing the ${c.documents.length} record set${c.documents.length === 1 ? "" : "s"} identified in the section that follows, totaling ${c.documents.reduce((s, d) => s + (d.pageCount || 0), 0)} pages. From those records I established the diagnoses and impairments at issue on the basis of the objective evidence — imaging, operative findings, physical examination, and diagnostic studies — rather than on subjective report alone.`,
    ),
  );
  body.push(
    p(
      `Having established the diagnoses, I identified the medical care each condition will more likely than not require over ${subject}'s remaining lifetime, applying the standards of the certified life-care-planning bodies together with the Official Disability Guidelines and the applicable specialty clinical practice guidelines for each diagnosis. Where the natural history, complication rate, or procedure survivorship of a condition bears on future need, I have relied upon the peer-reviewed literature, cited by recommendation.`,
    ),
  );
  body.push(
    p(
      `Unit costs are benchmarked to actual billed charges by procedure code and geography (FAIR Health), to the published Medicare fee schedules (CMS RVU, DMEPOS, and laboratory), and, for retail pharmaceuticals, to consumer pricing, adjusted by a geographic cost factor. Future costs are projected under a medical-inflation assumption and then discounted to present value. The economic assumptions are stated in the Assumptions section and their sensitivity is examined in the Cost Analysis.`,
    ),
  );
  body.push(
    p(
      `Throughout, I have applied the standard of reasonable medical probability: a service is included in the plan, and its cost totaled, only where it is more likely than not to be required. Care that is foreseeable but not more likely than not is disclosed as a contingency and is not included in the totals.`,
    ),
  );
  // EPIC-011 — record the interviews relied upon (Glazer-style), when present.
  {
    const hasPatient = c.interviewFindings.some((f) => f.subject === "PATIENT");
    const interviewedProviders = c.treatingProviders.filter((pv) => c.interviewFindings.some((f) => f.providerId === pv.id));
    if (hasPatient || interviewedProviders.length) {
      body.push(
        p(
          `In addition to the records, I have relied upon ${[hasPatient ? `an interview of ${subject}` : null, interviewedProviders.length ? `interview${interviewedProviders.length === 1 ? "" : "s"} of the treating ${interviewedProviders.length === 1 ? "provider" : "providers"} (${interviewedProviders.map((pv) => `${pv.name}${pv.credentials ? `, ${pv.credentials}` : ""}`).join("; ")})` : null].filter(Boolean).join(" and ")}. The patient's account of current complaints appears under Current Medical Status; interview findings pertinent to a specific recommendation are set out with that recommendation.`,
        ),
      );
    }
  }

  // ══ MEDICAL RECORDS REVIEWED ═════════════════════════════════════════════════
  body.push(h1("Medical Records Reviewed", { pageBreak: true }));
  body.push(p(`In forming the opinions expressed in this report, I reviewed and considered the following ${c.documents.length} record${c.documents.length === 1 ? "" : "s"}.`));
  if (c.documents.length) {
    const rr: TableRow[] = [
      rowOf([
        td("Date of Service", { header: true, width: 16 }),
        td("Provider", { header: true, width: 28 }),
        td("Specialty / Role", { header: true, width: 22 }),
        td("Record Type", { header: true, width: 24 }),
        td("Pages", { header: true, width: 10, align: AlignmentType.RIGHT }),
      ]),
    ];
    c.documents.forEach((d, i) => {
      const fill = i % 2 ? ALT : "FFFFFF";
      const provs = (Array.isArray(d.providers) ? d.providers : []) as { name: string; credentials?: string | null; role?: string | null }[];
      const dateCell = d.serviceDate ? (d.serviceDateEnd ? `${fmtDate(d.serviceDate)} – ${fmtDate(d.serviceDateEnd)}` : fmtDate(d.serviceDate)) : "—";
      const provCell = provs.length > 1 ? provs.map((pv) => `${pv.name}${pv.credentials ? `, ${pv.credentials}` : ""}`).join("; ") : d.authorName || "—";
      const roleCell = provs.length > 1 ? [...new Set(provs.map((pv) => pv.role).filter(Boolean))].join("; ") || "Multiple providers" : d.authorRole || "—";
      rr.push(
        rowOf([
          td(dateCell, { fill }),
          td(provCell, { fill }),
          td(roleCell, { fill }),
          td(typeLabel(d.type), { fill }),
          td(String(d.pageCount || "—"), { fill, align: AlignmentType.RIGHT }),
        ]),
      );
    });
    body.push(table(rr));
  } else {
    body.push(p("No records were available for review at the time of this report.", { italics: true }));
  }

  // ══ MEDICAL CHRONOLOGY ═══════════════════════════════════════════════════════
  body.push(h1("Medical Chronology", { pageBreak: true }));
  body.push(
    p(
      `The following chronology sets out the clinically significant encounters bearing on the diagnoses and future care at issue. It is not a recitation of every page in the record; rather, I have selected and organized the ${c.chronologyEvents.length} encounter${c.chronologyEvents.length === 1 ? "" : "s"} that inform my opinions. Each entry closes with my assessment of why the encounter matters to ${subject}'s future care.`,
    ),
  );
  if (!c.chronologyEvents.length) body.push(p("No clinical encounters were catalogued from the reviewed records.", { italics: true }));
  for (const e of c.chronologyEvents) {
    const src = e.sourceDocumentId ? docById.get(e.sourceDocumentId) : undefined;
    const header = `${mdY(e.eventDate)}${e.eventDateEnd ? ` – ${mdY(e.eventDateEnd)}` : ""}    ·    ${e.provider || "Treating provider"}${e.facility ? `, ${String(e.facility).replace(/[.\s]+$/, "")}` : ""}`;
    body.push(new Paragraph({ spacing: { before: 220, after: 40 }, keepNext: true, children: [new TextRun({ text: header, bold: true, size: 21, color: NAVY }), ...(e.recordType ? [new TextRun({ text: `    (${e.recordType})`, size: 18, italics: true, color: GREY })] : [])] }));
    const anySection = e.subjective || e.pastMedicalHistory || e.objectiveFindings || e.imagingFindings || e.diagnosis || e.treatment || e.procedure || e.medications || e.impairmentRating || e.disposition;
    if (e.subjective) body.push(labeled("Chief complaint", e.subjective));
    if (e.pastMedicalHistory) body.push(labeled("Past medical history", e.pastMedicalHistory));
    if (e.objectiveFindings) body.push(labeled("Objective findings", e.objectiveFindings));
    if (e.imagingFindings) body.push(labeled("Diagnostic studies", e.imagingFindings));
    if (e.diagnosis) body.push(labeled("Assessment", e.diagnosis));
    if (e.procedure) body.push(labeled("Procedure", e.procedure));
    if (e.treatment) body.push(labeled("Treatment / plan", e.treatment));
    if (e.medications) body.push(labeled("Medications", e.medications));
    if (e.impairmentRating) body.push(labeled("Impairment / MMI", e.impairmentRating));
    if (e.disposition) body.push(labeled("Disposition", e.disposition));
    if (!anySection) body.push(labeled("Summary", e.summary));
    if (e.functionalStatus) body.push(labeled("Functional impact", e.functionalStatus));
    if (e.restrictions || e.workStatus) body.push(labeled("Work restrictions", [e.restrictions, e.workStatus].filter(Boolean).join("; ")));
    body.push(labeled("Clinical significance", e.clinicalSignificance || `This encounter documents part of the treatment course for ${lc(primaryDx)} and informs the future care projected in this plan.`));
    body.push(sourceLine(`Source: ${src ? src.filename : "record on file"}${e.sourcePage ? `, p. ${e.sourcePage}` : ""}.`));
  }

  // ══ PRE-INJURY HISTORY ═══════════════════════════════════════════════════════
  body.push(h1("Pre-Injury History", { pageBreak: true }));
  if (preExisting.length) {
    body.push(
      p(
        `The reviewed records reflect the following pre-existing condition${preExisting.length === 1 ? "" : "s"}: ${preExisting.join("; ")}. I have considered ${preExisting.length === 1 ? "this condition" : "these conditions"} in forming my opinions. The available evidence does not permit a reliable quantitative apportionment; accordingly, the plan reflects only the care supportable from the record as attributable to the injuries at issue, and any formal apportionment is deferred to the trier of fact on a developed record.`,
      ),
    );
  } else {
    body.push(
      p(
        `The reviewed records do not document a material pre-injury history bearing on the injuries at issue. ${subject} is not shown to have required, prior to the incident, the categories of care projected in this plan. Accordingly, the future care set out herein is attributable to the injuries at issue rather than to any pre-existing condition.`,
      ),
    );
  }

  // ══ THE INCIDENT ═════════════════════════════════════════════════════════════
  body.push(h1("The Incident", { pageBreak: true }));
  body.push(
    p(
      `On ${doiText}, ${subject} sustained the injuries at issue${c.mechanism ? ` as a result of ${lc(c.mechanism)}` : ""}. ${firstEvt ? `${cap(pr.subj)} first came under medical care on ${fmtDate(firstEvt.eventDate)}${firstEvt.facility ? ` at ${String(firstEvt.facility).replace(/[.\s]+$/, "")}` : ""}, as documented in the chronology above.` : "The initial medical care following the incident is documented in the chronology above."} The mechanism and the injuries it produced are consistent with the diagnoses analyzed in this report.`,
    ),
  );

  // ══ POST-INJURY TREATMENT ════════════════════════════════════════════════════
  body.push(h1("Post-Injury Treatment", { pageBreak: true }));
  const proceduralEvents = c.chronologyEvents.filter((e) => e.procedure || e.eventType === "SURGERY" || e.eventType === "PROCEDURE");
  const treatmentList = proceduralEvents.slice(0, 8).map((e) => `${mdY(e.eventDate)} — ${e.procedure || e.treatment || e.summary}`);
  body.push(
    p(
      `Following the incident, ${subject} underwent the course of treatment detailed in the medical chronology. ${proceduralEvents.length ? `That course has included the significant interventions summarized below.` : `That course is documented across the encounters set out above.`} Notwithstanding this treatment, the records reflect residual impairment supporting the future care projected in this plan.`,
    ),
  );
  if (treatmentList.length) treatmentList.forEach((t) => body.push(bullet(t)));

  // ══ CURRENT MEDICAL STATUS ═══════════════════════════════════════════════════
  body.push(h1("Current Medical Status", { pageBreak: true }));
  body.push(
    p(
      `As of the most recent records reviewed, ${subject}'s medical status is as follows. ${c.functionalLimitations ? period(cap(c.functionalLimitations)) : `${cap(pr.poss)} functional limitations are documented across the treating records and are addressed in the Functional Assessment that follows.`} ${c.currentWorkStatus ? `${cap(pr.poss)} work status is ${lc(c.currentWorkStatus)}${c.currentWorkStatus === "Disabled" && c.disabilityReason ? `, ${lc(c.disabilityReason)}` : ""}.` : ""}`,
    ),
  );
  const activeConds = c.conditions.filter((x) => x.relatedness === "RELATED" || x.relatedness === "AGGRAVATION");
  if (activeConds.length) {
    body.push(
      p(
        `${cap(pr.subj)} remains under care for ${activeConds.map((x) => lc(x.name)).slice(0, 6).join("; ")}${activeConds.length > 6 ? "; and additional conditions set out below" : ""}. In my opinion, ${pr.poss} condition has reached a point at which the future course of care can be projected to a reasonable degree of medical probability.`,
      ),
    );
  }

  // EPIC-011 — Current Complaints, from the patient interview (only when present).
  const patientFindings = c.interviewFindings.filter((f) => f.subject === "PATIENT");
  if (patientFindings.length) {
    body.push(h2("Current Complaints"));
    const dates = [...new Set(patientFindings.map((f) => (f.interviewDate ? fmtDate(f.interviewDate) : null)).filter(Boolean))];
    body.push(p(`On interview${dates.length ? ` (${dates.join("; ")})` : ""}, ${subject} reported the following, in ${pr.poss} own account:`));
    // Group by category; free-text findings fall under "General".
    const byCat = new Map<string, typeof patientFindings>();
    for (const f of patientFindings) {
      const k = f.category || "General";
      byCat.set(k, [...(byCat.get(k) ?? []), f]);
    }
    for (const [catLabel, fs] of byCat) {
      const text = fs.map((f) => `${period(cap(f.text))}${f.quote ? ` ${subject} states: “${f.quote}”` : ""}`).join(" ");
      body.push(labeled(catLabel, text));
    }
  }

  // ══ FUNCTIONAL ASSESSMENT ════════════════════════════════════════════════════
  body.push(h1("Functional Assessment", { pageBreak: true }));
  const funcText = [c.functionalLimitations, ...c.chronologyEvents.map((e) => e.functionalStatus), ...c.chronologyEvents.map((e) => e.restrictions)].filter(Boolean).join(" ");
  body.push(
    p(
      `The functional consequences of ${subject}'s injuries are summarized below, drawn from the treating records and the chronology. Domains in which the records document impairment are identified; domains not separately quantified in the records are appropriate subjects for formal functional capacity evaluation, which would further objectify the basis for the corresponding care.`,
    ),
  );
  // Each domain carries the specific documented finding where present, and — for
  // gaps — the assessment appropriate to THAT domain (not a generic FCE for all).
  const DOMAINS: [string, RegExp, string][] = [
    ["Ambulation and gait", /walk|ambulat|gait|walker|cane|crutch/i, "a PT gait and balance assessment"],
    ["Stairs", /stair/i, "a PT functional-mobility assessment"],
    ["Lifting and carrying", /lift|carry/i, "a functional capacity evaluation (FCE)"],
    ["Sitting and standing tolerance", /\bsit|\bstand/i, "a functional capacity evaluation (FCE)"],
    ["Driving", /driv/i, "a driving evaluation"],
    ["Self-care and activities of daily living", /self-care|\badl|dress|bath|groom|toilet|transfer/i, "an OT / home ADL assessment"],
    ["Employment", /work|employ|\bjob|occupation|sedentary|light duty/i, "a functional capacity evaluation with vocational input"],
    ["Household activities", /household|chores|home ?maint|cook|clean|laundry|iadl/i, "an OT home-management assessment"],
    ["Bladder / urinary function", /bladder|urinary|incontinen|catheter|voiding|neurogenic bladder/i, "a urology evaluation"],
    ["Cognition", /cognit|memory|concentrat|attention|executive/i, "neuropsychological testing"],
    ["Psychological status", /depress|anxi|ptsd|mood|psych/i, "a psychological evaluation"],
    ["Pain", /pain/i, "a pain-management evaluation"],
    ["Range of motion", /range of motion|\brom\b|flexion|extension|mobility/i, "PT range-of-motion measurement"],
    ["Neurologic function", /numb|weak|neurolog|radicul|tingl|paresthes|sensor|reflex/i, "a neurologic / electrodiagnostic (EMG/NCS) evaluation"],
  ];
  const fr: TableRow[] = [rowOf([td("Functional domain", { header: true, width: 30 }), td("Classification", { header: true, width: 24 }), td("Documented finding / recommended assessment", { header: true, width: 46 })])];
  DOMAINS.forEach(([dom, re, evalRec], i) => {
    const fill = i % 2 ? ALT : "FFFFFF";
    const found = functionalFinding(funcText, re);
    const cls = found ? (found.quantified ? "Documented & quantified" : "Documented, not quantified") : "Not documented";
    const detail = found ? cap(found.snippet) : `Not addressed in the records; ${evalRec} would objectify this domain.`;
    fr.push(rowOf([td(dom, { bold: true, fill }), td(cls, { fill }), td(detail, { fill })]));
  });
  body.push(table(fr));

  // ══ TREATING PHYSICIAN DIAGNOSES ═════════════════════════════════════════════
  body.push(h1("Treating Physician Diagnoses", { pageBreak: true }));
  body.push(
    p(
      `The diagnoses at issue, established from the objective record, are set out below. For each, I state its objective basis and its relationship to the incident. The clinical necessity of the care each diagnosis supports — with its supporting and contradictory evidence, guidelines, and literature — is developed per recommendation in the Future Medical Needs section, which is the clinical centerpiece of this plan.`,
    ),
  );
  for (const cond of c.conditions) {
    const icd = icdFor(cond.name);
    const evSources = (Array.isArray(cond.evidenceSources) ? cond.evidenceSources : []) as { filename?: string; page?: number | null; quote?: string }[];
    body.push(new Paragraph({ spacing: { before: 220, after: 40 }, keepNext: true, children: [new TextRun({ text: cond.name, bold: true, size: 22, color: NAVY }), ...(icd ? [new TextRun({ text: `    ICD-10 ${icd}`, size: 18, color: GREY })] : [])] }));
    body.push(p(`In my opinion, ${lc(cond.name)} is ${relatednessText(cond.relatedness)}.`));
    if (cond.objectiveEvidence) body.push(labeled("Objective basis", cond.objectiveEvidence));
    if (evSources.length) body.push(sourceLine(`Evidence of record: ${evSources.map((s) => `${s.filename}${s.page ? `, p. ${s.page}` : ""}`).join("; ")}.`));
    if (cond.reasoning) body.push(p(period(cap(cond.reasoning))));
    if (cond.opposingRecords) body.push(labeled("Contrary evidence", cond.opposingRecords));
    if (cond.missingInfo) body.push(labeled("Outstanding records / specialist confirmation", cond.missingInfo));
  }

  // ══ FUTURE MEDICAL NEEDS & MEDICAL NECESSITY ═════════════════════════════════
  body.push(h1("Future Medical Needs & Medical Necessity", { pageBreak: true }));
  body.push(
    p(
      `Set out below are the categories of future medical care that, in my opinion and to a reasonable degree of medical probability, ${subject} will require as a result of the injuries at issue. For each, I state the basis for its medical necessity, the expected course of the need, and the reasonable cost. The care is organized by domain of medicine.`,
    ),
  );
  if (!reportItems.length) body.push(p(reviewStarted ? "No future-care items have been endorsed on physician review." : "No future-care recommendations have been generated for this case.", { italics: true }));
  for (const g of CATEGORY_GROUPS) {
    const groupItems = reportItems.filter((i) => g.cats.includes(i.category));
    if (!groupItems.length) continue;
    body.push(h2(g.title));
    for (const it of groupItems) body.push(...careRecommendation(it));
  }

  // ══ LIFE CARE PLAN — COST TABLES ═════════════════════════════════════════════
  body.push(h1("Life Care Plan", { pageBreak: true }));
  body.push(p(`The following schedule summarizes the projected future medical care by category. Costs are stated in present-day dollars; the lifetime figure is the inflation-adjusted cost over the ${life.toFixed(1)}-year horizon, and present value is that figure discounted at ${(a.discountRate * 100).toFixed(1)}%.`));
  const lcpRows: TableRow[] = [
    rowOf([
      td("Service / Item", { header: true, width: 32 }),
      td("CPT", { header: true, width: 9 }),
      td("Frequency", { header: true, width: 12 }),
      td("Unit", { header: true, width: 12, align: AlignmentType.RIGHT }),
      td("Lifetime", { header: true, width: 17, align: AlignmentType.RIGHT }),
      td("Present Value", { header: true, width: 18, align: AlignmentType.RIGHT }),
    ]),
  ];
  for (const g of CATEGORY_GROUPS) {
    const groupItems = reportItems.filter((i) => g.cats.includes(i.category));
    if (!groupItems.length) continue;
    lcpRows.push(rowOf([td(g.title, { bold: true, fill: SOFT }), td("", { fill: SOFT }), td("", { fill: SOFT }), td("", { fill: SOFT }), td("", { fill: SOFT }), td("", { fill: SOFT })]));
    groupItems.forEach((i, k) => {
      const fill = k % 2 ? ALT : "FFFFFF";
      lcpRows.push(
        rowOf([
          td(i.service, { fill }),
          td(i.cptCode || "—", { fill }),
          td(freqText(i), { fill }),
          td(money(i.unitCost), { fill, align: AlignmentType.RIGHT }),
          td(money(i.lifetimeCost), { fill, align: AlignmentType.RIGHT }),
          td(money(i.presentValue), { fill, align: AlignmentType.RIGHT }),
        ]),
      );
    });
    const subL = groupItems.reduce((s, i) => s + i.lifetimeCost, 0);
    const subP = groupItems.reduce((s, i) => s + i.presentValue, 0);
    lcpRows.push(rowOf([td(`Subtotal — ${g.title}`, { bold: true, fill: SOFT }), td("", { fill: SOFT }), td("", { fill: SOFT }), td("", { fill: SOFT }), td(money(subL), { bold: true, fill: SOFT, align: AlignmentType.RIGHT }), td(money(subP), { bold: true, fill: SOFT, align: AlignmentType.RIGHT })]));
  }
  lcpRows.push(rowOf([td("TOTAL FUTURE MEDICAL CARE", { header: true }), td("", { header: true }), td("", { header: true }), td("", { header: true }), td(money(totalLifetime), { header: true, align: AlignmentType.RIGHT }), td(money(totalPresentValue), { header: true, align: AlignmentType.RIGHT })]));
  body.push(table(lcpRows));

  // ══ COST ANALYSIS ════════════════════════════════════════════════════════════
  body.push(h1("Cost Analysis", { pageBreak: true }));
  body.push(
    p(
      `The reasonable future medical cost of the care set out in this plan is ${money(totalPresentValue)} at present value, corresponding to ${money(totalLifetime)} in undiscounted future dollars. To account for reasonable variation in utilization and pricing, I have also computed a lower and higher scenario, as follows.`,
    ),
  );
  body.push(
    table([
      rowOf([td("Scenario", { header: true, width: 30 }), td("Basis", { header: true, width: 44 }), td("Present Value", { header: true, width: 26, align: AlignmentType.RIGHT })]),
      rowOf([td("Lower", { fill: ALT }), td("Conservative utilization and pricing", { fill: ALT }), td(money(totalLow), { fill: ALT, align: AlignmentType.RIGHT })]),
      rowOf([td("Expected", { bold: true }), td("Most-probable utilization at benchmark pricing", { bold: true }), td(money(totalPresentValue), { bold: true, align: AlignmentType.RIGHT, color: NAVY })]),
      rowOf([td("Higher", { fill: ALT }), td("Higher utilization and pricing", { fill: ALT }), td(money(totalHigh), { fill: ALT, align: AlignmentType.RIGHT })]),
    ]),
  );
  body.push(h2("Sensitivity to Economic Assumptions"));
  body.push(caption(`Present value of the plan under alternative discount and medical-inflation rates. The expected case is shown in bold.`));
  const discs = [a.discountRate - 0.01, a.discountRate, a.discountRate + 0.01];
  const infls = [a.medicalInflation - 0.01, a.medicalInflation, a.medicalInflation + 0.01];
  const pvUnder = (disc: number, infl: number) =>
    reportItems.reduce((s, it) => s + project({ category: it.category, unitCost: it.unitCost, frequencyPerYear: it.frequencyPerYear, durationYears: it.durationYears, isLifetime: it.isLifetime }, { lifeExpectancyYears: life, discountRate: disc, medicalInflation: infl, geographicFactor: 1 }).presentValue, 0);
  const sens: TableRow[] = [rowOf([td("Discount ↓ / Inflation →", { header: true, width: 28 }), ...infls.map((inf) => td(`${(inf * 100).toFixed(1)}%`, { header: true, width: 24, align: AlignmentType.RIGHT }))])];
  for (const disc of discs) {
    sens.push(
      rowOf([
        td(`${(disc * 100).toFixed(1)}%`, { bold: true, fill: SOFT }),
        ...infls.map((inf) => {
          const isBase = Math.abs(disc - a.discountRate) < 1e-9 && Math.abs(inf - a.medicalInflation) < 1e-9;
          return td(money(pvUnder(disc, inf)), { align: AlignmentType.RIGHT, bold: isBase, color: isBase ? NAVY : undefined, fill: isBase ? SOFT : undefined });
        }),
      ]),
    );
  }
  body.push(table(sens));

  // ══ ASSUMPTIONS ══════════════════════════════════════════════════════════════
  body.push(h1("Assumptions", { pageBreak: true }));
  body.push(p(`The projections in this plan rest on the following assumptions, each stated so that the reader may test them.`));
  body.push(bullet(`A remaining life expectancy of ${life.toFixed(1)} years is applied as the projection horizon for all lifetime care, drawn from the United States Social Security Administration actuarial tables.`));
  body.push(bullet(`Future costs are grown at a medical-inflation rate of ${(a.medicalInflation * 100).toFixed(1)}% per year and discounted to present value at ${(a.discountRate * 100).toFixed(1)}% per year.`));
  body.push(bullet(`A geographic cost factor of ${a.geographicFactor.toFixed(2)} is applied to reflect regional pricing.`));
  body.push(bullet(`Only care that is more likely than not to be required is included in the totals; foreseeable but less-than-probable care is disclosed separately in the Limitations.`));
  body.push(bullet(`Each recommendation remains subject to the reviewing physician's confirmation of medical necessity.`));

  // ══ DISCUSSION ═══════════════════════════════════════════════════════════════
  body.push(h1("Discussion", { pageBreak: true }));
  const related = c.conditions.filter((x) => x.relatedness === "RELATED");
  const aggravations = c.conditions.filter((x) => x.relatedness === "AGGRAVATION");
  body.push(
    p(
      `Taking the record as a whole, it is my opinion, to a reasonable degree of medical probability, that ${subject}'s injuries were caused by the incident ${c.dateOfInjury ? `of ${fmtDate(c.dateOfInjury)}` : "in question"} and that ${pr.subj} will require the future medical care set out in this plan as a consequence. Of the ${c.conditions.length} condition${c.conditions.length === 1 ? "" : "s"} I have analyzed, ${related.length} ${related.length === 1 ? "is" : "are"} causally related to the incident${aggravations.length ? ` and ${aggravations.length} represent${aggravations.length === 1 ? "s" : ""} aggravation of a pre-existing condition` : ""}. My projections are driven by those conditions.`,
    ),
  );
  if (aggravations.length) {
    body.push(
      p(
        `Where a pre-existing condition was aggravated by the incident — namely ${aggravations.map((x) => lc(x.name)).join("; ")} — the plan reflects the care supportable from the record as attributable to the aggravation. The available evidence does not permit a reliable quantitative apportionment of the incremental need; that determination is reserved to the trier of fact on a developed record.`,
      ),
    );
  }
  body.push(
    p(
      `The plan is comprehensive of the domains of care the record supports, and each recommendation is anchored to a specific diagnosis, to the objective evidence, to the governing clinical standard, and to a documented cost basis. Taken together, the care represents, in my opinion, the reasonable and necessary future medical treatment of ${subject}'s injuries over ${pr.poss} remaining lifetime.`,
    ),
  );

  // ══ LIMITATIONS ══════════════════════════════════════════════════════════════
  body.push(h1("Limitations", { pageBreak: true }));
  body.push(
    p(
      `This report is based upon the records and information available to me at the time of its preparation. Should additional records, diagnostic studies, examinations, or physician opinions become available, I reserve the right to supplement or revise my opinions accordingly.`,
    ),
  );
  const speculative = reportItems.filter((i) => i.probability === "SPECULATIVE" || i.probability === "NOT_SUPPORTED");
  if (speculative.length || excludedForReview.length) {
    body.push(
      p(
        `The following contingencies are foreseeable but, in my opinion, are not more likely than not to be required. They are disclosed for completeness and are excluded from the totals stated above:`,
      ),
    );
    for (const i of speculative) body.push(bullet(`${i.service}${i.missingSupport ? ` — ${lc(i.missingSupport)}` : ""}.`));
    for (const i of excludedForReview) body.push(bullet(`${i.service} — ${i.physicianStatus === "REJECTED" ? "not endorsed on physician review" : "pending physician confirmation"}.`));
  }
  body.push(
    p(
      `Finally, the cost of any unanticipated surgical or procedural complication, and any acceleration of care should a condition progress faster than expected, is not included in the totals and would be additive.`,
    ),
  );

  // ══ CONCLUSIONS ══════════════════════════════════════════════════════════════
  body.push(h1("Conclusions", { pageBreak: true }));
  body.push(
    p(
      `Based upon my review of the medical records identified in this report, and to a reasonable degree of medical probability, it is my opinion that ${subject} will require the future medical care set out in this Life Care Plan as a result of the injuries sustained on ${doiText}. The reasonable and necessary cost of that care is ${money(totalPresentValue)} at present value (${money(totalLifetime)} undiscounted) over ${pr.poss} remaining life expectancy of ${life.toFixed(1)} years.`,
    ),
  );
  body.push(
    p(
      `The opinions expressed herein are held to a reasonable degree of medical probability and are subject to revision should additional information become available. Each recommendation is offered for the confirmation of the reviewing physician.`,
    ),
  );
  body.push(new Paragraph({ spacing: { before: 480, after: 40 }, children: [new TextRun({ text: "Respectfully submitted,", size: BODY, color: INK })] }));
  body.push(new Paragraph({ spacing: { before: 360 }, children: [new TextRun({ text: "______________________________________", size: BODY })] }));
  body.push(new Paragraph({ children: [new TextRun({ text: preparer, bold: true, size: BODY, color: INK })] }));
  body.push(new Paragraph({ children: [new TextRun({ text: c.firm.name, size: BODY, color: INK })] }));
  body.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: fmtDate(new Date()), size: CAPTION, color: GREY })] }));

  // ══ APPENDIX A — REFERENCES ══════════════════════════════════════════════════
  body.push(h1("Appendix A — References Relied Upon", { pageBreak: true }));
  // Only the sources this plan actually relied upon: the guideline/evidence and
  // pricing sources for the care categories present, plus the methodology texts.
  const planCategories = [...new Set(reportItems.map((i) => i.category as CareCategory))];
  referencesFor(planCategories, { includeGuidelines: true }).forEach((s) => body.push(bullet(s.citation)));
  METHODOLOGY_REFS.forEach((r) => body.push(bullet(r)));

  // ══ APPENDIX B — ABBREVIATIONS ═══════════════════════════════════════════════
  body.push(h1("Appendix B — Abbreviations", { pageBreak: true }));
  for (const [ab, meaning] of ABBREVIATIONS) body.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: `${ab}   `, bold: true, size: BODY, color: NAVY }), new TextRun({ text: meaning, size: BODY, color: INK })] }));

  // ══ APPENDIX C — PHYSICIAN REVIEW & ENDORSEMENT ══════════════════════════════
  body.push(h1("Appendix C — Physician Review & Endorsement", { pageBreak: true }));
  body.push(p(`Each recommendation is submitted to the reviewing physician for endorsement, with the option to approve, decline, or modify the frequency, duration, or medical-necessity basis, and to sign.`));
  for (const it of reportItems) {
    body.push(new Paragraph({ spacing: { before: 200, after: 30 }, keepNext: true, children: [new TextRun({ text: it.service, bold: true, size: 21, color: INK })] }));
    body.push(new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: "☐  Approve        ☐  Decline        ☐  Modify", size: 21 })] }));
    body.push(new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: "Frequency / duration adjustment: __________________________________________________", size: 20, color: INK })] }));
    body.push(new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: "Comment: ________________________________________________________________________", size: 20, color: INK })] }));
    body.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: "Physician signature: ______________________________     Date: ________________", size: 20, color: INK })] }));
  }

  // ══ APPENDIX D — EVIDENCE TRACEABILITY ═══════════════════════════════════════
  body.push(h1("Appendix D — Evidence Traceability", { pageBreak: true }));
  body.push(p(`Each recommendation in this plan traces to its supporting diagnosis, the records that establish it, the governing literature, and its cost basis, so that no conclusion stands unsupported.`));
  const traceRows: TableRow[] = [
    rowOf([
      td("Recommendation", { header: true, width: 24 }),
      td("Diagnosis", { header: true, width: 20 }),
      td("Records", { header: true, width: 20 }),
      td("Literature / Guideline", { header: true, width: 20 }),
      td("Cost Basis", { header: true, width: 16 }),
    ]),
  ];
  reportItems.forEach((it, i) => {
    const cond = it.conditionId ? condById.get(it.conditionId) : undefined;
    const fill = i % 2 ? ALT : "FFFFFF";
    traceRows.push(
      rowOf([
        td(it.service, { fill }),
        td(cond?.name || c.diagnosis || "—", { fill }),
        td(cond?.supportingRecords || "Chronology & records index", { fill }),
        td(it.literatureSupport || it.evidenceStrength || "Case-specific", { fill }),
        td(it.pricingSource || "UCR benchmark", { fill }),
      ]),
    );
  });
  body.push(table(traceRows));

  // ══ APPENDIX E — METHODOLOGICAL BASIS (DAUBERT) ══════════════════════════════
  body.push(h1("Appendix E — Methodological Basis", { pageBreak: true }));
  body.push(p(`The methodology applied in this report satisfies the recognized indicia of reliability for expert opinion:`));
  const daubert: [string, string][] = [
    ["Testability", "The life-care-planning methodology applied here is published and testable, and has been the subject of peer-reviewed literature since 1992."],
    ["Peer review", "The methodology is grounded in peer-reviewed texts and the standards of the certified life-care-planning bodies."],
    ["Known error rate", "Only services, studies, and equipment reasonably probable to be required are included, and the standard of reasonable medical probability is applied throughout and disclosed."],
    ["General acceptance", "Certification in life care planning is the recognized credential for this discipline in all fifty states and in the federal courts."],
    ["Relevance", "The plan predicts, to a reasonable degree of medical probability, the medical services and equipment required to treat the injuries at issue over the remaining life expectancy."],
  ];
  for (const [q, ans] of daubert) body.push(new Paragraph({ spacing: { after: 90, line: 288 }, alignment: AlignmentType.JUSTIFIED, children: [new TextRun({ text: `${q}.  `, bold: true, size: BODY, color: NAVY }), new TextRun({ text: ans, size: BODY, color: INK })] }));

  // ══ APPENDIX F — LIFE CARE PLAN INTEGRITY CHECK ══════════════════════════════
  body.push(h1("Appendix F — Life Care Plan Integrity Check", { pageBreak: true }));
  body.push(p(`Before export, each recommendation is validated for diagnosis/region mapping, coding and pricing consistency, record and physician support, and inclusion in the total. Items with an unresolved critical issue are excluded from the total and, where noted, block final export until corrected.`));
  if (!integrity.findings.length) {
    body.push(p("No integrity issues were identified. Every recommendation is region-matched, consistently coded and priced, and supported for inclusion.", { italics: true }));
  } else {
    const RED = "B91C1C";
    const sevColor: Record<string, string | undefined> = { Critical: RED, High: "B45309", Moderate: undefined, Low: undefined };
    const icRows: TableRow[] = [
      rowOf([
        td("Recommendation", { header: true, width: 22 }),
        td("Result", { header: true, width: 16 }),
        td("Issue", { header: true, width: 30 }),
        td("Severity", { header: true, width: 10 }),
        td("Suggested correction", { header: true, width: 22 }),
      ]),
    ];
    integrity.findings.forEach((f: IntegrityFinding, i) => {
      const fill = i % 2 ? ALT : "FFFFFF";
      icRows.push(
        rowOf([
          td(f.recommendation, { fill }),
          td(`${f.result}${f.exportBlocking ? " (blocks export)" : ""}`, { fill }),
          td(f.issue, { fill }),
          td(f.severity, { fill, bold: f.severity === "Critical", color: sevColor[f.severity] }),
          td(f.suggestedCorrection, { fill }),
        ]),
      );
    });
    body.push(table(icRows));
    if (integrity.blocking) body.push(p("One or more critical issues remain unresolved. This document is a DRAFT and is not to be served or relied upon until the issues above are corrected.", { bold: true, color: "B91C1C" }));
  }

  // ── Closing disclaimer ───────────────────────────────────────────────────────
  body.push(new Paragraph({ spacing: { before: 360, after: 80 }, border: { top: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 8 } }, children: [new TextRun({ text: "This Life Care Plan is based upon the past, present, and reasonably anticipated future medical needs of the patient, and upon the medical records available at the time of its preparation. Costs are stated at present-day values. Every recommendation is subject to the final professional judgment of the reviewing physician and the certified life care planner.", italics: true, size: 18, color: GREY })] }));

  // ── Running header / footer ──────────────────────────────────────────────────
  const runningHeader = new Header({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 4 } },
        spacing: { after: 120 },
        children: [
          ...(isDraft ? [new TextRun({ text: "DRAFT — ", bold: true, size: 16, color: "B91C1C" })] : []),
          new TextRun({ text: `${c.clientName}    |    Life Care Plan    |    ${fmtDate(new Date())}`, size: 16, color: GREY }),
          new TextRun({ text: "\tPage ", size: 16, color: GREY }),
          new TextRun({ children: [PageNumber.CURRENT], size: 16, color: GREY }),
          new TextRun({ text: " of ", size: 16, color: GREY }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: GREY }),
        ],
      }),
    ],
  });
  const runningFooter = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 4 } },
        children: [new TextRun({ text: "CONFIDENTIAL   ·   PREPARED IN ANTICIPATION OF LITIGATION", size: 15, color: GREY })],
      }),
    ],
  });
  const emptyHeader = new Header({ children: [new Paragraph({ children: [] })] });

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: BODY, color: INK } } } },
    sections: [
      {
        properties: {
          titlePage: true,
          page: { margin: { top: 1440, bottom: 1440, left: 1620, right: 1620, header: 720, footer: 620 } },
        },
        headers: { default: runningHeader, first: emptyHeader },
        footers: { default: runningFooter, first: runningFooter },
        children: body,
      },
    ],
  });
  const buffer = await Packer.toBuffer(doc);
  return { buffer, totalLifetime, totalPresentValue, itemCount: items.length };
}

export async function buildCostCsv(caseId: string): Promise<string> {
  const items = await prisma.futureCareItem.findMany({ where: { caseId, supersededAt: null }, orderBy: { presentValue: "desc" } });
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
