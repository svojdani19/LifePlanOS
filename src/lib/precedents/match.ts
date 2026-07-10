// ─────────────────────────────────────────────────────────────────────────────
// Precedent "likeness" matching. Scores a finalized LCP in the firm library
// against the active case across the attributes that make a plan a good
// comparable/precedent: injury specialty, diagnosis + ICD-10, jurisdiction,
// mechanism, patient age, the mix of future-care categories, and cost scale.
// Deterministic and explainable — every point is attributed to a factor.
// ─────────────────────────────────────────────────────────────────────────────

export interface CaseFeatures {
  injurySpecialty?: string | null;
  icd10Code?: string | null;
  diagnosis?: string | null;
  jurisdiction?: string | null;
  mechanism?: string | null;
  age?: number | null;
  careCategories?: string[];
  presentValue?: number | null;
}

export interface PrecedentLike extends CaseFeatures {
  id: string;
  title: string;
  careCategories?: string[];
}

export interface MatchFactor {
  label: string;
  weight: number;
  got: number;
  note: string;
}
export interface PrecedentMatch {
  likeness: number; // 0–100
  factors: MatchFactor[];
}

const tokens = (s?: string | null) => new Set((s || "").toLowerCase().match(/[a-z0-9]+/g) || []);
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  const inter = [...a].filter((x) => b.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni ? inter / uni : 0;
}
const stateOf = (j?: string | null) => (j || "").trim().slice(0, 2).toUpperCase();

export function scorePrecedent(c: CaseFeatures, p: CaseFeatures): PrecedentMatch {
  const factors: MatchFactor[] = [];
  const add = (label: string, weight: number, got: number, note: string) => factors.push({ label, weight, got, note });

  // Injury specialty — the strongest signal a plan is comparable.
  const specMatch = !!(c.injurySpecialty && p.injurySpecialty && c.injurySpecialty === p.injurySpecialty);
  add("Injury specialty", 25, specMatch ? 25 : 0, specMatch ? "same injury specialty" : "different specialty");

  // ICD-10 — exact code, or same 3-character category.
  let icd = 0;
  let icdNote = "no ICD-10 overlap";
  if (c.icd10Code && p.icd10Code) {
    if (c.icd10Code.toUpperCase() === p.icd10Code.toUpperCase()) { icd = 20; icdNote = `exact ICD-10 ${c.icd10Code}`; }
    else if (c.icd10Code.slice(0, 3).toUpperCase() === p.icd10Code.slice(0, 3).toUpperCase()) { icd = 12; icdNote = `same ICD-10 category ${c.icd10Code.slice(0, 3)}`; }
  }
  add("ICD-10", 20, icd, icdNote);

  // Diagnosis wording overlap.
  const dx = jaccard(tokens(c.diagnosis), tokens(p.diagnosis));
  add("Diagnosis", 15, Math.round(dx * 15), dx > 0 ? `${Math.round(dx * 100)}% diagnosis-term overlap` : "different diagnosis");

  // Jurisdiction — same forum, or same state.
  let jur = 0;
  let jurNote = "different jurisdiction";
  if (c.jurisdiction && p.jurisdiction) {
    if (c.jurisdiction.toLowerCase() === p.jurisdiction.toLowerCase()) { jur = 15; jurNote = "same jurisdiction"; }
    else if (stateOf(c.jurisdiction) === stateOf(p.jurisdiction)) { jur = 8; jurNote = "same state"; }
  }
  add("Jurisdiction", 15, jur, jurNote);

  // Mechanism of injury.
  const mech = jaccard(tokens(c.mechanism), tokens(p.mechanism));
  add("Mechanism", 10, Math.round(mech * 10), mech > 0 ? "similar mechanism" : "different mechanism");

  // Patient age band.
  let age = 0;
  let ageNote = "age not comparable";
  if (c.age != null && p.age != null) {
    const d = Math.abs(c.age - p.age);
    if (d <= 5) { age = 8; ageNote = `within ${d} yrs of age`; }
    else if (d <= 10) { age = 4; ageNote = `within ${d} yrs of age`; }
    else ageNote = `${d} yrs apart in age`;
  }
  add("Age", 8, age, ageNote);

  // Future-care category mix.
  const cat = jaccard(new Set(c.careCategories || []), new Set(p.careCategories || []));
  add("Care mix", 12, Math.round(cat * 12), cat > 0 ? `${Math.round(cat * 100)}% care-category overlap` : "different care mix");

  // Cost scale (present value proximity).
  let cost = 0;
  let costNote = "cost not comparable";
  if (c.presentValue && p.presentValue) {
    const r = Math.abs(c.presentValue - p.presentValue) / Math.max(c.presentValue, p.presentValue);
    if (r <= 0.25) { cost = 5; costNote = "present value within 25%"; }
    else if (r <= 0.5) { cost = 2; costNote = "present value within 50%"; }
    else costNote = "present value differs materially";
  }
  add("Cost", 5, cost, costNote);

  const maxW = factors.reduce((s, f) => s + f.weight, 0);
  const got = factors.reduce((s, f) => s + f.got, 0);
  return { likeness: Math.round((got / maxW) * 100), factors };
}

export function rankPrecedents<T extends PrecedentLike>(c: CaseFeatures, precedents: T[]): (T & { match: PrecedentMatch })[] {
  return precedents
    .map((p) => ({ ...p, match: scorePrecedent(c, { ...p, careCategories: (Array.isArray(p.careCategories) ? p.careCategories : []) as string[] }) }))
    .sort((a, b) => b.match.likeness - a.match.likeness);
}
