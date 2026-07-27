import { z } from "zod";
import type { ReportData, RDFutureCareItem } from "./data";
import type { Block, ReportDoc } from "./doc";
import { UNRESOLVED_BANNER } from "./doc";
import * as S from "./sections";
import type { RDValidationFinding } from "./sections";

// ─────────────────────────────────────────────────────────────────────────────
// Report Library — registry & gate (docs/22 §2, §4).
//
// Every generatable report is declared here: identity, formats, approval
// requirement, export gate, config schema, and a pure compose function from
// ReportData → ReportDoc. The two legacy reports (Life Care Plan, Testimony
// Pack) are registered as metadata only — their existing builders/routes are
// untouched and their compose throws.
//
// `gateReport` is the single pure gate the API calls before building. No
// report type can bypass export-blocking findings for totals-bearing content,
// and physician-required reports can never be finalized over undecided items.
// ─────────────────────────────────────────────────────────────────────────────

export type ReportApproval = "none" | "standard" | "physician_required";
export type ReportGate = "standard" | "disclose";
export type ReportFormat = "DOCX" | "PDF" | "CSV" | "HTML";

export interface ComposeOpts {
  draft?: boolean;
}

export interface ReportDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  permission: "report.export";
  approval: ReportApproval;
  gate: ReportGate;
  formats: ReportFormat[];
  legacy?: boolean;
  /** Commercial placement: core = the four public service lines. */
  serviceTier: "core" | "supporting" | "beta";
  /** Expert whose approval finalizes this report (report-level, P2+). */
  requiredExpert?: "physician" | "vocational" | "economist";
  /** PHYSICIAN_REVIEW_REPORT: refuse when no recommendation has been decided. */
  requiresDecided?: boolean;
  configSchema: z.ZodTypeAny;
  defaultConfig: unknown;
  /** CUSTOM: approval derived from the selected sections. */
  deriveApproval?: (config: unknown) => ReportApproval;
  compose: (data: ReportData, config: unknown, findings: RDValidationFinding[], opts?: ComposeOpts) => ReportDoc;
}

// ── Small pure helpers ───────────────────────────────────────────────────────

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const freq = (i: RDFutureCareItem) => (!i.isLifetime && (i.durationYears ?? 0) <= 0 ? "one-time" : `${i.frequencyPerYear}× per year`);
const dur = (i: RDFutureCareItem) => (i.isLifetime ? "lifetime" : (i.durationYears ?? 0) > 0 ? `${i.durationYears} years` : "one-time");
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strOf = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as { text?: unknown; title?: unknown; alternative?: unknown; rationale?: unknown };
    if (typeof o.text === "string") return o.text;
    if (typeof o.title === "string") return o.title;
    if (typeof o.alternative === "string") return `${o.alternative}${typeof o.rationale === "string" ? ` — ${o.rationale}` : ""}`;
  }
  return String(v ?? "");
};

const caseLabelOf = (data: ReportData) => `${data.case.clientName} · File ${data.case.caseNumber}`;

const BASE_DISCLOSURE =
  "This report was generated from structured case data derived from the available records and user-supplied information. Source-supported factual statements should be reviewed through the accompanying citations. Analytical conclusions, projections, classifications, and professional opinions are separately identified and remain subject to the review and approval requirements stated in this report.";

// Report-specific disclosure language — each definition may override or extend
// the base. Never an absolute guarantee of traceability.
const TYPE_DISCLOSURE: Record<string, string> = {
  MEDICAL_CHRONOLOGY:
    "This chronology reports events extracted from the medical records with their source citations. It states no medical opinion. Extraction issues, where present, are disclosed in the Unresolved Issues section.",
  MEDICAL_RECORD_SUMMARY:
    "Factual content in this summary derives from the records cited. Any characterization of clinical significance is a system-generated classification identified as such, not an expert conclusion.",
  MEDICAL_COST_PROJECTION:
    "Projected services derive from the case's future-care recommendations and physician-review dispositions; costs reflect the stated pricing sources and assumptions. Record-derived facts, treating-provider recommendations, system-generated classifications, and physician-reviewed conclusions are separately identified.",
  MEDICAL_NECESSITY:
    "System-generated analysis, treating-provider recommendations, life-care-planner analysis, and physician-reviewer opinions are separately labeled throughout. No analytical conclusion herein is an expert opinion unless approved by the identified reviewing physician.",
  CAUSATION_ANALYSIS:
    "Temporal relationships and record findings derive from the cited records. Causation conclusions require and are attributed to the reviewing physician; absent that approval this document is a review-support package, not an expert opinion.",
  DEFENSE_REBUTTAL:
    "Item-level evidence assessments are system-generated from the case record and identified as such. Physician conclusions appear only where a reviewing physician has approved the item.",
  VOCATIONAL_ASSESSMENT:
    "Medical restrictions are attributed to their clinical sources; client-reported work history, vocational testing, and labor-market data are attributed to their sources. Vocational conclusions require and are attributed to the qualified vocational expert.",
  FORENSIC_ECONOMIST_REPORT:
    "Source financial data, vocational assumptions, medical-cost inputs, economist-supplied assumptions, calculations, and expert conclusions are separately identified. Every economic assumption is explicitly entered, sourced, and versioned. Final conclusions require economist approval and attestation.",
};
const WORKSHEET_DISCLOSURE =
  "ANALYST WORKSHEET — the analyses herein are system-generated from the case record and are pending physician review; they are not expert opinion until approved by the reviewing physician.";

/** Append the unresolved-issues section whenever blocking findings exist —
 *  disclose-gated reports surface their problems instead of hiding them, and
 *  standard-gated drafts carry them the same way. */
function withUnresolved(blocks: Block[], findings: RDValidationFinding[]): Block[] {
  if (!findings.some((f) => f.exportBlocking)) return blocks;
  // Lead with the unresolved issues — recipients must see them before the
  // content they qualify, not in an appendix (docs/23 §unresolved-issues).
  return [{ kind: "h1", text: "Unresolved Issues" }, ...S.unresolvedIssues(findings), ...blocks];
}

function makeDoc(
  def: { id: string; approval: ReportApproval },
  data: ReportData,
  title: string,
  subtitle: string,
  blocks: Block[],
  findings: RDValidationFinding[],
  opts?: ComposeOpts,
  extraDisclosures: string[] = [],
): ReportDoc {
  const draft = opts?.draft ?? false;
  const disclosures = [TYPE_DISCLOSURE[def.id] ?? BASE_DISCLOSURE, ...extraDisclosures];
  if (draft && def.approval === "physician_required") disclosures.push(WORKSHEET_DISCLOSURE);
  return {
    reportId: def.id,
    title,
    subtitle,
    caseLabel: caseLabelOf(data),
    blocks: withUnresolved(blocks, findings),
    draft,
    banner: !draft && findings.some((f) => f.exportBlocking) ? UNRESOLVED_BANNER : undefined,
    disclosures,
  };
}

const included = (data: ReportData) => data.case.futureCareItems.filter((i) => data.includedIds.has(i.id));
const excluded = (data: ReportData) => data.case.futureCareItems.filter((i) => !data.includedIds.has(i.id));
const decided = (i: RDFutureCareItem) => i.physicianStatus === "APPROVED" || i.physicianStatus === "MODIFIED" || i.physicianStatus === "REJECTED";

// ── Config schemas ───────────────────────────────────────────────────────────

const emptyConfig = z.object({}).strict();

const chronologyConfig = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
    types: z.array(z.string()).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    includeExcerpts: z.boolean().optional(),
  })
  .strict();

const recordSummaryConfig = z.object({ detail: z.enum(["brief", "standard", "detailed"]).default("standard") }).strict();

const costProjectionConfig = z.object({ includeConditional: z.boolean().default(true) }).strict();

// ── CUSTOM report: section menu ──────────────────────────────────────────────

export const SECTION_MENU: Record<string, { title: string; build: (data: ReportData) => Block[] }> = {
  caseHeader: { title: "Case Summary", build: (d) => S.caseHeader(d) },
  executiveSummary: { title: "Executive Summary", build: (d) => S.executiveSummary(d) },
  chronology: { title: "Medical Chronology", build: (d) => S.chronology(d) },
  diagnoses: { title: "Diagnoses", build: (d) => S.diagnoses(d) },
  imaging: { title: "Imaging", build: (d) => S.imaging(d) },
  procedures: { title: "Procedures", build: (d) => S.procedures(d) },
  treatmentHistory: { title: "Treatment History", build: (d) => S.treatmentHistory(d) },
  functionalLimitations: { title: "Functional Limitations", build: (d) => S.functionalLimitations(d) },
  providerRecommendations: { title: "Treating-Provider Recommendations", build: (d) => S.providerRecommendations(d) },
  futureCare: { title: "Future Care", build: (d) => S.futureCare(d) },
  medicalNecessity: { title: "Medical Necessity", build: (d) => S.medicalNecessity(d) },
  costProjection: { title: "Cost Projection", build: (d) => S.costProjection(d) },
  evidence: { title: "Evidence of Record", build: (d) => S.evidence(d) },
  contradictoryEvidence: { title: "Contradictory Evidence", build: (d) => S.contradictoryEvidence(d) },
  missingEvidence: { title: "Missing Evidence", build: (d) => S.missingEvidence(d) },
  literature: { title: "Literature", build: (d) => S.literature(d) },
  physicianReview: { title: "Physician Review", build: (d) => S.physicianReview(d) },
  citations: { title: "Citations", build: (d) => S.citations(d) },
};

const SECTION_KEYS = Object.keys(SECTION_MENU) as [string, ...string[]];

const customConfig = z
  .object({
    sections: z.array(z.enum(SECTION_KEYS)).min(1),
    order: z.array(z.string()).optional(),
  })
  .strict();

/** Approval for a CUSTOM report is the strictest rule among its sections. */
export function customApproval(sections: string[]): ReportApproval {
  if (sections.includes("medicalNecessity")) return "physician_required";
  if (sections.includes("costProjection") || sections.includes("futureCare")) return "standard";
  return "none";
}

// ── Compose implementations ──────────────────────────────────────────────────

function legacyCompose(): never {
  throw new Error("This report is handled by the legacy pipeline; use its existing export route.");
}

type Def = ReportDefinition;

const MEDICAL_CHRONOLOGY: Def = {
  id: "MEDICAL_CHRONOLOGY",
  serviceTier: "supporting",
  name: "Medical Chronology",
  description: "Chronological account of the documented encounters, filterable by date range and encounter type.",
  category: "Record review",
  permission: "report.export",
  approval: "none",
  gate: "disclose",
  formats: ["DOCX", "HTML", "CSV"],
  configSchema: chronologyConfig,
  defaultConfig: {},
  compose(data, config, findings, opts) {
    const cfg = chronologyConfig.parse(config ?? {});
    const blocks: Block[] = [
      ...S.caseHeader(data),
      { kind: "h1", text: "Medical Chronology" },
      ...S.chronology(data, cfg),
    ];
    return makeDoc(this, data, "Medical Chronology", "Chronological summary of the documented care", blocks, findings, opts);
  },
};

const MEDICAL_RECORD_SUMMARY: Def = {
  id: "MEDICAL_RECORD_SUMMARY",
  serviceTier: "supporting",
  name: "Medical Record Summary",
  description: "Narrative summary of the record at a selectable level of detail.",
  category: "Record review",
  permission: "report.export",
  approval: "none",
  gate: "disclose",
  formats: ["DOCX", "HTML"],
  configSchema: recordSummaryConfig,
  defaultConfig: {},
  compose(data, config, findings, opts) {
    const { detail } = recordSummaryConfig.parse(config ?? {});
    const blocks: Block[] = [...S.caseHeader(data), { kind: "h1", text: "Summary" }, ...S.executiveSummary(data), { kind: "h1", text: "Diagnoses" }, ...S.diagnoses(data)];
    if (detail !== "brief") {
      blocks.push({ kind: "h1", text: "Treatment History" }, ...S.treatmentHistory(data));
      blocks.push({ kind: "h1", text: "Imaging" }, ...S.imaging(data));
      blocks.push({ kind: "h1", text: "Procedures" }, ...S.procedures(data));
    }
    if (detail === "detailed") {
      blocks.push({ kind: "h1", text: "Medical Chronology" }, ...S.chronology(data));
      blocks.push({ kind: "h1", text: "Evidence of Record" }, ...S.evidence(data));
    }
    return makeDoc(this, data, "Medical Record Summary", `Record summary — ${detail} detail`, blocks, findings, opts);
  },
};

const COST_PROJECTION: Def = {
  id: "MEDICAL_COST_PROJECTION",
  serviceTier: "core",
  name: "Medical Cost Projection",
  description: "Cost schedule for the projected future care, totals drawn only from included items.",
  category: "Damages",
  permission: "report.export",
  approval: "standard",
  gate: "standard",
  formats: ["DOCX", "HTML", "CSV"],
  configSchema: costProjectionConfig,
  defaultConfig: {},
  compose(data, config, findings, opts) {
    const cfg = costProjectionConfig.parse(config ?? {});
    const blocks: Block[] = [...S.caseHeader(data), { kind: "h1", text: "Cost Projection" }, ...S.costProjection(data, cfg)];
    return makeDoc(this, data, "Cost Projection", "Future medical cost schedule", blocks, findings, opts);
  },
};

const MEDICAL_NECESSITY: Def = {
  id: "MEDICAL_NECESSITY",
  serviceTier: "beta",
  name: "Medical Necessity Report",
  description: "Per-recommendation medical-necessity analysis with evidence sufficiency, weaknesses, and unknowns.",
  category: "Clinical analysis",
  permission: "report.export",
  approval: "physician_required",
  gate: "standard",
  formats: ["DOCX", "HTML"],
  configSchema: emptyConfig,
  defaultConfig: {},
  compose(data, _config, findings, opts) {
    const blocks: Block[] = [
      ...S.caseHeader(data),
      { kind: "h1", text: "Diagnoses" },
      ...S.diagnoses(data),
      { kind: "h1", text: "Medical Necessity" },
      ...S.medicalNecessity(data),
    ];
    return makeDoc(this, data, "Medical Necessity Report", "Per-recommendation necessity analysis", blocks, findings, opts);
  },
};

const PROVIDER_MATRIX: Def = {
  id: "PROVIDER_MATRIX",
  serviceTier: "supporting",
  name: "Provider Recommendation Matrix",
  description: "Treating providers and their documented recommendations, with each recommendation's plan disposition.",
  category: "Record review",
  permission: "report.export",
  approval: "none",
  gate: "disclose",
  formats: ["DOCX", "HTML", "CSV"],
  configSchema: emptyConfig,
  defaultConfig: {},
  compose(data, _config, findings, opts) {
    const blocks: Block[] = [...S.caseHeader(data), { kind: "h1", text: "Treating-Provider Recommendations" }, ...S.providerRecommendations(data)];
    return makeDoc(this, data, "Provider Recommendation Matrix", "Treating providers and their recommendations", blocks, findings, opts);
  },
};

const FUTURE_CARE_SUMMARY: Def = {
  id: "FUTURE_CARE_SUMMARY",
  serviceTier: "supporting",
  name: "Future Care Summary",
  description: "Every current recommendation with provenance, review status, and cost fields.",
  category: "Damages",
  permission: "report.export",
  approval: "standard",
  gate: "standard",
  formats: ["DOCX", "HTML"],
  configSchema: emptyConfig,
  defaultConfig: {},
  compose(data, _config, findings, opts) {
    const blocks: Block[] = [...S.caseHeader(data), { kind: "h1", text: "Future Care" }, ...S.futureCare(data)];
    return makeDoc(this, data, "Future Care Summary", "Projected future medical care", blocks, findings, opts);
  },
};

const DEFENSE_REBUTTAL: Def = {
  id: "DEFENSE_REBUTTAL",
  serviceTier: "beta",
  name: "Defense Rebuttal / Audit",
  description: "Adversarial audit of each included recommendation: support, weaknesses, gaps, overlaps, and alternatives.",
  category: "Clinical analysis",
  permission: "report.export",
  approval: "physician_required",
  gate: "standard",
  formats: ["DOCX", "HTML"],
  configSchema: emptyConfig,
  defaultConfig: {},
  compose(data, _config, findings, opts) {
    const blocks: Block[] = [...S.caseHeader(data), { kind: "h1", text: "Recommendation Audit" }];
    const items = included(data);
    if (!items.length) blocks.push({ kind: "p", text: S.NOT_DOCUMENTED, italics: true });
    for (const it of items) {
      const a = data.assessments.find((x) => x.recommendationId === it.id) ?? data.assessments.find((x) => x.recommendationService === it.service);
      blocks.push({ kind: "h2", text: it.service });
      blocks.push({
        kind: "labeled",
        label: "Claimed recommendation",
        text: `${freq(it)}, ${dur(it)}; unit cost ${money(it.unitCost)}; lifetime ${money(it.lifetimeCost)}; present value ${money(it.presentValue)}.`,
      });
      const supportText = a?.medicalNecessityRationale ?? it.rationale;
      blocks.push({ kind: "labeled", label: "Supporting evidence", text: supportText || S.NOT_DOCUMENTED });
      const weakening = asArray(a?.weakeningEvidence).map(strOf).filter(Boolean);
      blocks.push({ kind: "labeled", label: "Weakening evidence", text: weakening.length ? weakening.join("; ") : S.NOT_DOCUMENTED });
      const suff = (a?.evidenceSufficiency ?? {}) as { missing?: unknown };
      const missing = [...asArray(a?.unknowns).map(strOf), ...asArray(suff.missing).map(strOf)].filter(Boolean);
      blocks.push({ kind: "labeled", label: "Missing evidence", text: missing.length ? [...new Set(missing)].join("; ") : S.NOT_DOCUMENTED });
      const cnote = data.integrity.consistency.notes.get(it.id);
      if (cnote && cnote.conflictsWith.length) {
        blocks.push({
          kind: "labeled",
          label: "Duplicate / conflicting care",
          text: `${[...new Set(cnote.conflictsWith)].join(", ")}${cnote.resolution ? ` — ${cnote.resolution}` : ""}`,
        });
      }
      const alternatives = [it.lowerCostAlternative, ...asArray(a?.alternativesConsidered).map(strOf)].filter(Boolean) as string[];
      if (alternatives.length) blocks.push({ kind: "labeled", label: "Alternatives", text: alternatives.join("; ") });
      const lit = asArray(a?.supportingLiteratureAssessments)
        .map(strOf)
        .filter(Boolean);
      if (lit.length) blocks.push({ kind: "labeled", label: "Literature", text: lit.join("; ") });
      const concluded = it.physicianStatus === "APPROVED" || it.physicianStatus === "MODIFIED";
      blocks.push({
        kind: "labeled",
        label: "Physician conclusion",
        text: concluded
          ? `${it.physicianStatus === "MODIFIED" ? "Approved with modification" : "Approved"} on physician review.${it.physicianNote ? ` Note: ${it.physicianNote}` : ""}`
          : "[pending physician approval]",
      });
    }
    return makeDoc(this, data, "Defense Rebuttal / Audit", "Adversarial audit of the plan's recommendations", blocks, findings, opts);
  },
};

const CAUSATION_ANALYSIS: Def = {
  id: "CAUSATION_ANALYSIS",
  serviceTier: "beta",
  name: "Causation Analysis",
  description: "Pre-existing versus injury-related conditions, temporal relationship, aggravation, and alternative causes.",
  category: "Clinical analysis",
  permission: "report.export",
  approval: "physician_required",
  gate: "standard",
  formats: ["DOCX", "HTML"],
  configSchema: emptyConfig,
  defaultConfig: {},
  compose(data, _config, findings, opts) {
    const c = data.case;
    const blocks: Block[] = [...S.caseHeader(data)];
    const preExisting = [
      ...(c.preExistingConditions ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      ...c.conditions.filter((x) => x.relatedness === "PREEXISTING_UNRELATED").map((x) => x.name),
    ];
    const uniquePre = [...new Set(preExisting)];
    blocks.push({ kind: "h1", text: "Pre-Existing Conditions" });
    if (uniquePre.length) uniquePre.forEach((n) => blocks.push({ kind: "bullet", text: n }));
    else blocks.push({ kind: "p", text: S.NOT_DOCUMENTED, italics: true });

    blocks.push({ kind: "h1", text: "Injury-Related Conditions" });
    const related = c.conditions.filter((x) => x.relatedness === "RELATED");
    if (related.length) {
      for (const x of related) blocks.push({ kind: "labeled", label: x.name, text: x.reasoning || x.objectiveEvidence || "Documented in the record." });
    } else blocks.push({ kind: "p", text: S.NOT_DOCUMENTED, italics: true });

    blocks.push({ kind: "h1", text: "Temporal Relationship" });
    const first = c.chronologyEvents[0];
    if (c.dateOfInjury || first) {
      const doi = c.dateOfInjury ? new Date(c.dateOfInjury) : null;
      const firstDate = first ? new Date(first.eventDate) : null;
      const days = doi && firstDate ? Math.round((firstDate.getTime() - doi.getTime()) / 86400000) : null;
      blocks.push({
        kind: "p",
        text: `${doi ? `The date of injury is ${doi.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}.` : "The date of injury is not documented."} ${
          firstDate
            ? `The first documented encounter is ${firstDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}${days != null ? `, ${days} day${days === 1 ? "" : "s"} after the injury` : ""}.`
            : "No encounters are documented in the chronology."
        }`,
      });
    } else blocks.push({ kind: "p", text: S.NOT_DOCUMENTED, italics: true });

    blocks.push({ kind: "h1", text: "Aggravation of Pre-Existing Conditions" });
    const aggravations = c.conditions.filter((x) => x.relatedness === "AGGRAVATION");
    if (aggravations.length) {
      for (const x of aggravations) blocks.push({ kind: "labeled", label: x.name, text: x.reasoning || "Documented as an aggravation of a pre-existing condition." });
    } else blocks.push({ kind: "p", text: S.NOT_DOCUMENTED, italics: true });

    blocks.push({ kind: "h1", text: "Alternative Causes Considered" });
    if (uniquePre.length) {
      blocks.push({ kind: "p", text: "The following pre-existing conditions were considered as alternative explanations for the presentation:" });
      uniquePre.forEach((n) => blocks.push({ kind: "bullet", text: n }));
    } else blocks.push({ kind: "p", text: "No pre-existing conditions are documented as alternative causes.", italics: true });

    blocks.push({ kind: "h1", text: "Physician Opinion" });
    const att = c.attestations[0];
    const note = c.futureCareItems.map((i) => i.physicianNote).find(Boolean);
    if (att) {
      blocks.push({ kind: "p", text: att.statementText });
      blocks.push({ kind: "source", text: `Signed by ${att.physicianName}; attestation hash ${att.contentHash}.` });
    } else if (note) {
      blocks.push({ kind: "labeled", label: "Physician reviewer", text: note });
    } else {
      blocks.push({ kind: "p", text: "[pending physician review]", italics: true });
    }
    return makeDoc(this, data, "Causation Analysis", "Relationship of the conditions to the incident", blocks, findings, opts);
  },
};

const PHYSICIAN_REVIEW_REPORT: Def = {
  id: "PHYSICIAN_REVIEW_REPORT",
  serviceTier: "supporting",
  name: "Physician Review Report",
  description: "The complete physician-review ledger: every decision, change, reason code, and attestation.",
  category: "Governance",
  permission: "report.export",
  approval: "none",
  gate: "disclose",
  formats: ["DOCX", "HTML"],
  requiresDecided: true,
  configSchema: emptyConfig,
  defaultConfig: {},
  compose(data, _config, findings, opts) {
    const blocks: Block[] = [...S.caseHeader(data), { kind: "h1", text: "Physician Review" }, ...S.physicianReview(data)];
    return makeDoc(this, data, "Physician Review Report", "Decision ledger and attestations", blocks, findings, opts);
  },
};

const DAMAGES_SUMMARY: Def = {
  id: "DAMAGES_SUMMARY",
  serviceTier: "beta",
  name: "Damages Executive Summary",
  description: "The damages picture at a glance: major diagnoses, largest cost drivers, structure, and open uncertainty.",
  category: "Damages",
  permission: "report.export",
  approval: "standard",
  gate: "standard",
  formats: ["DOCX", "HTML"],
  configSchema: emptyConfig,
  defaultConfig: {},
  compose(data, _config, findings, opts) {
    const c = data.case;
    const inc = included(data);
    const blocks: Block[] = [...S.caseHeader(data), { kind: "h1", text: "Summary" }, ...S.executiveSummary(data)];

    blocks.push({ kind: "h1", text: "Major Diagnoses" });
    const major = c.conditions.filter((x) => x.relatedness === "RELATED" || x.relatedness === "AGGRAVATION");
    if (major.length) major.forEach((x) => blocks.push({ kind: "bullet", text: x.name }));
    else blocks.push({ kind: "p", text: S.NOT_DOCUMENTED, italics: true });

    blocks.push({ kind: "h1", text: "Largest Cost Drivers" });
    const top5 = [...inc].sort((a, b) => b.presentValue - a.presentValue).slice(0, 5);
    if (top5.length) {
      blocks.push({
        kind: "table",
        header: ["Service", "Frequency", "Duration", "Present value", "Physician review"],
        rows: top5.map((i) => [
          i.service,
          freq(i),
          dur(i),
          money(i.presentValue),
          i.physicianStatus === "APPROVED" ? "Approved" : i.physicianStatus === "MODIFIED" ? "Approved with modification" : i.physicianStatus === "REJECTED" ? "Rejected" : "Pending",
        ]),
      });
    } else blocks.push({ kind: "p", text: "No recommendations are currently included in the totals.", italics: true });

    blocks.push({ kind: "h1", text: "Recurring vs One-Time Care" });
    const recurring = inc.filter((i) => i.isLifetime || (i.durationYears ?? 0) > 0);
    const oneTime = inc.filter((i) => !i.isLifetime && (i.durationYears ?? 0) <= 0);
    blocks.push({
      kind: "p",
      text: `Recurring care: ${recurring.length} item${recurring.length === 1 ? "" : "s"}, ${money(recurring.reduce((s, i) => s + i.presentValue, 0))} present value. One-time care: ${oneTime.length} item${oneTime.length === 1 ? "" : "s"}, ${money(oneTime.reduce((s, i) => s + i.presentValue, 0))} present value.`,
    });

    blocks.push({ kind: "h1", text: "Conditional Care (Not Totaled)" });
    const excl = excluded(data);
    if (excl.length) excl.forEach((i) => blocks.push({ kind: "bullet", text: `${i.service} — ${money(i.presentValue)} present value if incurred.` }));
    else blocks.push({ kind: "p", text: "None — every proposed item is included in the totals.", italics: true });

    blocks.push({ kind: "h1", text: "Uncertainties" });
    const uncertainties = data.assessments
      .flatMap((a) => [a.residualUncertainty, ...asArray(a.unknowns).map(strOf)])
      .filter((x): x is string => !!x);
    if (uncertainties.length) [...new Set(uncertainties)].forEach((u) => blocks.push({ kind: "bullet", text: u }));
    else blocks.push({ kind: "p", text: S.NOT_DOCUMENTED, italics: true });

    return makeDoc(this, data, "Damages Executive Summary", "Future medical damages at a glance", blocks, findings, opts);
  },
};

const CUSTOM: Def = {
  id: "CUSTOM",
  serviceTier: "beta",
  name: "Custom Report",
  description: "Compose a report from any combination of the library's sections, in your order.",
  category: "Custom",
  permission: "report.export",
  approval: "none", // derived per-config; see deriveApproval / customApproval
  gate: "standard",
  formats: ["DOCX", "HTML"],
  configSchema: customConfig,
  defaultConfig: { sections: ["caseHeader", "executiveSummary"] },
  deriveApproval: (config) => {
    const parsed = customConfig.safeParse(config ?? {});
    return parsed.success ? customApproval(parsed.data.sections) : "physician_required";
  },
  compose(data, config, findings, opts) {
    const cfg = customConfig.parse(config ?? this.defaultConfig);
    let selected = [...cfg.sections];
    if (cfg.order?.length) {
      const rank = new Map(cfg.order.map((s, i) => [s, i]));
      selected = selected.sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER));
    }
    const blocks: Block[] = [];
    for (const key of selected) {
      const entry = SECTION_MENU[key];
      blocks.push({ kind: "h1", text: entry.title }, ...entry.build(data));
    }
    return makeDoc(
      { id: this.id, approval: customApproval(cfg.sections) },
      data,
      "Case Report",
      "Custom composition from the report library",
      blocks,
      findings,
      opts,
    );
  },
};

const LIFE_CARE_PLAN: Def = {
  id: "LIFE_CARE_PLAN",
  serviceTier: "core",
  name: "Life Care Plan",
  description: "The full physician-grade Life Care Plan & Future Medical Cost Analysis (existing pipeline).",
  category: "Core",
  permission: "report.export",
  approval: "standard",
  gate: "standard",
  formats: ["DOCX", "PDF", "CSV"],
  legacy: true,
  configSchema: emptyConfig,
  defaultConfig: {},
  compose: legacyCompose,
};

const TESTIMONY_PACK: Def = {
  id: "TESTIMONY_PACK",
  serviceTier: "supporting",
  name: "Testimony Preparation Pack",
  description: "Deposition/testimony preparation memorandum (existing pipeline).",
  category: "Core",
  permission: "report.export",
  approval: "none",
  gate: "disclose",
  formats: ["DOCX"],
  legacy: true,
  configSchema: emptyConfig,
  defaultConfig: {},
  compose: legacyCompose,
};

// ── Registry ─────────────────────────────────────────────────────────────────


// ── Core service-line placeholders (P4/P5 build the workflows) ───────────────
// These exist so the four public service lines are always visible with honest
// readiness. compose() is unreachable until the expert workflow ships —
// the API refuses generation with an "expert workflow not yet available" error.

const VOCATIONAL_ASSESSMENT: ReportDefinition = {
  id: "VOCATIONAL_ASSESSMENT",
  serviceTier: "core",
  name: "Vocational Assessment",
  description:
    "Expert-reviewed analysis of employability, work capacity, transferable skills, vocational limitations, and earning implications. Requires structured vocational intake and a qualified vocational expert's approval.",
  category: "Core",
  permission: "report.export",
  approval: "physician_required",
  requiredExpert: "vocational",
  gate: "standard",
  formats: [],
  configSchema: z.object({}).strict(),
  defaultConfig: {},
  compose() {
    throw new Error("Vocational Assessment requires the expert workflow (not yet available). No document can be generated.");
  },
};

const FORENSIC_ECONOMIST_REPORT: ReportDefinition = {
  id: "FORENSIC_ECONOMIST_REPORT",
  serviceTier: "core",
  name: "Forensic Economist Report",
  description:
    "Expert-reviewed economic analysis of claimed financial losses, future earning capacity, benefits, household services, and present value. Every assumption must be explicitly entered and sourced; requires economist approval and attestation.",
  category: "Core",
  permission: "report.export",
  approval: "physician_required",
  requiredExpert: "economist",
  gate: "standard",
  formats: [],
  configSchema: z.object({}).strict(),
  defaultConfig: {},
  compose() {
    throw new Error("Forensic Economist Report requires the expert workflow (not yet available). No document can be generated.");
  },
};

export const REPORTS: ReportDefinition[] = [
  LIFE_CARE_PLAN,
  TESTIMONY_PACK,
  MEDICAL_CHRONOLOGY,
  MEDICAL_RECORD_SUMMARY,
  COST_PROJECTION,
  VOCATIONAL_ASSESSMENT,
  FORENSIC_ECONOMIST_REPORT,
  MEDICAL_NECESSITY,
  PROVIDER_MATRIX,
  FUTURE_CARE_SUMMARY,
  DEFENSE_REBUTTAL,
  CAUSATION_ANALYSIS,
  PHYSICIAN_REVIEW_REPORT,
  DAMAGES_SUMMARY,
  CUSTOM,
];

// Which validation findings are RELEVANT to each report type — case-insensitive
// regex tested against `result` + `issue`. The integrity check scopes its
// display to the selected report; the export gates are unaffected (blocking is
// blocking regardless of which findings a reader chose to look at).
export const FINDING_RELEVANCE: Record<string, string> = {
  LIFE_CARE_PLAN: ".*",
  TESTIMONY_PACK: ".*",
  CUSTOM: ".*",
  MEDICAL_CHRONOLOGY: "citation drift|chronolog|record|document",
  MEDICAL_RECORD_SUMMARY: "citation drift|diagnosis|record|document|support",
  COST_PROJECTION: "pricing|code|bundled|cost|life-expectancy|inclusion|duplicate|double-count",
  MEDICAL_COST_PROJECTION: "pricing|code|bundled|cost|life-expectancy|inclusion|duplicate|double-count",
  VOCATIONAL_ASSESSMENT: "vocational|work|function|restriction|employ|capacity",
  FORENSIC_ECONOMIST_REPORT: "pricing|cost|life-expectancy|econom|discount|inflation|assumption",
  FUTURE_CARE_SUMMARY: "support|review|inclusion|frequency|duration|indication|duplicate|replaced",
  DAMAGES_SUMMARY: "pricing|code|bundled|life-expectancy|support|duplicate|inclusion",
  MEDICAL_NECESSITY: "necessity|support|evidence|literature|citation|indication|narrative|laterality|frequency|duration",
  DEFENSE_REBUTTAL: "necessity|support|evidence|literature|citation|duplicate|double-count|narrative|laterality",
  CAUSATION_ANALYSIS: "diagnosis|causation|laterality|support|evidence|pre-existing",
  PROVIDER_MATRIX: "provider|recommendation|citation drift",
  PHYSICIAN_REVIEW_REPORT: "review|approval|physician",
};

export function findingRelevance(id: string): string {
  return FINDING_RELEVANCE[id] ?? ".*";
}

// Legacy stored id → current id (rows are never rewritten).
const ID_ALIASES: Record<string, string> = { COST_PROJECTION: "MEDICAL_COST_PROJECTION" };

export function getReport(id: string): ReportDefinition | undefined {
  id = ID_ALIASES[id] ?? id;
  return REPORTS.find((r) => r.id === id);
}

// ── Gate (docs/22 §4) — the single pure gate the API calls ───────────────────

export interface GateContext {
  mode: "draft" | "final";
  /** Any persisted export-blocking validation finding exists. */
  blocking: boolean;
  /** Recommendations with a recorded physician decision (approve/modify/reject). */
  decidedCount: number;
  /** Included-in-totals items still awaiting a physician decision. */
  includedUndecided: number;
}

export interface GateResult {
  ok: boolean;
  reason?: string;
}

/**
 * Approval & gating matrix:
 * - PHYSICIAN_REVIEW_REPORT is meaningless with zero decisions — refused in any mode.
 * - Draft is otherwise always allowed; the renderer stamps the draft banner.
 * - FINAL + physician_required: refused while any included item is undecided or
 *   any export-blocking finding is open. No bypass.
 * - FINAL + standard gate: refused while an export-blocking finding is open
 *   (same rule as the legacy Life Care Plan final export).
 * - disclose-gated reports are factual and always exportable — but their
 *   compose appends the Unresolved Issues section whenever blocking findings
 *   exist, so the problems ship on the face of the document.
 */
export function gateReport(def: Pick<ReportDefinition, "id" | "approval" | "gate" | "requiresDecided">, ctx: GateContext): GateResult {
  if (def.requiresDecided && ctx.decidedCount < 1) {
    return { ok: false, reason: "This report requires at least one physician-decided recommendation." };
  }
  if (ctx.mode === "draft") return { ok: true };
  if (def.approval === "physician_required") {
    if (ctx.includedUndecided > 0) {
      return { ok: false, reason: "Final export requires every included recommendation to be physician approved, modified, or rejected." };
    }
    if (ctx.blocking) {
      return { ok: false, reason: "Final export is blocked while critical validation issues remain unresolved." };
    }
  }
  if (def.gate === "standard" && ctx.blocking) {
    return { ok: false, reason: "Final export is blocked while critical validation issues remain unresolved." };
  }
  return { ok: true };
}
