// ─────────────────────────────────────────────────────────────────────────────
// Recommendation consistency & conflict resolution.
//
// Every other engine analyzes ONE recommendation in isolation. This module looks
// at the SET together and answers: do any two recommendations relate — and if so,
// how? It classifies each relevant pair as
//   • mutually_exclusive — competing pathways for the same problem/period,
//   • sequential        — one follows the other (conservative→surgery, primary→revision),
//   • duplicate         — the same/overlapping service counted twice,
//   • concurrent        — complementary care that legitimately coexists (no action),
// resolves genuine conflicts (never letting cost override medical probability),
// and emits findings that block export when mutually exclusive or duplicated
// pathways are BOTH totaled. It never edits or deletes a recommendation — it
// annotates and flags, so the physician-review and cost workflows are untouched.
//
// Pure and deterministic; unit-tested directly.
// ─────────────────────────────────────────────────────────────────────────────

import { bodyRegion } from "@/lib/engine/integrity";

export type RecRelationType = "mutually_exclusive" | "sequential" | "duplicate" | "concurrent";
type RecKind = "definitive_surgery" | "revision" | "conservative" | "mobility_low" | "mobility_high" | "other";

export interface ConsistencyRec {
  id: string;
  service: string;
  category?: string | null;
  conditionId?: string | null;
  probability?: string; // PROBABLE | POSSIBLE | SPECULATIVE | NOT_SUPPORTED
  confidence?: number;
  presentValue?: number;
  durationYears?: number | null;
  isLifetime?: boolean;
  startTrigger?: string | null;
  replacesService?: string | null; // the recommendation this one supersedes when triggered
  contingencyOnly?: boolean; // disclosed but never totaled
  includedInTotal?: boolean;
}

export interface RecRelation {
  a: string; // rec id
  b: string; // rec id
  type: RecRelationType;
  basis: string;
}

export interface RecResolution {
  keep: string; // rec id retained as the primary pathway
  other: string; // rec id deferred / classified as alternative
  action: "keep_both" | "classify_alternative" | "stage";
  reason: string;
  costTiebreak: boolean; // true only when probability & support tied and cost decided it
}

export interface ConsistencyFinding {
  recommendation: string;
  result: string;
  issue: string;
  severity: "Critical" | "High" | "Moderate" | "Low";
  suggestedCorrection: string;
  exportBlocking: boolean;
}

export interface RecNote {
  conflictsWith: string[]; // other services this one relates to
  relationship?: RecRelationType;
  resolution?: string; // human-readable resolution sentence
}

export interface ConsistencyResult {
  relations: RecRelation[];
  resolutions: RecResolution[];
  findings: ConsistencyFinding[];
  notes: Map<string, RecNote>; // keyed by rec id
}

const PROB_RANK: Record<string, number> = { PROBABLE: 3, POSSIBLE: 2, SPECULATIVE: 1, NOT_SUPPORTED: 0 };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const svc = (r: ConsistencyRec) => r.service;

const SURGERY_CATS = new Set(["ORTHOPEDIC_SURGERY", "NEUROSURGERY", "FUTURE_SURGERY"]);
const CONSERVATIVE_CATS = new Set(["PHYSICAL_THERAPY", "OCCUPATIONAL_THERAPY", "PAIN_MANAGEMENT", "INJECTION", "MEDICATION"]);

function kindOf(r: ConsistencyRec): RecKind {
  const s = r.service.toLowerCase();
  const c = (r.category ?? "").toUpperCase();
  if (c === "REVISION_SURGERY" || /\brevision\b/.test(s)) return "revision";
  if (SURGERY_CATS.has(c) || /\b(arthroplasty|replacement|fusion|arthrodesis|laminectomy|discectomy|reconstruction|decompression|osteotomy)\b/.test(s)) return "definitive_surgery";
  if (/\b(power (?:wheel)?chair|wheelchair|scooter)\b/.test(s)) return "mobility_high";
  if (/\b(walker|rollator|cane|crutch)\b/.test(s)) return "mobility_low";
  if (CONSERVATIVE_CATS.has(c) || /\b(injection|physical therapy|conservative|medication|therapy)\b/.test(s)) return "conservative";
  return "other";
}

const hasFailTrigger = (r: ConsistencyRec): boolean =>
  /\b(if|fail|failure|persist|refractory|progress|deterior|worsen|inadequate|despite|survivorship|when|should)\b/i.test(r.startTrigger ?? "");
const isShortTerm = (r: ConsistencyRec): boolean => !r.isLifetime && (r.durationYears ?? 99) <= 2;
const region = (r: ConsistencyRec) => bodyRegion(r.service);

function sameProblem(a: ConsistencyRec, b: ConsistencyRec): boolean {
  if (a.conditionId && b.conditionId) return a.conditionId === b.conditionId;
  const ra = region(a);
  return ra !== "general" && ra === region(b);
}

// Classify a relevant pair. Returns null for independent/complementary pairs.
function relate(a: ConsistencyRec, b: ConsistencyRec): { type: RecRelationType; basis: string } | null {
  if (norm(a.service) === norm(b.service)) return { type: "duplicate", basis: "the same service is listed twice" };
  // Explicit staged replacement metadata (§10) is authoritative: one supersedes
  // the other when triggered, so they are sequential, not concurrent.
  if ((a.replacesService && norm(a.replacesService) === norm(b.service)) || (b.replacesService && norm(b.replacesService) === norm(a.service))) {
    return { type: "sequential", basis: "one recommendation explicitly replaces the other when its trigger fires" };
  }
  if (!sameProblem(a, b)) return null; // different problem/region → independent (concurrent)

  const ka = kindOf(a);
  const kb = kindOf(b);
  const kinds = new Set([ka, kb]);

  if (ka === "conservative" && kb === "conservative" && (a.category ?? "") === (b.category ?? "")) {
    return { type: "duplicate", basis: "overlapping conservative-therapy entries for the same region" };
  }
  if (kinds.has("revision") && kinds.has("definitive_surgery")) {
    return { type: "sequential", basis: "a revision procedure follows the primary procedure if the implant fails" };
  }
  if (ka === "definitive_surgery" && kb === "definitive_surgery") {
    return { type: "mutually_exclusive", basis: "two definitive surgical pathways for the same region cannot both occur" };
  }
  if (kinds.has("conservative") && kinds.has("definitive_surgery")) {
    const surg = ka === "definitive_surgery" ? a : b;
    const cons = ka === "conservative" ? a : b;
    if (hasFailTrigger(surg) || hasFailTrigger(cons)) return { type: "sequential", basis: "conservative care first; surgery is triggered only if it fails" };
    if (cons.isLifetime) return { type: "mutually_exclusive", basis: "lifelong conservative care for the same condition conflicts with definitive surgery" };
    return { type: "sequential", basis: "conservative measures precede definitive surgery" };
  }
  if (kinds.has("mobility_low") && kinds.has("mobility_high")) {
    const low = ka === "mobility_low" ? a : b;
    const high = ka === "mobility_high" ? a : b;
    if (isShortTerm(low) && high.isLifetime) return { type: "sequential", basis: "a short-term walker transitions to long-term wheeled mobility" };
    if (low.isLifetime && high.isLifetime) return { type: "mutually_exclusive", basis: "lifetime independent ambulation and permanent wheelchair dependence cannot both hold" };
    return { type: "sequential", basis: "staged mobility support" };
  }
  return { type: "concurrent", basis: "complementary care for the same region" };
}

const supportScore = (r: ConsistencyRec) => (r.confidence ?? 0) + (r.includedInTotal ? 100 : 0);

// Resolve a mutually-exclusive pair per the fixed priority: medical probability →
// record support → cost (only as a last tiebreak). Cost never overrides probability.
function resolveExclusive(a: ConsistencyRec, b: ConsistencyRec): RecResolution {
  const pa = PROB_RANK[a.probability ?? "POSSIBLE"] ?? 2;
  const pb = PROB_RANK[b.probability ?? "POSSIBLE"] ?? 2;
  if (pa !== pb) {
    const [k, o] = pa > pb ? [a, b] : [b, a];
    return { keep: k.id, other: o.id, action: "classify_alternative", costTiebreak: false, reason: `${svc(k)} is more medically probable (${k.probability}) than ${svc(o)} (${o.probability}); ${svc(o)} is retained as an alternative rather than totaled alongside it.` };
  }
  const sa = supportScore(a);
  const sb = supportScore(b);
  if (sa !== sb) {
    const [k, o] = sa > sb ? [a, b] : [b, a];
    return { keep: k.id, other: o.id, action: "classify_alternative", costTiebreak: false, reason: `Both are equally probable; ${svc(k)} is better supported by the objective record and treating documentation, so ${svc(o)} is classified as the alternative.` };
  }
  const [k, o] = (a.presentValue ?? 0) >= (b.presentValue ?? 0) ? [a, b] : [b, a];
  return { keep: k.id, other: o.id, action: "classify_alternative", costTiebreak: true, reason: `${svc(k)} and ${svc(o)} are equally probable and equally supported; ${svc(k)} is retained on a cost basis only — confirm its pricing basis is valid before relying on the higher figure.` };
}

export function analyzeConsistency(recs: ConsistencyRec[]): ConsistencyResult {
  const relations: RecRelation[] = [];
  const resolutions: RecResolution[] = [];
  const findings: ConsistencyFinding[] = [];
  const notes = new Map<string, RecNote>();
  const byId = new Map(recs.map((r) => [r.id, r]));
  const note = (id: string): RecNote => {
    let n = notes.get(id);
    if (!n) { n = { conflictsWith: [] }; notes.set(id, n); }
    return n;
  };

  for (let i = 0; i < recs.length; i++) {
    for (let j = i + 1; j < recs.length; j++) {
      const a = recs[i];
      const b = recs[j];
      const rel = relate(a, b);
      if (!rel || rel.type === "concurrent") continue;
      relations.push({ a: a.id, b: b.id, type: rel.type, basis: rel.basis });
      const na = note(a.id);
      const nb = note(b.id);
      na.conflictsWith.push(svc(b));
      nb.conflictsWith.push(svc(a));
      na.relationship = na.relationship ?? rel.type;
      nb.relationship = nb.relationship ?? rel.type;

      if (rel.type === "mutually_exclusive") {
        const res = resolveExclusive(a, b);
        resolutions.push(res);
        const keptSvc = svc(byId.get(res.keep)!);
        const otherSvc = svc(byId.get(res.other)!);
        note(res.keep).resolution = res.reason;
        note(res.other).resolution = res.reason;
        // Both totaled → this is the contradiction the sprint targets: block export.
        if (a.includedInTotal && b.includedInTotal) {
          findings.push({
            recommendation: `${keptSvc} vs ${otherSvc}`,
            result: "Mutually exclusive recommendations both totaled",
            issue: `${rel.basis}, yet both are included in the damages total.`,
            severity: "Critical",
            suggestedCorrection: `Include only ${keptSvc}; reclassify ${otherSvc} as an alternative/contingency and exclude it from the total. ${res.reason}`,
            exportBlocking: true,
          });
        }
      } else if (rel.type === "duplicate") {
        if (a.includedInTotal && b.includedInTotal) {
          findings.push({
            recommendation: `${svc(a)} / ${svc(b)}`,
            result: "Duplicate / overlapping recommendations both totaled",
            issue: `${rel.basis}; counting both double-counts the same care.`,
            severity: "High",
            suggestedCorrection: "Consolidate into a single recommendation, or exclude one, before export.",
            exportBlocking: true,
          });
        }
        note(a.id).resolution = "Consolidate with the overlapping entry; do not total both.";
        note(b.id).resolution = "Consolidate with the overlapping entry; do not total both.";
      } else if (rel.type === "sequential") {
        // Sequential care is allowed (both may be included), but the later stage
        // must carry a documented trigger/timing so it is not silently doubled.
        const later = kindOf(a) === "revision" ? a : kindOf(b) === "revision" ? b : kindOf(a) === "definitive_surgery" ? a : b;
        const earlier = later === a ? b : a;
        note(a.id).resolution = note(b.id).resolution = `Sequential: ${rel.basis}. Both may be planned; the later stage is contingent, not concurrent.`;
        if (later.includedInTotal && !hasFailTrigger(later) && kindOf(later) === "revision") {
          findings.push({
            recommendation: svc(later),
            result: "Sequential recommendation lacks a documented trigger",
            issue: `${svc(later)} follows ${svc(earlier)} but no failure/survivorship trigger or timing basis is recorded.`,
            severity: "Moderate",
            suggestedCorrection: "Record the trigger (e.g. implant survivorship / documented failure) and earliest expected timing so the staged cost is not treated as concurrent.",
            exportBlocking: false,
          });
        }
      }
    }
  }

  return { relations, resolutions, findings, notes };
}
