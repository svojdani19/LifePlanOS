// ─────────────────────────────────────────────────────────────────────────────
// Record grounding for FUTURE-CARE generation.
//
// The extraction pipeline established a rule for facts: nothing appears
// without documented support. This module applies the same rule to the care
// plan's DRAFT — the layer that, ungated, produced wheelchairs for patients
// who walk into clinic and $211k medication bundles against $9k of documented
// generics.
//
// Three instruments, all deterministic over validated claims:
//   • A SEVERITY GATE: catastrophic-tier template items (mobility equipment,
//     home modification, attendant care…) require documented functional
//     deficits. A template's opinion of a diagnosis is not evidence about
//     this patient.
//   • A SURGICAL GATE: future/revision surgery templates require a documented
//     treating-provider recommendation touching the same anatomy. Projection
//     conventions never invent operations.
//   • DOCUMENTED-MEDICATION ITEMS: per-drug lines built from medication
//     claims, replacing the flat bundle.
// Plus the mining path: treating-provider RECOMMENDED/PLANNED claims become
// draft items in their own right, each carrying its citation.
//
// A gated-out template is never silently discarded: the suppression list is
// disclosed as a review finding, and a physician may add any item back —
// authored, attributed, and gated exactly as physician additions always were.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";

export interface CitedText {
  text: string;
  excerpt: string;
  filename: string;
  page: number | null;
  date: string | null; // ISO
  provider: string | null;
}

export interface RecordCareSupport {
  /** Treating-provider recommended / planned care, cited. */
  recommendations: CitedText[];
  /** Medication claims, cited. */
  medications: CitedText[];
  /** Functional-status / restriction claim values. */
  functionalMarkers: string[];
  /** Normalized corpus of all clinical claim text, for support matching. */
  corpus: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

const ACTIVE = ["AI_DRAFT", "AI_AUDIT_PASSED", "HUMAN_EDITED", "REVIEWED", "VERIFIED"];

/** Load the case's validated-claim support surface. Tenant-scoped by caseId. */
const INPATIENT_CONTEXT_RE = /inpatient|hospital|med.?surg|icu|emergency|admission|discharge summary|ambulance|transport|nursing/i;

export async function loadRecordCareSupport(caseId: string, dateOfInjury?: Date | null): Promise<RecordCareSupport> {
  const encounters = await prisma.extractedEncounter.findMany({
    // Only encounters classified as CLINICAL care inform the plan; ancillary
    // logs and paperwork do not (their claims still appear in reports).
    where: { caseId, status: { in: ACTIVE }, OR: [{ substanceClass: null }, { substanceClass: "CLINICAL" }] },
    select: { claims: true, encounterDate: true, provider: true, sourceDocumentId: true, encounterType: true },
  });
  const doiIso = dateOfInjury ? dateOfInjury.toISOString().slice(0, 10) : null;
  const docIds = [...new Set(encounters.map((e) => e.sourceDocumentId))];
  const docs = await prisma.document.findMany({ where: { id: { in: docIds } }, select: { id: true, filename: true } });
  const nameOf = new Map(docs.map((d) => [d.id, d.filename]));

  const recommendations: CitedText[] = [];
  const medications: CitedText[] = [];
  const functionalMarkers: string[] = [];
  const corpusParts: string[] = [];

  for (const e of encounters) {
    const claims = Array.isArray(e.claims) ? (e.claims as { field?: string; claimType?: string; value?: string; excerpt?: string; page?: number | null }[]) : [];
    for (const c of claims) {
      const value = (c.value ?? "").trim();
      if (!value) continue;
      corpusParts.push(value);
      const cited: CitedText = {
        text: value,
        excerpt: (c.excerpt ?? "").slice(0, 300),
        filename: nameOf.get(e.sourceDocumentId) ?? "record on file",
        page: c.page ?? null,
        date: e.encounterDate ? e.encounterDate.toISOString().slice(0, 10) : null,
        provider: e.provider,
      };
      if (c.claimType === "RECOMMENDED_TREATMENT" || c.claimType === "PLANNED_TREATMENT" || c.field === "recommendations") {
        recommendations.push(cited);
      }
      const inpatientContext = INPATIENT_CONTEXT_RE.test(e.encounterType ?? "");
      const preInjury = doiIso != null && cited.date != null && cited.date < doiIso;
      // Medications: the documented OUTPATIENT regimen. Inpatient medication
      // administration (an eMAR line during an admission) is care received,
      // not a maintenance regimen to project forward.
      if ((c.field === "medications" || c.claimType === "MEDICATION") && !inpatientContext) medications.push(cited);
      // Functional markers: BASELINE status only. "Total assist" on
      // post-operative day one, an ambulance transport certification, or any
      // pre-injury note describes a moment, not the patient's baseline — and
      // catastrophic lifetime care must never be projected from a moment.
      if ((c.field === "functionalStatus" || c.field === "restrictions" || c.claimType === "FUNCTIONAL_STATUS") && !inpatientContext && !preInjury) {
        functionalMarkers.push(value);
      }
    }
  }
  return { recommendations, medications, functionalMarkers, corpus: norm(corpusParts.join(" \n ")) };
}

// ── Severity gate ────────────────────────────────────────────────────────────

/** Categories that presuppose catastrophic functional impairment. */
export const CATASTROPHIC_CATEGORIES = new Set<string>([
  "MOBILITY_AID",
  "HOME_MODIFICATION",
  "VEHICLE_MODIFICATION",
  "ATTENDANT_CARE",
  "SKILLED_NURSING",
  "ASSISTIVE_TECH",
  "CASE_MANAGEMENT",
  "SUPPLIES",
  "TRANSPORTATION",
]);

const SEVERITY_RE =
  /\b(?:wheelchair|non-?ambulatory|unable to (?:walk|ambulate)|bed ?(?:confined|bound)|dependent (?:for|in|with) (?:adls?|activities of daily living|transfers|mobility)|(?:max(?:imum)?|total) assist|hoyer|paraplegi|quadriplegi|tetraplegi|hemiplegi|ventilator|24.?hour (?:care|supervision)|cannot (?:perform|complete) adls?)\b/i;

/**
 * Do the documented functional markers support catastrophic-tier care? The
 * bar is explicit documentation of major functional dependence — not pain,
 * not restrictions, not a diagnosis label.
 */
export function severitySupportsCatastrophic(functionalMarkers: string[]): { supported: boolean; marker: string | null } {
  for (const m of functionalMarkers) {
    if (SEVERITY_RE.test(m)) return { supported: true, marker: m.slice(0, 160) };
  }
  return { supported: false, marker: null };
}

// ── Surgical gate ────────────────────────────────────────────────────────────

export const SURGICAL_CATEGORIES = new Set<string>([
  "FUTURE_SURGERY",
  "REVISION_SURGERY",
  "ORTHOPEDIC_SURGERY",
  "NEUROSURGERY",
  // Complication management projects the sequelae of a procedure; it is held
  // to the same documented-recommendation standard as the procedure itself.
  "COMPLICATION_MANAGEMENT",
]);

const SURGICAL_TOKENS = [
  "fusion", "discectomy", "decompression", "laminectomy", "arthroplasty", "replacement", "arthroscop",
  "meniscectomy", "repair", "acdf", "orif", "stimulator", "kyphoplasty", "surgery", "surgical", "operation",
];
const ANATOMY_TOKENS = ["cervical", "thoracic", "lumbar", "lumbosacral", "knee", "hip", "shoulder", "spine", "wrist", "ankle", "elbow", "foot", "hand"];

function tokensIn(text: string, tokens: string[]): Set<string> {
  const t = norm(text);
  const found = new Set<string>();
  for (const tok of tokens) if (t.includes(tok)) found.add(tok);
  return found;
}

/**
 * A surgical template survives only when some documented recommendation talks
 * about surgery on the SAME anatomy. "Recommend lumbar surgery" grounds a
 * lumbar fusion item; it grounds nothing cervical.
 */
export function surgicalSupport(service: string, recommendations: CitedText[]): { supported: boolean; citation: CitedText | null } {
  const svcAnatomy = tokensIn(service, ANATOMY_TOKENS);
  for (const rec of recommendations) {
    const recSurgical = tokensIn(rec.text, SURGICAL_TOKENS);
    if (!recSurgical.size) continue;
    const recAnatomy = tokensIn(rec.text, ANATOMY_TOKENS);
    // Anatomy must overlap when the template names anatomy; an anatomy-free
    // template ("surgical follow-up") accepts any surgical recommendation.
    if (!svcAnatomy.size || [...svcAnatomy].some((a) => recAnatomy.has(a))) {
      return { supported: true, citation: rec };
    }
  }
  return { supported: false, citation: null };
}

// ── Template gate ────────────────────────────────────────────────────────────

export interface TemplateGate {
  allowed: boolean;
  reason: string | null; // suppression reason (reviewable), null when allowed
  citation: CitedText | null; // support citation when one grounds the item
}

/**
 * Catastrophic CONTENT, whatever its category: care whose premise is major
 * neurological injury or dependence. A stray "myelomalacia" in one MRI
 * impression can match a spinal-cord-injury condition bucket; the $660k
 * pressure-injury/UTI package that bucket carries still requires a patient the
 * records show to be dependent.
 */
const CATASTROPHIC_CONTENT_RE =
  /\b(?:pressure (?:injur|ulcer|sore)|neurogenic (?:bowel|bladder)|spinal cord injur|\bsci\b|urinary catheter|ostomy|ventilator|tracheostom|peg tube|dysreflexia)\b/i;

export function gateTemplateItem(
  t: { category: string; service: string; rationale?: string },
  support: RecordCareSupport,
): TemplateGate {
  if (CATASTROPHIC_CONTENT_RE.test(`${t.service} ${t.rationale ?? ""}`)) {
    const s = severitySupportsCatastrophic(support.functionalMarkers);
    if (!s.supported) {
      return {
        allowed: false,
        citation: null,
        reason: `"${t.service}" presupposes major neurological injury or dependence that the records do not document.`,
      };
    }
  }
  if (SURGICAL_CATEGORIES.has(t.category)) {
    const s = surgicalSupport(t.service, support.recommendations);
    if (!s.supported) {
      return {
        allowed: false,
        citation: null,
        reason: `No documented treating-provider recommendation supports "${t.service}"; a surgical projection requires one.`,
      };
    }
    return { allowed: true, reason: null, citation: s.citation };
  }
  if (CATASTROPHIC_CATEGORIES.has(t.category)) {
    const s = severitySupportsCatastrophic(support.functionalMarkers);
    if (!s.supported) {
      return {
        allowed: false,
        citation: null,
        reason: `The records document no functional dependence supporting "${t.service}" (${t.category.replace(/_/g, " ").toLowerCase()}).`,
      };
    }
    return { allowed: true, reason: null, citation: null };
  }
  // Ordinary condition-driven care (visits, therapy, imaging, injections,
  // psych, labs…) stays: it is the reviewable clinical scaffolding, priced
  // conservatively and pending physician review like everything else.
  return { allowed: true, reason: null, citation: null };
}

// ── Documented medications ──────────────────────────────────────────────────

export interface DocumentedMedication {
  drug: string;
  occurrences: number; // distinct DATES documented
  citation: CitedText;
}

/**
 * Injury-care drug classes eligible for auto-costing (apportionment: the plan
 * projects injury care, so a documented statin or diabetes agent — real,
 * cited, and visible in the medication history — is not costed here).
 */
const INJURY_MED_RE =
  /\b(?:ibuprofen|naproxen|meloxicam|celecoxib|diclofenac|ketoprofen|acetaminophen|gabapentin|pregabalin|duloxetine|amitriptyline|nortriptyline|methocarbamol|cyclobenzaprine|baclofen|tizanidine|carisoprodol|metaxalone|hydrocodone|oxycodone|tramadol|morphine|hydromorphone|codeine|lidocaine|capsaicin|topiramate|prednisone|methylprednisolone)\b/i;

const DRUG_STOP = new Set(["patient", "medication", "medications", "current", "daily", "tablet", "capsule", "oral", "take", "takes", "with", "prn", "dose", "history", "list", "reconciliation", "administered", "given", "dispensed"]);

/**
 * Distinct documented INJURY-CARE drugs. The drug name is the leading
 * alphabetic token of a medication claim ("Gabapentin 300mg PO TID" →
 * gabapentin). Maintenance status = documented on TWO OR MORE DISTINCT DATES —
 * a drug charted twice during one admission is one episode, not a regimen.
 * Non-injury-class drugs are excluded from costing here (they remain fully
 * visible in the medication-history report).
 */
export function documentedMedications(medClaims: CitedText[]): DocumentedMedication[] {
  const byDrug = new Map<string, { dates: Set<string>; citation: CitedText }>();
  for (const claim of medClaims) {
    // A claim may list several drugs, separated by ; or newline.
    for (const part of claim.text.split(/[;\n]+/)) {
      const m = part.trim().match(/^([A-Za-z][A-Za-z-]{3,})(?:\s+\(([A-Za-z-]{3,})\))?/);
      if (!m) continue;
      const name = m[1].toLowerCase();
      if (DRUG_STOP.has(name)) continue;
      if (!INJURY_MED_RE.test(name)) continue;
      const cur = byDrug.get(name);
      const date = claim.date ?? "undated";
      if (cur) cur.dates.add(date);
      else byDrug.set(name, { dates: new Set([date]), citation: { ...claim, text: part.trim().slice(0, 160) } });
    }
  }
  return [...byDrug.entries()]
    .filter(([, v]) => v.dates.size >= 2) // maintenance: two or more distinct documented dates
    .map(([drug, v]) => ({ drug: drug[0].toUpperCase() + drug.slice(1), occurrences: v.dates.size, citation: v.citation }))
    .sort((a, b) => b.occurrences - a.occurrences);
}

// ── Mined recommendations → draft items ─────────────────────────────────────

export interface MinedItem {
  category: string;
  service: string;
  specialty: string;
  unitCost: number;
  frequencyPerYear: number;
  durationYears: number | null;
  isLifetime: boolean;
  citation: CitedText;
}

/** Conservative default pricing, always labeled as requiring verification. */
const MINED_DEFAULTS: { re: RegExp; category: string; specialty: string; unitCost: number; frequencyPerYear: number; durationYears: number | null; isLifetime: boolean; label: (m: string) => string }[] = [
  { re: /\b(?:fusion|discectomy|laminectomy|decompression|arthroplasty|replacement|arthroscop\w*|orif|kyphoplasty)\b|\bsurger/i, category: "FUTURE_SURGERY", specialty: "Surgery", unitCost: 45_000, frequencyPerYear: 1, durationYears: 0, isLifetime: false, label: (m) => m },
  { re: /\b(?:epidural|injection|nerve block|radiofrequency|ablation|facet)\b/i, category: "INJECTION", specialty: "Pain Management", unitCost: 3_200, frequencyPerYear: 2, durationYears: 3, isLifetime: false, label: (m) => m },
  { re: /\bfunctional restoration\b/i, category: "PAIN_MANAGEMENT", specialty: "Pain Management", unitCost: 30_000, frequencyPerYear: 1, durationYears: 0, isLifetime: false, label: () => "Functional restoration program" },
  { re: /\b(?:physical therapy|occupational therapy|\bpt\b|rehab)/i, category: "PHYSICAL_THERAPY", specialty: "Rehabilitation", unitCost: 205, frequencyPerYear: 12, durationYears: 2, isLifetime: false, label: () => "Physical therapy (as recommended)" },
  { re: /\b(?:mri|ct scan|x-?ray|emg|ncv|imaging)\b/i, category: "IMAGING", specialty: "Radiology", unitCost: 1_800, frequencyPerYear: 1, durationYears: 1, isLifetime: false, label: (m) => m },
  { re: /\b(?:neuropsych|psycholog|psychiatr|counseling)\b/i, category: "PSYCH", specialty: "Behavioral Health", unitCost: 302, frequencyPerYear: 4, durationYears: 2, isLifetime: false, label: (m) => m },
];

/**
 * Turn documented recommendations into draft items where a confident category
 * mapping exists. Anything unmappable is NOT invented into a costed line — it
 * remains visible in the records for the planner to act on.
 */
/** Conditional or hypothetical language: not a recommendation to cost. */
const HYPOTHETICAL_RE = /^\s*if\b|\b(?:if (?:needed|indicated|necessary|symptoms persist)|possible option|may be considered|in the event|should (?:the|symptoms|it)\b|as needed only)\b/i;

export function mineRecommendedItems(recommendations: CitedText[], existingServices: string[]): MinedItem[] {
  const existing = existingServices.map(norm);
  const out: MinedItem[] = [];
  const seen = new Set<string>();
  const MAX_MINED = 12; // a draft, not an inventory — one item per category+anatomy
  for (const rec of recommendations) {
    if (out.length >= MAX_MINED) break;
    // "If X occurs…" and "a possible option" are contingencies. They stay
    // visible as documented recommendations; they do not become costed items.
    if (HYPOTHETICAL_RE.test(rec.text)) continue;
    // The text must RECOMMEND care, not merely mention it: "stop taking OTC
    // medications prior to surgery" mentions surgery and prescribes nothing.
    if (!/\b(?:recommend\w*|advis\w*|candidate for|plan(?:ned)? (?:for|to)|will undergo|scheduled for|refer(?:red|ral)? (?:for|to)|prescrib\w*|order(?:ed)?\b|initiate)\b/i.test(rec.text)) continue;
    // A recommendation about PAPERWORK ("request the missing records",
    // "obtain outside imaging reports") is case administration, not care.
    if (/\b(?:request(?:ing)?\b[^.]{0,40}\brecords?|records? (?:request|be (?:obtained|requested))|obtain(?:ing)?\b[^.]{0,40}\b(?:records?|reports?)|missing records?)\b/i.test(rec.text)) continue;
    for (const rule of MINED_DEFAULTS) {
      const m = rec.text.match(rule.re);
      if (!m) continue;
      const service = rule.label(rec.text.replace(/\s+/g, " ").trim().slice(0, 90));
      // ONE mined item per category + anatomy: five notes recommending the
      // same lumbar injection series are one recommendation, not five items.
      const anatomy = [...tokensIn(rec.text, ANATOMY_TOKENS)].sort().join("-") || "general";
      const key = `${rule.category}|${anatomy}`;
      if (seen.has(key)) break;
      // Skip when a surviving template already covers this ground.
      const svcTokens = [...tokensIn(rec.text, [...SURGICAL_TOKENS, ...ANATOMY_TOKENS, "therapy", "injection", "mri", "restoration", "psych"])];
      if (existing.some((s) => svcTokens.filter((tok) => s.includes(tok)).length >= 2)) break;
      seen.add(key);
      out.push({
        category: rule.category,
        service,
        specialty: rule.specialty,
        unitCost: rule.unitCost,
        frequencyPerYear: rule.frequencyPerYear,
        durationYears: rule.durationYears,
        isLifetime: rule.isLifetime,
        citation: rec,
      });
      break; // first matching rule wins for this recommendation
    }
  }
  return out;
}

/** Rationale text carrying the citation, exemplar-style. */
export function citedRationale(prefix: string, c: CitedText): string {
  const who = [c.provider, c.date ? c.date.split("-").reverse().join("/") : null].filter(Boolean).join(", ");
  const pages = c.page != null ? `p. ${c.page}` : "page unknown";
  return `${prefix}${who ? ` (${who})` : ""}: "${c.excerpt.slice(0, 180)}" (${c.filename}: ${pages})`;
}
