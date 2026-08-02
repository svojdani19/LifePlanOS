// ─────────────────────────────────────────────────────────────────────────────
// Future Damages Evaluation engine (MDIP — docs/28). logicVersion "fde-1".
//
// PURE + DETERMINISTIC. No Prisma, no LLM, no Date.now, no randomness, no I/O.
// Given an identical FdeInput snapshot it always returns an identical
// (deep-equal) FdeResult. Every outcome is justified by NAMED factors derived
// ONLY from the input — nothing is ever invented.
//
// DECISION RULES (evaluated strictly in this order):
//  1. ADDITIONAL_INFO_REQUIRED — the record base cannot support ANY opinion:
//     export-blocking findings >= 3, OR documentsCount === 0, OR one or more
//     missing-record signals (findings mentioning missing/record, derived by
//     the caller).
//  2. NO_REPORT_INDICATED — no active item carries PROBABLE or POSSIBLE
//     probability AND no active item is lifetime/permanent care. ("Active" =
//     not contingency-only and not physician-REJECTED.)
//  3. LCP family — care breadth indicates a full Life Care Plan: any active
//     lifetime item, OR attendant-care category, OR equipment category
//     (DME / SUPPLIES / ASSISTIVE_TECH / MOBILITY_AID / ORTHOTICS_PROSTHETICS),
//     OR multi-specialty breadth (>= 3 distinct active care categories). Then:
//       a. + economic signal (econAssumptionCount > 0 OR findings mentioning
//          earnings/wage/income)                     → LCP_PLUS_VOC_ECON
//          (an economic-loss opinion presupposes the vocational foundation,
//          so the econ signal always carries the vocational add-on with it)
//       b. + vocational signal only (vocationalEntryCount > 0 OR findings
//          mentioning work restriction)              → LCP_PLUS_VOCATIONAL
//       c. otherwise                                 → LCP_RECOMMENDED
//  4. MCP_RECOMMENDED — narrow future care: <= 2 distinct active categories,
//     no lifetime attendant care, and at least one documented future
//     procedure (a *_SURGERY / INJECTION category, or a service naming a
//     surgery/procedure/injection).
//  5. EXPERT_CONSULTATION — the ambiguous middle: real future-care signal but
//     neither the breadth of an LCP nor the narrow procedure shape of an MCP.
//
// estimatedMedicalRange is ONLY a range of the physician-reviewed projected
// medical costs currently in the case record (0.8×/1.2× of the summed PV of
// included PROBABLE/POSSIBLE, non-contingency, APPROVED/MODIFIED items). It
// is emitted only when at least one item has been physician-decided, and it
// is NEVER a case valuation.
// ─────────────────────────────────────────────────────────────────────────────

export const FDE_LOGIC_VERSION = "fde-1";

// ── Input snapshot ───────────────────────────────────────────────────────────

export interface FdeCondition {
  id?: string;
  name: string;
  relatedness: string; // Relatedness enum value
  evidenceSourceCount: number; // count of cited evidence sources
}

export interface FdeItem {
  id?: string;
  service: string;
  category: string; // CareCategory enum value
  probability: string; // Probability enum value
  physicianStatus: string; // PhysicianStatus enum value
  isLifetime: boolean;
  durationYears: number | null;
  presentValue: number;
  contingencyOnly: boolean;
  origin: string; // RecommendationOrigin enum value
}

export interface FdeFinding {
  id?: string;
  result: string;
  severity: string;
  exportBlocking: boolean;
}

export interface FdeInput {
  conditions: FdeCondition[];
  items: FdeItem[];
  findings: FdeFinding[];
  documentsCount: number;
  chronologyCount: number;
  vocationalEntryCount: number;
  econAssumptionCount: number;
  interviews: boolean;
  /** Finding texts mentioning missing records — derived by the caller from
   *  persisted findings; the engine never invents them. */
  missingRecordSignals: string[];
  /** Immutable persisted identifiers behind count/presence signals. Optional
   * for pure unit fixtures; production snapshots always provide these. */
  sourceIds?: {
    documents: string[];
    chronologyEvents: string[];
    vocationalEntries: string[];
    economicAssumptions: string[];
    interviewFindings: string[];
    missingRecordFindings: string[];
  };
}

// ── Result (matches the FutureDamagesEvaluation row shape) ───────────────────

export type FdeOutcome =
  | "NO_REPORT_INDICATED"
  | "ADDITIONAL_INFO_REQUIRED"
  | "MCP_RECOMMENDED"
  | "LCP_RECOMMENDED"
  | "LCP_PLUS_VOCATIONAL"
  | "LCP_PLUS_VOC_ECON"
  | "EXPERT_CONSULTATION";

export interface FdeFactor {
  factor: string;
  detail: string;
}

export interface FdeMedicalRange {
  lowPV: number;
  basePV: number;
  highPV: number;
  /** Fixed disclosure label — this is a range of included item PVs, never a
   *  case value. */
  label: string;
}

export interface FdeResult {
  logicVersion: typeof FDE_LOGIC_VERSION;
  overallOutcome: FdeOutcome;
  recommendedPrimaryProduct: string | null;
  recommendedAdditionalProducts: string[];
  readinessState: string;
  supportingFactors: FdeFactor[];
  weakeningFactors: FdeFactor[];
  missingInformation: FdeFactor[];
  unresolvedValidationIssues: number;
  estimatedMedicalRange: FdeMedicalRange | null;
  confidenceDimensions: {
    recordCompleteness: number;
    physicianReviewCoverage: number;
    evidenceSupport: number;
  };
  nextActions: string[];
  /** Stable identifiers of every input fact the decision drew on. */
  sourceFactIds: string[];
}

export const RANGE_LABEL =
  "Range of physician-reviewed projected medical costs currently in the case record — not a case valuation";

// ── Category groupings (CareCategory enum values) ────────────────────────────

const EQUIPMENT_CATEGORIES = new Set([
  "DME",
  "SUPPLIES",
  "ASSISTIVE_TECH",
  "MOBILITY_AID",
  "ORTHOTICS_PROSTHETICS",
]);

const ATTENDANT_CATEGORIES = new Set(["ATTENDANT_CARE", "SKILLED_NURSING"]);

const PROCEDURE_CATEGORIES = new Set([
  "ORTHOPEDIC_SURGERY",
  "NEUROSURGERY",
  "FUTURE_SURGERY",
  "REVISION_SURGERY",
  "INJECTION",
]);

const PROCEDURE_SERVICE_RE = /surger|procedure|injection|arthroplast|fusion|revision/i;
const WORK_RESTRICTION_RE = /work[\s-]*restrict|restrict.*work|return[\s-]*to[\s-]*work|light[\s-]*duty/i;
const EARNINGS_RE = /earning|wage|income|salary/i;

// ── Helpers ──────────────────────────────────────────────────────────────────

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Items eligible to drive the evaluation: not contingency-only (disclosed but
 *  never totaled) and not physician-rejected. */
function activeItems(input: FdeInput): FdeItem[] {
  return input.items.filter((i) => !i.contingencyOnly && i.physicianStatus !== "REJECTED");
}

function distinctCategories(items: FdeItem[]): string[] {
  return [...new Set(items.map((i) => i.category))].sort();
}

function listNames(values: string[], max = 4): string {
  const shown = values.slice(0, max);
  const extra = values.length - shown.length;
  return shown.join(", ") + (extra > 0 ? ` (+${extra} more)` : "");
}

const conditionFact = (c: FdeCondition) => `condition:${c.id ?? `legacy-name:${c.name}`}`;
const itemFact = (i: FdeItem) => `future-care-item:${i.id ?? `legacy-service:${i.service}`}`;
const findingFact = (f: FdeFinding) => `validation-finding:${f.id ?? `legacy-result:${f.result}`}`;

// ── Main evaluation ──────────────────────────────────────────────────────────

export function evaluateFutureDamages(input: FdeInput): FdeResult {
  const active = activeItems(input);
  const supportable = active.filter((i) => i.probability === "PROBABLE" || i.probability === "POSSIBLE");
  const lifetimeItems = active.filter((i) => i.isLifetime);
  const attendantItems = active.filter((i) => ATTENDANT_CATEGORIES.has(i.category));
  const equipmentItems = active.filter((i) => EQUIPMENT_CATEGORIES.has(i.category));
  const categories = distinctCategories(active);
  const blocking = input.findings.filter((f) => f.exportBlocking);
  const workRestrictionFindings = input.findings.filter((f) => WORK_RESTRICTION_RE.test(f.result));
  const earningsFindings = input.findings.filter((f) => EARNINGS_RE.test(f.result));
  const procedureItems = active.filter(
    (i) => PROCEDURE_CATEGORIES.has(i.category) || PROCEDURE_SERVICE_RE.test(i.service),
  );
  const decidedItems = input.items.filter((i) => i.physicianStatus !== "PENDING");
  const pendingItems = input.items.filter((i) => i.physicianStatus === "PENDING");
  const rejectedItems = input.items.filter((i) => i.physicianStatus === "REJECTED");
  const contingencyItems = input.items.filter((i) => i.contingencyOnly);
  const relatedConditions = input.conditions.filter(
    (c) => c.relatedness === "RELATED" || c.relatedness === "AGGRAVATION",
  );
  const evidencedConditions = input.conditions.filter((c) => c.evidenceSourceCount > 0);

  const vocSignal = input.vocationalEntryCount > 0 || workRestrictionFindings.length > 0;
  const econSignal = input.econAssumptionCount > 0 || earningsFindings.length > 0;
  const lcpBreadth =
    lifetimeItems.length > 0 ||
    attendantItems.length > 0 ||
    equipmentItems.length > 0 ||
    categories.length >= 3;

  const supporting: FdeFactor[] = [];
  const weakening: FdeFactor[] = [];
  const missing: FdeFactor[] = [];
  const sourceFactIds: string[] = [];

  // ── Named factors, every one traceable to an input fact ────────────────────
  if (relatedConditions.length > 0) {
    supporting.push({
      factor: "Causally related conditions documented",
      detail: `${relatedConditions.length} condition(s) marked related/aggravation: ${listNames(relatedConditions.map((c) => c.name))}`,
    });
    relatedConditions.forEach((c) => sourceFactIds.push(conditionFact(c)));
  }
  if (evidencedConditions.length > 0) {
    supporting.push({
      factor: "Record-cited condition evidence",
      detail: `${evidencedConditions.length} of ${input.conditions.length} condition(s) carry cited evidence sources`,
    });
  }
  if (lifetimeItems.length > 0) {
    supporting.push({
      factor: "Lifetime care recommended",
      detail: `${lifetimeItems.length} lifetime-duration item(s): ${listNames(lifetimeItems.map((i) => i.service))}`,
    });
    lifetimeItems.forEach((i) => sourceFactIds.push(itemFact(i)));
  }
  if (attendantItems.length > 0) {
    supporting.push({
      factor: "Attendant/skilled care in the plan",
      detail: listNames(attendantItems.map((i) => `${i.service} (${i.category})`)),
    });
    attendantItems.forEach((i) => sourceFactIds.push(itemFact(i)));
  }
  if (equipmentItems.length > 0) {
    supporting.push({
      factor: "Equipment/supply needs documented",
      detail: listNames(equipmentItems.map((i) => `${i.service} (${i.category})`)),
    });
    equipmentItems.forEach((i) => sourceFactIds.push(itemFact(i)));
  }
  if (categories.length >= 3) {
    supporting.push({
      factor: "Multi-specialty care breadth",
      detail: `${categories.length} distinct care categories: ${listNames(categories, 6)}`,
    });
  }
  if (procedureItems.length > 0) {
    supporting.push({
      factor: "Documented future procedure",
      detail: listNames(procedureItems.map((i) => i.service)),
    });
    procedureItems.forEach((i) => sourceFactIds.push(itemFact(i)));
  }
  if (vocSignal) {
    supporting.push({
      factor: "Vocational impact signal",
      detail:
        input.vocationalEntryCount > 0
          ? `${input.vocationalEntryCount} vocational intake entr(ies) on file`
          : `Work-restriction finding(s): ${listNames(workRestrictionFindings.map((f) => f.result))}`,
    });
    sourceFactIds.push(...(input.sourceIds?.vocationalEntries.map((id) => `vocational-entry:${id}`) ?? [`count:vocationalEntries=${input.vocationalEntryCount}`]));
    workRestrictionFindings.forEach((f) => sourceFactIds.push(findingFact(f)));
  }
  if (econSignal) {
    supporting.push({
      factor: "Economic-loss signal",
      detail:
        input.econAssumptionCount > 0
          ? `${input.econAssumptionCount} sourced economic assumption(s) entered`
          : `Earnings-related finding(s): ${listNames(earningsFindings.map((f) => f.result))}`,
    });
    sourceFactIds.push(...(input.sourceIds?.economicAssumptions.map((id) => `economic-assumption:${id}`) ?? [`count:econAssumptions=${input.econAssumptionCount}`]));
    earningsFindings.forEach((f) => sourceFactIds.push(findingFact(f)));
  }
  if (input.interviews) {
    supporting.push({
      factor: "Interview findings on file",
      detail: "Structured patient/provider interview findings supplement the records",
    });
    sourceFactIds.push(...(input.sourceIds?.interviewFindings.map((id) => `interview-finding:${id}`) ?? ["count:interviews=present"]));
  }

  if (blocking.length > 0) {
    weakening.push({
      factor: "Export-blocking validation findings",
      detail: `${blocking.length} blocking finding(s): ${listNames(blocking.map((f) => f.result))}`,
    });
    blocking.forEach((f) => sourceFactIds.push(findingFact(f)));
  }
  if (pendingItems.length > 0) {
    weakening.push({
      factor: "Physician review incomplete",
      detail: `${pendingItems.length} of ${input.items.length} item(s) await physician decision`,
    });
  }
  if (rejectedItems.length > 0) {
    weakening.push({
      factor: "Physician-rejected recommendations",
      detail: `${rejectedItems.length} item(s) rejected on review: ${listNames(rejectedItems.map((i) => i.service))}`,
    });
    rejectedItems.forEach((i) => sourceFactIds.push(itemFact(i)));
  }
  if (contingencyItems.length > 0) {
    weakening.push({
      factor: "Contingency-only items excluded",
      detail: `${contingencyItems.length} item(s) are disclosed contingencies and never totaled: ${listNames(contingencyItems.map((i) => i.service))}`,
    });
    contingencyItems.forEach((i) => sourceFactIds.push(itemFact(i)));
  }
  const unclearConditions = input.conditions.filter((c) => c.relatedness === "UNCLEAR");
  if (unclearConditions.length > 0) {
    weakening.push({
      factor: "Unresolved causation",
      detail: `${unclearConditions.length} condition(s) still marked UNCLEAR: ${listNames(unclearConditions.map((c) => c.name))}`,
    });
    unclearConditions.forEach((c) => sourceFactIds.push(conditionFact(c)));
  }

  if (input.documentsCount === 0) {
    missing.push({ factor: "No medical records on file", detail: "0 documents uploaded — nothing can be evaluated from the record" });
  }
  for (const signal of input.missingRecordSignals) {
    missing.push({ factor: "Missing-record signal", detail: signal });
    const signalIndex = input.missingRecordSignals.indexOf(signal);
    const findingId = input.sourceIds?.missingRecordFindings[signalIndex];
    sourceFactIds.push(findingId ? `validation-finding:${findingId}` : `legacy-signal:${signal}`);
  }
  if (input.chronologyCount === 0) {
    missing.push({ factor: "No treatment chronology", detail: "0 chronology events — the treatment course has not been reconstructed" });
  }
  if (!input.interviews) {
    missing.push({ factor: "No interview findings", detail: "No patient/provider interview findings supplement the records" });
  }
  if (lcpBreadth && !vocSignal) {
    missing.push({ factor: "No vocational intake", detail: "0 vocational entries and no work-restriction findings — earning-capacity impact is undeveloped" });
  }
  if (lcpBreadth && !econSignal) {
    missing.push({ factor: "No economic assumptions", detail: "0 sourced economic assumptions — no basis for an economic-loss opinion" });
  }
  sourceFactIds.push(
    ...(input.sourceIds?.documents.map((id) => `document:${id}`) ?? [`count:documents=${input.documentsCount}`]),
    ...(input.sourceIds?.chronologyEvents.map((id) => `chronology-event:${id}`) ?? [`count:chronology=${input.chronologyCount}`]),
  );

  // ── Outcome (rules 1–5, strictly ordered — see module header) ──────────────
  let overallOutcome: FdeOutcome;
  if (blocking.length >= 3 || input.documentsCount === 0 || input.missingRecordSignals.length > 0) {
    overallOutcome = "ADDITIONAL_INFO_REQUIRED";
  } else if (supportable.length === 0 && lifetimeItems.length === 0) {
    overallOutcome = "NO_REPORT_INDICATED";
  } else if (lcpBreadth) {
    if (econSignal) overallOutcome = "LCP_PLUS_VOC_ECON";
    else if (vocSignal) overallOutcome = "LCP_PLUS_VOCATIONAL";
    else overallOutcome = "LCP_RECOMMENDED";
  } else if (
    categories.length <= 2 &&
    attendantItems.filter((i) => i.isLifetime).length === 0 &&
    procedureItems.length > 0
  ) {
    overallOutcome = "MCP_RECOMMENDED";
  } else {
    overallOutcome = "EXPERT_CONSULTATION";
  }

  // ── Product mapping + readiness + next actions per outcome ─────────────────
  const products: Record<FdeOutcome, { primary: string | null; additional: string[] }> = {
    NO_REPORT_INDICATED: { primary: null, additional: [] },
    ADDITIONAL_INFO_REQUIRED: { primary: null, additional: [] },
    MCP_RECOMMENDED: { primary: "MEDICAL_COST_PROJECTION", additional: [] },
    LCP_RECOMMENDED: { primary: "LIFE_CARE_PLAN", additional: [] },
    LCP_PLUS_VOCATIONAL: { primary: "LIFE_CARE_PLAN", additional: ["VOCATIONAL_ASSESSMENT"] },
    LCP_PLUS_VOC_ECON: {
      primary: "LIFE_CARE_PLAN",
      additional: ["VOCATIONAL_ASSESSMENT", "FORENSIC_ECONOMIST_REPORT"],
    },
    EXPERT_CONSULTATION: { primary: "EXPERT_CONSULTATION", additional: [] },
  };

  const readiness: Record<FdeOutcome, string> = {
    NO_REPORT_INDICATED: "NO_ACTION_INDICATED",
    ADDITIONAL_INFO_REQUIRED: "RECORDS_INCOMPLETE",
    MCP_RECOMMENDED: "READY_FOR_ENGAGEMENT",
    LCP_RECOMMENDED: "READY_FOR_ENGAGEMENT",
    LCP_PLUS_VOCATIONAL: "READY_FOR_ENGAGEMENT",
    LCP_PLUS_VOC_ECON: "READY_FOR_ENGAGEMENT",
    EXPERT_CONSULTATION: "NEEDS_EXPERT_TRIAGE",
  };

  const nextActionsByOutcome: Record<FdeOutcome, string[]> = {
    NO_REPORT_INDICATED: [
      "No future-damages report is indicated on the current record",
      "Re-evaluate if new records, diagnoses, or recommendations arrive",
    ],
    ADDITIONAL_INFO_REQUIRED: [
      "Obtain the missing records identified in the gap list",
      "Resolve export-blocking validation findings",
      "Re-run the evaluation once records are complete",
    ],
    MCP_RECOMMENDED: [
      "Engage a Medical Cost Projection for the documented procedure(s)",
      "Complete physician review of any pending items",
    ],
    LCP_RECOMMENDED: [
      "Engage a full Life Care Plan",
      "Complete physician review of pending recommendations",
    ],
    LCP_PLUS_VOCATIONAL: [
      "Engage a Life Care Plan with a vocational assessment",
      "Complete the vocational intake with the retained expert",
    ],
    LCP_PLUS_VOC_ECON: [
      "Engage a Life Care Plan with vocational and economic-loss analyses",
      "Confirm sourced economic assumptions with the forensic economist",
    ],
    EXPERT_CONSULTATION: [
      "Request an expert consultation to scope the appropriate report",
      "Clarify causation and care breadth before selecting a product",
    ],
  };

  // ── Estimated medical range — only with >= 1 physician-decided item ────────
  const rangeBasis = input.items.filter(
    (i) =>
      !i.contingencyOnly &&
      (i.physicianStatus === "APPROVED" || i.physicianStatus === "MODIFIED") &&
      (i.probability === "PROBABLE" || i.probability === "POSSIBLE"),
  );
  let estimatedMedicalRange: FdeMedicalRange | null = null;
  if (decidedItems.length > 0 && rangeBasis.length > 0) {
    const basePV = rangeBasis.reduce((s, i) => s + i.presentValue, 0);
    estimatedMedicalRange = { lowPV: 0.8 * basePV, basePV, highPV: 1.2 * basePV, label: RANGE_LABEL };
    rangeBasis.forEach((i) => sourceFactIds.push(itemFact(i)));
  }

  // ── Confidence dimensions (0–100, purely count-derived) ────────────────────
  const recordCompleteness =
    input.documentsCount === 0
      ? 0
      : clamp(
          30 +
            Math.min(25, input.documentsCount * 5) +
            Math.min(25, input.chronologyCount * 2) +
            (input.interviews ? 10 : 0) -
            15 * Math.min(2, input.missingRecordSignals.length),
        );
  const physicianReviewCoverage =
    input.items.length === 0 ? 0 : clamp((100 * decidedItems.length) / input.items.length);
  const evidenceSupport =
    input.conditions.length === 0
      ? 0
      : clamp((100 * evidencedConditions.length) / input.conditions.length);

  return {
    logicVersion: FDE_LOGIC_VERSION,
    overallOutcome,
    recommendedPrimaryProduct: products[overallOutcome].primary,
    recommendedAdditionalProducts: products[overallOutcome].additional,
    readinessState: readiness[overallOutcome],
    supportingFactors: supporting,
    weakeningFactors: weakening,
    missingInformation: missing,
    unresolvedValidationIssues: input.findings.length,
    estimatedMedicalRange,
    confidenceDimensions: { recordCompleteness, physicianReviewCoverage, evidenceSupport },
    nextActions: nextActionsByOutcome[overallOutcome],
    sourceFactIds: [...new Set(sourceFactIds)],
  };
}

// ── Lower-cost option explanation ────────────────────────────────────────────

/** One-sentence, outcome-specific explanation of whether the lower-cost
 *  Medical Cost Projection could substitute for the recommended product. */
export function explainLowerCostOption(outcome: FdeOutcome): string {
  switch (outcome) {
    case "MCP_RECOMMENDED":
      return "A Medical Cost Projection is the recommended product here: the future care is narrow and procedure-focused, so a full Life Care Plan would add cost without adding scope.";
    case "LCP_RECOMMENDED":
      return "A Medical Cost Projection may not suffice: the documented care spans lifetime or multi-specialty needs that an MCP's narrow procedure focus cannot capture.";
    case "LCP_PLUS_VOCATIONAL":
      return "A Medical Cost Projection would not suffice: beyond the breadth of care, the documented vocational impact requires an earning-capacity analysis an MCP never includes.";
    case "LCP_PLUS_VOC_ECON":
      return "A Medical Cost Projection would not suffice: the case carries lifetime-care breadth plus earnings impact, which requires the full Life Care Plan with vocational and economic-loss analyses.";
    case "EXPERT_CONSULTATION":
      return "Whether the lower-cost Medical Cost Projection suffices is exactly what the expert consultation will determine — the current record is ambiguous between a narrow and a comprehensive report.";
    case "ADDITIONAL_INFO_REQUIRED":
      return "No product — including the lower-cost Medical Cost Projection — can be responsibly scoped until the identified record gaps are filled.";
    case "NO_REPORT_INDICATED":
      return "No report, including a Medical Cost Projection, is indicated on the current record; re-evaluate if new care recommendations arrive.";
  }
}
