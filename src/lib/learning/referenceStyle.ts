// ─────────────────────────────────────────────────────────────────────────────
// Learning HOW a professional writes, without learning WHAT they wrote.
//
// A finalized life care plan is the only ground truth this program has for what
// an experienced planner considers worth saying. The temptation is to reuse the
// sentences. That would be catastrophic: one patient's findings appearing in
// another patient's plan is fabricated evidence with a professional's voice on
// it, and it would be undetectable by the person signing.
//
// So the artifact this module produces is FACT-FREE by construction. It carries
// counts, distributions and ordering — how long a sentence runs, which clause a
// chronology entry leads with, how often the passive voice appears, which
// section headings recur, how a necessity paragraph connects diagnosis to
// function. It cannot carry a name, a date, a finding or a recommendation,
// because nothing in its shape has anywhere to put one.
//
// `assertFactFree` is the enforcement, and it runs on every profile before it
// can be persisted or used: a profile containing a digit sequence that could be
// a date, an MRN, a measurement, or any capitalised multi-word proper noun is
// rejected rather than sanitised. Sanitising invites a near-miss; refusing does
// not.
// ─────────────────────────────────────────────────────────────────────────────

export interface StyleProfile {
  /** Schema version, so a stored profile is never read under new rules. */
  version: string;
  /** Sentences per paragraph, and words per sentence — concision, measured. */
  medianSentenceWords: number;
  medianParagraphSentences: number;
  /** Share of sentences in the passive voice. Professionals use less than prose. */
  passiveShare: number;
  /** Share of sentences that open with a clinical noun rather than the patient. */
  clinicalLeadShare: number;
  /** Which clause type leads an entry, as a distribution over labels. */
  leadClauseDistribution: { label: string; share: number }[];
  /** Section KINDS, in the order plans present them. Never raw headings. */
  sectionOrder: SectionKind[];
  /** Connective phrases a planner uses to tie finding → function → care. */
  connectives: { phrase: string; perThousandWords: number }[];
  /** How many sources the corpus was built from, for weighting. */
  sampleSize: number;
}

export const STYLE_PROFILE_VERSION = "style-1";

// ── The free-text surface is closed, not filtered ────────────────────────────
// A regex that rejects "Memorial Hermann" also rejects "Medical Summary", and
// tuning it is a losing game played against patient data. So the profile stores
// only values drawn from vocabularies THIS FILE declares: a heading is mapped
// to a canonical kind or dropped, a lead clause to a known label or dropped.
// Nothing a plan contains can survive into the artifact verbatim.

export const SECTION_KINDS = [
  "medical_summary", "diagnoses", "chronology", "functional_status", "future_care",
  "cost_analysis", "vocational", "life_expectancy", "methodology", "references", "limitations",
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

const SECTION_PATTERNS: [SectionKind, RegExp][] = [
  ["medical_summary", /medical (?:summary|history|overview)|summary of (?:records|care)/i],
  ["diagnoses", /diagnos|impressions?|conditions?/i],
  ["chronology", /chronolog|timeline|course of (?:care|treatment)/i],
  ["functional_status", /functional|activities of daily living|\badl\b|limitations/i],
  ["future_care", /future (?:care|medical)|life care plan|care plan|recommendations?/i],
  ["cost_analysis", /cost|economic|present value|pricing/i],
  ["vocational", /vocational|employab|work capacity|earning/i],
  ["life_expectancy", /life expectancy|mortality/i],
  ["methodology", /methodolog|approach|standards?/i],
  ["references", /references?|bibliograph|literature|sources/i],
  ["limitations", /limitations?|assumptions?|caveats?|disclaimer/i],
];

/** A heading, reduced to a kind this file declares — or dropped. */
export function canonicalSection(heading: string): SectionKind | null {
  for (const [kind, re] of SECTION_PATTERNS) if (re.test(heading)) return kind;
  return null;
}

/** The clause labels a chronology entry may lead with. */
export const LEAD_LABELS = ["impression", "objective", "subjective", "plan", "procedure", "diagnostic", "functional", "medication", "disposition"] as const;
export type LeadLabel = (typeof LEAD_LABELS)[number];
export const canonicalLead = (label: string): LeadLabel | null =>
  (LEAD_LABELS as readonly string[]).includes(label.toLowerCase().trim()) ? (label.toLowerCase().trim() as LeadLabel) : null;

/** Any run of digits long enough to be a date, an identifier or a measurement. */
const DIGIT_RUN = /\d{2,}/;
/** Two or more consecutive capitalised words — a name, a facility, a product. */
const PROPER_NOUN = /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/;

export class FactLeakError extends Error {}

/**
 * Refuse a profile that could carry a patient fact.
 *
 * Applied to every string a profile contains, including the connective phrases
 * and the section headings, which are the only free text it holds.
 */
export function assertFactFree(profile: StyleProfile): void {
  const strings = [...profile.sectionOrder, ...profile.connectives.map((c) => c.phrase), ...profile.leadClauseDistribution.map((l) => l.label)];
  for (const s of strings) {
    if (DIGIT_RUN.test(s)) throw new FactLeakError(`Style profile rejected: "${s}" contains a digit run that could be a date, identifier or measurement.`);
    if (PROPER_NOUN.test(s)) throw new FactLeakError(`Style profile rejected: "${s}" contains a proper noun.`);
    if (s.length > 60) throw new FactLeakError(`Style profile rejected: "${s}" is long enough to be a sentence from a patient's plan.`);
  }
  // Belt and braces: every stored value must also come from a declared
  // vocabulary. The regexes above are the second line of defence, not the first.
  for (const k of profile.sectionOrder) {
    if (!(SECTION_KINDS as readonly string[]).includes(k)) throw new FactLeakError(`Style profile rejected: "${k}" is not a declared section kind.`);
  }
  for (const l of profile.leadClauseDistribution) {
    if (!(LEAD_LABELS as readonly string[]).includes(l.label)) throw new FactLeakError(`Style profile rejected: "${l.label}" is not a declared lead label.`);
  }
  for (const c of profile.connectives) {
    if (!CANDIDATE_CONNECTIVES.includes(c.phrase)) throw new FactLeakError(`Style profile rejected: "${c.phrase}" is not a declared connective.`);
  }
}

const WORDS = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};

const PASSIVE = /\b(?:was|were|been|being|is|are)\s+\w+(?:ed|en)\b/i;
/** Connectives worth learning: they carry the ARGUMENT, not the content. */
const CANDIDATE_CONNECTIVES = [
  "as a result of", "consequent to", "attributable to", "which limits", "resulting in",
  "in the setting of", "given the", "on that basis", "accordingly", "which is expected to",
  "secondary to", "notwithstanding", "to that end", "for that reason", "taken together",
];

export interface StyleSource {
  /** Paragraphs of a finalized report. Never persisted by this module. */
  paragraphs: string[];
  /** The plan's section headings, in order. */
  sections?: string[];
  /** The clause label leading each chronology entry, e.g. "impression". */
  leadClauses?: string[];
}

/**
 * Derive a style profile from finalized reports.
 *
 * The input is patient text. The OUTPUT is not: everything returned is a count,
 * a ratio, an ordering, or a phrase drawn from a fixed vocabulary this module
 * declares. `assertFactFree` runs before it is returned, so a profile that
 * somehow acquired a fact never reaches a caller.
 */
export function deriveStyleProfile(sources: readonly StyleSource[]): StyleProfile {
  const sentences: string[] = [];
  const paragraphSentenceCounts: number[] = [];
  let totalWords = 0;
  for (const src of sources) {
    for (const p of src.paragraphs) {
      const ss = p.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 4);
      if (!ss.length) continue;
      paragraphSentenceCounts.push(ss.length);
      sentences.push(...ss);
      totalWords += WORDS(p);
    }
  }
  const connectiveCounts = CANDIDATE_CONNECTIVES.map((phrase) => {
    const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const n = sources.reduce((a, s) => a + s.paragraphs.reduce((b, p) => b + (p.match(re)?.length ?? 0), 0), 0);
    return { phrase, perThousandWords: totalWords ? Math.round((1000 * n) / totalWords * 10) / 10 : 0 };
  }).filter((c) => c.perThousandWords > 0).sort((a, b) => b.perThousandWords - a.perThousandWords);

  const leads = sources.flatMap((s) => (s.leadClauses ?? []).map(canonicalLead).filter((l): l is LeadLabel => l !== null));
  const leadTally = new Map<string, number>();
  for (const l of leads) leadTally.set(l, (leadTally.get(l) ?? 0) + 1);

  // Section headings are kept only when they recur across sources — a heading
  // seen once could be case-specific ("Mr X's vocational history").
  const sectionTally = new Map<SectionKind, number>();
  for (const s of sources) {
    for (const h of s.sections ?? []) {
      const k = canonicalSection(h);
      if (k) sectionTally.set(k, (sectionTally.get(k) ?? 0) + 1);
    }
  }
  const recurring = [...sectionTally.entries()].filter(([, n]) => sources.length === 1 || n > 1).map(([h]) => h) as SectionKind[];

  const profile: StyleProfile = {
    version: STYLE_PROFILE_VERSION,
    medianSentenceWords: median(sentences.map(WORDS)),
    medianParagraphSentences: median(paragraphSentenceCounts),
    passiveShare: sentences.length ? Math.round((100 * sentences.filter((s) => PASSIVE.test(s)).length) / sentences.length) / 100 : 0,
    clinicalLeadShare: sentences.length ? Math.round((100 * sentences.filter((s) => !/^(?:the patient|he |she |mr\.|ms\.|mrs\.)/i.test(s)).length) / sentences.length) / 100 : 0,
    leadClauseDistribution: [...leadTally.entries()].map(([label, n]) => ({ label, share: Math.round((100 * n) / (leads.length || 1)) / 100 })).sort((a, b) => b.share - a.share),
    sectionOrder: recurring,
    connectives: connectiveCounts,
    sampleSize: sources.length,
  };
  assertFactFree(profile);
  return profile;
}

/**
 * The style profile as guidance a narrator can act on — still fact-free.
 *
 * This is what may be put in front of a model. It contains no patient content
 * from any case, so it cannot transfer one.
 */
export function styleGuidance(profile: StyleProfile): string[] {
  const g: string[] = [];
  if (profile.medianSentenceWords) g.push(`Target about ${profile.medianSentenceWords} words per sentence; professional plans are terser than clinical prose.`);
  if (profile.medianParagraphSentences) g.push(`Keep a paragraph to roughly ${profile.medianParagraphSentences} sentences.`);
  if (profile.clinicalLeadShare > 0.5) g.push("Lead with the clinical finding rather than with the patient's name.");
  if (profile.passiveShare < 0.4) g.push("Prefer the active voice.");
  if (profile.connectives.length) g.push(`Connect finding to consequence with phrases such as: ${profile.connectives.slice(0, 4).map((c) => c.phrase).join("; ")}.`);
  return g;
}
