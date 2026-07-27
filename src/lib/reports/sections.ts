import { functionalFinding } from "@/lib/engine/integrity";
import type { Block } from "./doc";
import { originLabel } from "./data";
import type {
  ReportData,
  RDChronoEvent,
  RDCondition,
  RDEvidenceSource,
  RDFutureCareItem,
  RDAssessment,
} from "./data";

// ─────────────────────────────────────────────────────────────────────────────
// Report Library — pure section builders (docs/22 §2).
//
// Every function here is (data, config?) → Block[]. Every factual statement is
// drawn from a structured row of the case record; nothing is invented and no
// citation is fabricated. When a bucket is empty the section says so honestly
// rather than padding.
// ─────────────────────────────────────────────────────────────────────────────

export const NOT_DOCUMENTED = "Not documented in the records reviewed.";

/** Persisted ValidationFinding rows, passed in by the API layer. */
export interface RDValidationFinding {
  service: string;
  result: string;
  issue: string;
  severity: string;
  suggestion?: string | null;
  exportBlocking: boolean;
}

// ── Local pure formatting (mirrors report.ts conventions) ────────────────────

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const fmtDate = (d: Date | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "—";
const mdY = (d: Date | null | undefined) => {
  if (!d) return "—";
  const x = new Date(d);
  return `${String(x.getUTCMonth() + 1).padStart(2, "0")}/${String(x.getUTCDate()).padStart(2, "0")}/${x.getUTCFullYear()}`;
};

const p = (text: string, italics = false): Block => ({ kind: "p", text, italics });
const h2 = (text: string): Block => ({ kind: "h2", text });
const labeled = (label: string, text: string): Block => ({ kind: "labeled", label, text });
const bullet = (text: string): Block => ({ kind: "bullet", text });
const source = (text: string): Block => ({ kind: "source", text });
const notDocumented = (): Block[] => [p(NOT_DOCUMENTED, true)];

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strOf = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as { text?: unknown; note?: unknown; title?: unknown };
    if (typeof o.text === "string") return o.text;
    if (typeof o.note === "string") return o.note;
    if (typeof o.title === "string") return o.title;
  }
  return String(v ?? "");
};

const evidenceSourcesOf = (c: RDCondition): RDEvidenceSource[] =>
  asArray(c.evidenceSources).filter((s): s is RDEvidenceSource => !!s && typeof s === "object");

const REVIEW_LABEL: Record<string, string> = {
  APPROVED: "Physician approved",
  MODIFIED: "Physician approved with modification",
  REJECTED: "Physician rejected",
  PENDING: "Pending physician review",
};
const reviewText = (status: string | undefined) => REVIEW_LABEL[status ?? "PENDING"] ?? "Pending physician review";

function freqText(i: RDFutureCareItem): string {
  if (!i.isLifetime && (i.durationYears ?? 0) <= 0) return "one-time";
  return `${i.frequencyPerYear}× per year`;
}
function durationText(i: RDFutureCareItem, life: number | null | undefined): string {
  if (i.isLifetime) return life != null ? `Lifetime (${life.toFixed(1)} yrs)` : "Lifetime";
  if ((i.durationYears ?? 0) <= 0) return "One-time";
  return `${i.durationYears} year${i.durationYears === 1 ? "" : "s"}`;
}

function eventSource(data: ReportData, e: RDChronoEvent): string {
  const doc = e.sourceDocumentId ? data.case.documents.find((d) => d.id === e.sourceDocumentId) : undefined;
  return `Source: ${doc ? doc.filename : "record on file"}${e.sourcePage ? `, p. ${e.sourcePage}` : ""}.`;
}

const assessmentFor = (data: ReportData, item: RDFutureCareItem): RDAssessment | undefined =>
  data.assessments.find((a) => a.recommendationId === item.id) ??
  data.assessments.find((a) => a.recommendationService === item.service);

const includedItems = (data: ReportData): RDFutureCareItem[] =>
  data.case.futureCareItems.filter((i) => data.includedIds.has(i.id));
const excludedItems = (data: ReportData): RDFutureCareItem[] =>
  data.case.futureCareItems.filter((i) => !data.includedIds.has(i.id));

function classifyLabel(data: ReportData, item: RDFutureCareItem): string {
  for (const per of data.integrity.perItem.values()) {
    if ((per.rec as unknown as { id?: string }).id === item.id) return per.classify.label;
  }
  return reviewText(item.physicianStatus);
}

// ── Sections ─────────────────────────────────────────────────────────────────

/** Case identification facts — always the first section of a report. */
export function caseHeader(data: ReportData): Block[] {
  const c = data.case;
  return [
    {
      kind: "table",
      header: ["Item", "Detail"],
      rows: [
        ["Patient", c.clientName],
        ["Date of birth", fmtDate(c.dateOfBirth)],
        ["Date of injury", fmtDate(c.dateOfInjury)],
        ["Matter", c.caseType.replace(/_/g, " ").toLowerCase()],
        ["Jurisdiction", c.jurisdiction || "—"],
        ["File number", c.caseNumber],
        ["Prepared by", `${c.preparingPhysician?.name ?? c.createdBy?.name ?? "—"}, ${c.firm.name}`],
        ["Report date", fmtDate(new Date())],
      ],
    },
  ];
}

/** Counts and totals — included items only enter the money figures. */
export function executiveSummary(data: ReportData): Block[] {
  const c = data.case;
  const inc = includedItems(data);
  const totalLifetime = inc.reduce((s, i) => s + i.lifetimeCost, 0);
  const totalPV = inc.reduce((s, i) => s + i.presentValue, 0);
  const ic = data.integrity.counts;
  const byStatus = (s: string) => c.futureCareItems.filter((i) => i.physicianStatus === s).length;
  return [
    p(
      `The case record comprises ${c.documents.length} record set${c.documents.length === 1 ? "" : "s"}, ` +
        `${c.chronologyEvents.length} chronology encounter${c.chronologyEvents.length === 1 ? "" : "s"}, and ` +
        `${c.conditions.length} analyzed condition${c.conditions.length === 1 ? "" : "s"}.`,
    ),
    p(
      `Of ${ic.proposed} care recommendation${ic.proposed === 1 ? "" : "s"} proposed, ${inc.length} ${inc.length === 1 ? "is" : "are"} included in the totals: ` +
        `${money(totalLifetime)} in undiscounted future dollars and ${money(totalPV)} at present value. ` +
        `${ic.excluded} item${ic.excluded === 1 ? " is" : "s are"} disclosed but not totaled.`,
    ),
    p(
      `Physician review status: ${byStatus("APPROVED")} approved, ${byStatus("MODIFIED")} approved with modification, ` +
        `${byStatus("REJECTED")} rejected, ${byStatus("PENDING")} pending review. ` +
        `${ic.recordSupported} recommendation${ic.recordSupported === 1 ? " is" : "s are"} supported in the treating records.`,
    ),
  ];
}

export interface ChronologyConfig {
  from?: string | Date;
  to?: string | Date;
  types?: string[];
  order?: "asc" | "desc";
  includeExcerpts?: boolean;
}

/** Filterable chronology: a summary table plus one labeled block per event. */
export function chronology(data: ReportData, config: ChronologyConfig = {}): Block[] {
  const from = config.from ? new Date(config.from).getTime() : null;
  const to = config.to ? new Date(config.to).getTime() : null;
  const types = config.types?.length ? new Set(config.types.map((t) => t.toUpperCase())) : null;
  let events = data.case.chronologyEvents.filter((e) => {
    const t = new Date(e.eventDate).getTime();
    if (from != null && t < from) return false;
    if (to != null && t > to) return false;
    if (types && !types.has((e.eventType ?? "OTHER").toUpperCase())) return false;
    return true;
  });
  events = [...events].sort((a, b) => new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime());
  if (config.order === "desc") events.reverse();
  if (!events.length) return notDocumented();

  const blocks: Block[] = [
    {
      kind: "table",
      header: ["Date", "Provider", "Specialty", "Type", "Finding", "Source"],
      rows: events.map((e) => {
        const doc = e.sourceDocumentId ? data.case.documents.find((d) => d.id === e.sourceDocumentId) : undefined;
        return [
          mdY(e.eventDate),
          e.provider || "Treating provider",
          e.specialty || "—",
          e.eventType || e.recordType || "—",
          e.clinicalSignificance || e.diagnosis || e.summary,
          `${doc ? doc.filename : "record on file"}${e.sourcePage ? `, p. ${e.sourcePage}` : ""}`,
        ];
      }),
    },
  ];
  for (const e of events) {
    const bits = [
      `${e.provider || "Treating provider"}${e.specialty ? ` (${e.specialty})` : ""}${e.facility ? `, ${e.facility}` : ""}`,
      e.eventType || e.recordType ? `[${e.eventType || e.recordType}]` : null,
      e.clinicalSignificance || e.diagnosis || e.summary,
      config.includeExcerpts && e.sourceQuote ? `Record excerpt: “${e.sourceQuote}”` : null,
      eventSource(data, e),
    ].filter(Boolean);
    blocks.push(labeled(mdY(e.eventDate), bits.join("  ")));
  }
  return blocks;
}

/** Diagnoses with ICD codes, relatedness, and record citations. */
export function diagnoses(data: ReportData): Block[] {
  const c = data.case;
  if (!c.conditions.length) return notDocumented();
  const addl = asArray(c.additionalDiagnoses) as { diagnosis?: string; icd10Code?: string }[];
  const icdFor = (name: string): string => {
    if (c.diagnosis && name.toLowerCase() === c.diagnosis.toLowerCase()) return c.icd10Code || "";
    const m = addl.find((d) => d.diagnosis && d.diagnosis.toLowerCase() === name.toLowerCase());
    return m?.icd10Code || "";
  };
  const RELATEDNESS: Record<string, string> = {
    RELATED: "causally related to the incident",
    AGGRAVATION: "a pre-existing condition aggravated by the incident",
    PREEXISTING_UNRELATED: "pre-existing and unrelated to the incident",
    SUBSEQUENT_UNRELATED: "subsequent to, and unrelated to, the incident",
    UNCLEAR: "of unclear relationship to the incident pending further records",
  };
  const blocks: Block[] = [];
  for (const cond of c.conditions) {
    const icd = icdFor(cond.name);
    const parts = [
      `${RELATEDNESS[cond.relatedness] ?? RELATEDNESS.UNCLEAR}.`,
      cond.objectiveEvidence ? `Objective basis: ${cond.objectiveEvidence}` : null,
    ].filter(Boolean);
    blocks.push(labeled(`${cond.name}${icd ? ` (ICD-10 ${icd})` : ""}`, parts.join("  ")));
    const ev = evidenceSourcesOf(cond);
    if (ev.length) {
      blocks.push(source(`Evidence of record: ${ev.map((s) => `${s.filename ?? "record on file"}${s.page ? `, p. ${s.page}` : ""}`).join("; ")}.`));
    }
  }
  return blocks;
}

const IMAGING_RE = /imaging|mri|x[- ]?ray|radiograph|\bct\b|ultrasound|arthrogram|bone scan/i;

/** Imaging studies from the chronology and the conditions' imaging evidence. */
export function imaging(data: ReportData): Block[] {
  const blocks: Block[] = [];
  const events = data.case.chronologyEvents.filter(
    (e) => e.imagingFindings || (e.eventType ?? "").toUpperCase() === "IMAGING" || IMAGING_RE.test(e.recordType ?? ""),
  );
  for (const e of events) {
    blocks.push(labeled(mdY(e.eventDate), `${e.imagingFindings || e.summary}  ${eventSource(data, e)}`));
  }
  for (const cond of data.case.conditions) {
    const ev = evidenceSourcesOf(cond).filter((s) => s.quote && IMAGING_RE.test(s.quote));
    for (const s of ev) blocks.push(labeled(cond.name, `“${s.quote}” (${s.filename ?? "record on file"}${s.page ? `, p. ${s.page}` : ""})`));
  }
  return blocks.length ? blocks : notDocumented();
}

/** Surgical and interventional procedures documented in the chronology. */
export function procedures(data: ReportData): Block[] {
  const events = data.case.chronologyEvents.filter(
    (e) => e.procedure || ["SURGERY", "PROCEDURE"].includes((e.eventType ?? "").toUpperCase()),
  );
  if (!events.length) return notDocumented();
  return events.map((e) =>
    labeled(
      mdY(e.eventDate),
      `${e.procedure || e.summary}${e.provider ? ` — ${e.provider}` : ""}${e.facility ? `, ${e.facility}` : ""}.  ${eventSource(data, e)}`,
    ),
  );
}

/** Course of non-procedural treatment (therapy, medications, clinic plans). */
export function treatmentHistory(data: ReportData): Block[] {
  const events = data.case.chronologyEvents.filter(
    (e) => e.treatment || e.medications || (e.eventType ?? "").toUpperCase() === "THERAPY",
  );
  if (!events.length) return notDocumented();
  return events.map((e) => {
    const bits = [e.treatment, e.medications ? `Medications: ${e.medications}` : null, eventSource(data, e)].filter(Boolean);
    return labeled(mdY(e.eventDate), bits.join("  ") || e.summary);
  });
}

const FUNCTIONAL_DOMAINS: [string, RegExp][] = [
  ["Ambulation and gait", /walk|ambulat|gait|walker|cane|crutch/i],
  ["Stairs", /stair/i],
  ["Lifting and carrying", /lift|carry/i],
  ["Sitting and standing tolerance", /\bsit|\bstand/i],
  ["Self-care and activities of daily living", /self-care|\badl|dress|bath|groom|toilet|transfer/i],
  ["Employment", /work|employ|\bjob|occupation|sedentary|light duty/i],
  ["Pain", /pain/i],
  ["Range of motion", /range of motion|\brom\b|flexion|extension|mobility/i],
];

/** Documented functional limitations: record text + patient interview findings. */
export function functionalLimitations(data: ReportData): Block[] {
  const c = data.case;
  const funcText = [
    c.functionalLimitations,
    ...c.chronologyEvents.map((e) => e.functionalStatus),
    ...c.chronologyEvents.map((e) => e.restrictions),
  ]
    .filter(Boolean)
    .join(" ");
  const blocks: Block[] = [];
  for (const [domain, re] of FUNCTIONAL_DOMAINS) {
    const found = functionalFinding(funcText, re);
    if (found) blocks.push(labeled(domain, `${found.snippet}${found.quantified ? " (quantified in the record)" : ""}`));
  }
  const interviews = c.interviewFindings.filter(
    (f) => f.subject === "PATIENT" && /function|adl|mobility|limitation/i.test(f.category ?? ""),
  );
  for (const f of interviews) {
    blocks.push(labeled(`Patient interview${f.interviewDate ? ` (${mdY(f.interviewDate)})` : ""}`, `${f.text}${f.quote ? `  Patient states: “${f.quote}”` : ""}`));
  }
  return blocks.length ? blocks : notDocumented();
}

/** Treating-provider recommendations from interviews, with plan disposition. */
export function providerRecommendations(data: ReportData): Block[] {
  const c = data.case;
  const recs = c.interviewFindings.filter((f) => f.subject === "PROVIDER" && /recommend/i.test(f.category ?? ""));
  if (!recs.length && !c.treatingProviders.length) return notDocumented();
  const blocks: Block[] = [];
  if (c.treatingProviders.length) {
    blocks.push({
      kind: "table",
      header: ["Provider", "Credentials", "Specialty", "Facility", "Recommendation", "Plan status"],
      rows: c.treatingProviders.map((tp) => {
        const own = recs.filter((r) => r.providerId === tp.id);
        const linked = own.map((r) => r.futureCareItemId && c.futureCareItems.find((i) => i.id === r.futureCareItemId)).find(Boolean);
        return [
          tp.name,
          tp.credentials || "—",
          tp.specialty || "—",
          tp.facility || "—",
          own.length ? own.map((r) => r.text).join("; ") : "None recorded",
          own.length ? (linked ? reviewText(linked.physicianStatus) : "Pending") : "—",
        ];
      }),
    });
  }
  for (const r of recs) {
    const tp = r.providerId ? c.treatingProviders.find((x) => x.id === r.providerId) : undefined;
    const item = r.futureCareItemId ? c.futureCareItems.find((i) => i.id === r.futureCareItemId) : undefined;
    const status = item ? reviewText(item.physicianStatus) : "Pending";
    blocks.push(
      labeled(
        `${tp ? `${tp.name}${tp.credentials ? `, ${tp.credentials}` : ""}` : "Treating provider"}${tp?.specialty ? ` (${tp.specialty})` : ""}`,
        `${r.text}${r.quote ? `  Provider states: “${r.quote}”` : ""}  ${r.interviewDate ? `Interview of ${fmtDate(r.interviewDate)}.` : ""}  Plan status: ${status}.`,
      ),
    );
    blocks.push(source(`Source: treating-provider interview${r.interviewDate ? `, ${mdY(r.interviewDate)}` : ""}.`));
  }
  return blocks;
}

/** Every current recommendation with provenance, review status, and costs. */
export function futureCare(data: ReportData): Block[] {
  const items = data.case.futureCareItems;
  if (!items.length) return notDocumented();
  const life = data.case.lifeExpectancyYears;
  const blocks: Block[] = [];
  for (const it of items) {
    const supporting = it.condition?.name ?? data.case.conditions.find((x) => x.id === it.conditionId)?.name ?? data.case.diagnosis ?? "—";
    blocks.push(h2(it.service));
    blocks.push({
      kind: "table",
      header: ["Field", "Value"],
      rows: [
        ["Category", it.category.replace(/_/g, " ").toLowerCase()],
        ["Origin", originLabel(it)],
        ["Supporting diagnosis", supporting],
        ["Frequency", freqText(it)],
        ["Duration", durationText(it, life)],
        ["Probability", it.probability],
        ["Physician review", reviewText(it.physicianStatus)],
        ["Unit cost", money(it.unitCost)],
        ["Annual cost", money(it.annualCost)],
        ["Lifetime cost", money(it.lifetimeCost)],
        ["Present value", money(it.presentValue)],
        ["Included in totals", data.includedIds.has(it.id) ? "Yes" : `No — ${classifyLabel(data, it)}`],
      ],
    });
    if (it.rationale) blocks.push(labeled("Stated rationale", it.rationale));
  }
  return blocks;
}

/** Per-item medical necessity from the persisted assessment, with explicit
 *  provenance labels: system-generated analysis vs physician reviewer note vs
 *  treating-provider interview. Included items only. */
export function medicalNecessity(data: ReportData): Block[] {
  const items = includedItems(data);
  if (!items.length) return notDocumented();
  const blocks: Block[] = [];
  for (const it of items) {
    blocks.push(h2(it.service));
    const a = assessmentFor(data, it);
    if (a?.medicalNecessityRationale) {
      blocks.push(labeled("System-generated analysis", a.medicalNecessityRationale));
    } else if (it.rationale) {
      blocks.push(labeled("System-generated analysis", it.rationale));
    } else {
      blocks.push(p("No structured medical-necessity assessment is on file for this recommendation.", true));
    }
    if (a) {
      const suff = (a.evidenceSufficiency ?? {}) as { score?: number; verdict?: string; missing?: unknown };
      if (suff.score != null || suff.verdict) {
        blocks.push(labeled("Evidence sufficiency", `${suff.verdict ?? ""}${suff.score != null ? ` (score ${suff.score})` : ""}`.trim()));
      }
      const weakening = asArray(a.weakeningEvidence).map(strOf).filter(Boolean);
      if (weakening.length) blocks.push(labeled("Weakening evidence", weakening.join("; ")));
      const unknowns = asArray(a.unknowns).map(strOf).filter(Boolean);
      if (unknowns.length) blocks.push(labeled("Unknowns", unknowns.join("; ")));
    }
    if (it.physicianNote) blocks.push(labeled("Physician reviewer", it.physicianNote));
    const provRows = data.case.interviewFindings.filter((f) => f.subject === "PROVIDER" && f.futureCareItemId === it.id);
    for (const f of provRows) {
      const tp = f.providerId ? data.case.treatingProviders.find((x) => x.id === f.providerId) : undefined;
      blocks.push(labeled("Treating provider", `${tp ? `${tp.name}: ` : ""}${f.text}${f.quote ? ` — “${f.quote}”` : ""}`));
    }
  }
  return blocks;
}

export interface CostProjectionConfig {
  includeConditional?: boolean;
}

/** Cost schedule: included items with a totals row; conditional/excluded items
 *  in a separate, clearly labeled table — never merged into the totals. */
export function costProjection(data: ReportData, config: CostProjectionConfig = {}): Block[] {
  const inc = includedItems(data);
  const life = data.case.lifeExpectancyYears;
  const blocks: Block[] = [];
  const header = ["Service", "Frequency", "Duration", "Unit", "Annual", "Lifetime", "Present value", "Pricing source", "Physician review"];
  if (!inc.length) {
    blocks.push(p("No recommendations are currently included in the totals.", true));
  } else {
    const totalLifetime = inc.reduce((s, i) => s + i.lifetimeCost, 0);
    const totalPV = inc.reduce((s, i) => s + i.presentValue, 0);
    blocks.push({
      kind: "table",
      caption: "Projected future medical care — items included in the totals.",
      header,
      rows: [
        ...inc.map((i) => [
          i.service,
          freqText(i),
          durationText(i, life),
          money(i.unitCost),
          money(i.annualCost),
          money(i.lifetimeCost),
          money(i.presentValue),
          i.pricingSource || "—",
          reviewText(i.physicianStatus),
        ]),
        ["TOTAL", "", "", "", "", money(totalLifetime), money(totalPV), "", ""],
      ],
    });
  }
  if (config.includeConditional !== false) {
    const excl = excludedItems(data);
    if (excl.length) {
      blocks.push({
        kind: "table",
        caption: "Conditional and excluded recommendations — disclosed only; NOT included in the totals above.",
        header: ["Service", "Frequency", "Duration", "Present value (if incurred)", "Status"],
        rows: excl.map((i) => [i.service, freqText(i), durationText(i, life), money(i.presentValue), classifyLabel(data, i)]),
      });
    }
  }
  return blocks;
}

/** Record evidence per condition — verbatim quotes with filename and page. */
export function evidence(data: ReportData): Block[] {
  const blocks: Block[] = [];
  for (const cond of data.case.conditions) {
    const ev = evidenceSourcesOf(cond);
    if (!ev.length) continue;
    blocks.push(h2(cond.name));
    for (const s of ev) {
      blocks.push(
        labeled(
          `${s.filename ?? "Record on file"}${s.page ? `, p. ${s.page}` : ""}`,
          s.quote ? `“${s.quote}”` : "Cited record evidence.",
        ),
      );
    }
  }
  return blocks.length ? blocks : notDocumented();
}

/** Evidence that cuts against the plan's recommendations (from assessments). */
export function contradictoryEvidence(data: ReportData): Block[] {
  const blocks: Block[] = [];
  for (const a of data.assessments) {
    const weakening = asArray(a.weakeningEvidence).map(strOf).filter(Boolean);
    if (weakening.length) blocks.push(labeled(a.recommendationService, weakening.join("; ")));
  }
  return blocks.length ? blocks : notDocumented();
}

/** What is not yet known: assessment unknowns + missing-evidence requests. */
export function missingEvidence(data: ReportData): Block[] {
  const blocks: Block[] = [];
  for (const a of data.assessments) {
    const suff = (a.evidenceSufficiency ?? {}) as { missing?: unknown };
    const rows = [
      ...asArray(a.unknowns).map(strOf),
      ...asArray(a.missingEvidenceRequests).map(strOf),
      ...asArray(suff.missing).map(strOf),
    ].filter(Boolean);
    const uniq = [...new Set(rows)];
    if (uniq.length) {
      blocks.push(labeled(a.recommendationService, ""));
      for (const r of uniq) blocks.push(bullet(r));
    }
  }
  return blocks.length ? blocks : notDocumented();
}

/** Literature relied upon and rejected — stored titles/identifiers only. */
export function literature(data: ReportData): Block[] {
  const blocks: Block[] = [];
  for (const a of data.assessments) {
    const kept = asArray(a.supportingLiteratureAssessments) as { title?: string; pmid?: string; doi?: string; supports?: string }[];
    const rejected = asArray(a.rejectedLiterature) as { title?: string; pmid?: string; reason?: string }[];
    if (!kept.length && !rejected.length && !a.literatureSynthesis) continue;
    blocks.push(h2(a.recommendationService));
    if (a.literatureSynthesis) blocks.push(p(a.literatureSynthesis));
    for (const l of kept.filter((l) => l.title)) {
      blocks.push(bullet(`${l.title}${l.pmid ? ` (PMID ${l.pmid})` : l.doi ? ` (doi:${l.doi})` : ""}${l.supports ? ` — supports ${l.supports}` : ""}`));
    }
    for (const l of rejected.filter((l) => l.title)) {
      blocks.push(bullet(`Excluded: ${l.title}${l.pmid ? ` (PMID ${l.pmid})` : ""}${l.reason ? ` — ${l.reason}` : ""}`));
    }
  }
  return blocks.length ? blocks : notDocumented();
}

/** Physician-review ledger (transitions) and active attestations. */
export function physicianReview(data: ReportData): Block[] {
  const blocks: Block[] = [];
  if (data.transitions.length) {
    blocks.push({
      kind: "table",
      caption: "Recommendation review ledger — every recorded decision, oldest first.",
      header: ["Date", "Actor role", "Recommendation", "Prior → New", "Reason", "Comment", "Changes"],
      rows: data.transitions.map((t) => {
        const item = data.case.futureCareItems.find((i) => i.id === t.itemId);
        const fields = asArray(t.modifiedFields)
          .map((f) => {
            if (typeof f === "string") return f;
            const o = f as { field?: string; from?: unknown; to?: unknown };
            return o.field ? `${o.field}: ${String(o.from ?? "—")} → ${String(o.to ?? "—")}` : "";
          })
          .filter(Boolean)
          .join("; ");
        return [
          mdY(t.createdAt),
          t.role || "—",
          item?.service ?? t.itemId,
          `${t.priorStatus} → ${t.newStatus}`,
          t.reasonCode || "—",
          t.comment || "—",
          fields || "—",
        ];
      }),
    });
  } else {
    blocks.push(p("No physician-review actions have been recorded for this case.", true));
  }
  for (const att of data.case.attestations) {
    blocks.push(h2("Physician attestation"));
    blocks.push(p(att.statementText));
    if (att.physicianNote) blocks.push(p(`Qualification noted at signing: ${att.physicianNote}`, true));
    blocks.push(
      p(
        `Signed electronically by ${att.physicianName} on ${fmtDate(att.signedAt)}, covering ${att.itemCount} recommendation${att.itemCount === 1 ? "" : "s"} with a combined present value of ${money(att.totalPresentValue)}.`,
      ),
    );
    blocks.push(source(`Attestation integrity hash (SHA-256): ${att.contentHash}`));
  }
  return blocks;
}

/** Deduplicated register of every record citation and literature reference. */
export function citations(data: ReportData): Block[] {
  const seen = new Set<string>();
  const blocks: Block[] = [];
  const add = (text: string) => {
    if (!seen.has(text)) {
      seen.add(text);
      blocks.push(bullet(text));
    }
  };
  for (const cond of data.case.conditions) {
    for (const s of evidenceSourcesOf(cond)) {
      if (s.filename) add(`${s.filename}${s.page ? `, p. ${s.page}` : ""} (record evidence — ${cond.name}).`);
    }
  }
  for (const e of data.case.chronologyEvents) {
    if (e.sourceDocumentId) {
      const doc = data.case.documents.find((d) => d.id === e.sourceDocumentId);
      if (doc) add(`${doc.filename}${e.sourcePage ? `, p. ${e.sourcePage}` : ""} (chronology source).`);
    }
  }
  for (const a of data.assessments) {
    const kept = asArray(a.supportingLiteratureAssessments) as { title?: string; pmid?: string; doi?: string }[];
    for (const l of kept) {
      if (l.title) add(`${l.title}${l.pmid ? ` (PMID ${l.pmid})` : l.doi ? ` (doi:${l.doi})` : ""}.`);
    }
  }
  return blocks.length ? blocks : notDocumented();
}

/** Open validation findings — export-blocking rows called out explicitly. */
export function unresolvedIssues(findings: RDValidationFinding[]): Block[] {
  if (!findings.length) return [p("No unresolved validation issues are recorded for this case.", true)];
  const blocking = findings.filter((f) => f.exportBlocking).length;
  return [
    p(
      `${findings.length} validation issue${findings.length === 1 ? " is" : "s are"} recorded; ${blocking} block${blocking === 1 ? "s" : ""} final export.`,
    ),
    {
      kind: "table",
      header: ["Recommendation", "Result", "Issue", "Severity", "Blocks final export"],
      rows: findings.map((f) => [f.service, f.result, f.issue, f.severity, f.exportBlocking ? "Yes — blocks final export" : "No"]),
    },
  ];
}
