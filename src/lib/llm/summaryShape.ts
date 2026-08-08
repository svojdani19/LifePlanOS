// ─────────────────────────────────────────────────────────────────────────────
// What a record's one-line summary should SAY.
//
// A reviewer reading a chronology is reconstructing a course of care. The
// summary of each entry has to serve that: what kind of contact this was, what
// was found, and what was decided. Two failure modes make it useless instead,
// and both were visible in a real case file:
//
//   • BOILERPLATE LEADS. "Keep the injured part elevated" is printed on every
//     discharge sheet in the country. It is a real sentence in the record and
//     it is worthless for understanding what happened that day, so it must
//     never be the line a reviewer reads first.
//   • METADATA MASQUERADES AS CONTENT. "Encounter Date: Jul 18" is a field
//     label. Restating it tells the reader something they can already see in
//     the date column, and it displaces the fact that mattered.
//
// So the summary is COMPOSED, not picked: the entry's own kind decides which
// clauses it should carry — an encounter has a presenting complaint, an
// assessment and a plan; a study has an impression; a billing line has a
// charge; an operation has a procedure and the agent given — and
// non-substantive text is barred from leading, whatever field it arrived in.
//
// WHICH clauses a kind carries, and in what order, is no longer asserted here.
// It is measured from the professionally published plans in the reference
// corpus; see `summaryEmphasis.ts` for the derivation and what it settled.
// This file owns the composition rules that are true regardless of kind:
// boilerplate may not lead, metadata is not a fact, and a summary that lists
// everything is not a summary.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnalysisClass } from "@/lib/documents/analysisClass";
import { emphasisFor, selectClauses, type EmphasisProfile } from "@/lib/llm/summaryEmphasis";

/**
 * Generic patient-education and discharge boilerplate. It is genuinely in the
 * record, so it is not discarded — it simply may never LEAD, because it says
 * nothing about this patient on this day.
 */
const BOILERPLATE_RE =
  /\b(?:keep (?:the )?(?:injured|affected) (?:part|area|limb)|elevat\w+ (?:the )?(?:injured|affected|extremity)|apply (?:ice|a cold pack)|ice (?:the area |it )?for \d+|call (?:your|the) (?:doctor|provider|physician|nurse|office) if|return (?:to (?:the )?(?:emergency(?: department| room)?|ed\b|hospital|clinic)|here)[^.]{0,40}\bif\b|seek (?:immediate )?medical attention if|take (?:your )?medication(?:s)? as (?:directed|prescribed)|drink plenty of fluids|get plenty of rest|as needed for (?:pain|discomfort)|follow (?:these|the) instructions|read (?:the|this) (?:information|medication guide)|warning signs|when to call|home care instructions|do not drive (?:while|if) (?:taking|you)|wash your hands|keep the (?:wound|incision) (?:clean and )?dry)\b/i;

/**
 * Field labels and record furniture restated as if they were findings. These
 * carry no fact at all: the date column already says the date, and the header
 * already says whose chart it is.
 */
const METADATA_RESTATEMENT_RE =
  /^\s*(?:encounter|service|visit|admission|discharge|collection|order|report|print(?:ed)?|signed|received|fax)?\s*date\s*(?:of\s*(?:service|birth))?\s*[:\-]|^\s*(?:patient|client)\s*(?:name|id)?\s*[:\-]|^\s*(?:dob|d\.o\.b\.|mrn|medical record (?:number|no)|account (?:number|no)|chart (?:number|no)|visit (?:number|no)|claim (?:number|no))\s*[:\-]|^\s*page\s+\d+\s*(?:of\s*\d+)?\s*$|^\s*(?:facility|location|provider|physician|clinician)\s*[:\-]\s*\S+\s*$/i;

/**
 * Intake recitals: the smoking, alcohol, allergy, immunisation and social
 * questions every chart asks at every visit. They are real answers about the
 * patient and they are not what happened that day — "Encounter — Never smoker"
 * was a real summary of an emergency visit for a fall. They stay in the claims,
 * where a reviewer sees them under the history they belong to.
 */
// A denial is only a recital when what is denied is an intake TOPIC. "Denies
// tobacco use" is the smoking question; "denies relief from six weeks of
// therapy" is a documented treatment failure and among the most useful facts
// on the page.
const INTAKE_TOPIC = "(?:tobacco|smoking|nicotine|alcohol|illicit|recreational drug|drug use|substance use|allerg\\w+)";
const INTAKE_RECITAL_RE = new RegExp(
  [
    `^\\s*(?:never|non|not a|former|current)[- ]?smok\\w*`,
    `^\\s*(?:denies|no history of|negative for)\\b[^.]{0,40}\\b${INTAKE_TOPIC}\\b`,
    `\\b${INTAKE_TOPIC}\\s*(?:use|abuse|history)?\\s*[:\\-]?\\s*(?:none|never|no|denies|denied|negative|non[- ]?\\w+)\\b`,
    `^\\s*(?:does not|doesn't) (?:use|drink|smoke)\\b`,
    `^\\s*(?:no known (?:drug )?allergies|nkda|nka)\\b`,
    `^\\s*(?:family|social) history\\b`,
    `\\bvaccin\\w* series\\b`,
    `\\bimmuniz\\w+ (?:up to date|current)\\b`,
    `^\\s*(?:marital status|lives (?:alone|with))\\b`,
  ].join("|"),
  "i",
);

/** A standing fact about the patient, not an event of this encounter. */
export function isIntakeRecital(value: string): boolean {
  return INTAKE_RECITAL_RE.test(value);
}

/** Does this value say nothing a reviewer can use? */
export function isNonSubstantive(value: string): boolean {
  return METADATA_RESTATEMENT_RE.test(value);
}

/** True content, but never the headline. */
export function isBoilerplate(value: string): boolean {
  return BOILERPLATE_RE.test(value);
}

/**
 * Fields whose label states what KIND of statement the clause is, not merely
 * which column it came from. These keep their label even when they lead.
 */
const EVIDENTIAL_LABELS = new Set(["impression", "admission", "causationOpinion", "opinion"]);

/** How many clauses a summary may carry before it stops being a summary. */
const MAX_CLAUSES = 3;

export interface SummaryClaim {
  field: string;
  value: string;
}

/**
 * Compose the summary for one entry: an opening label naming what kind of
 * contact this was, then the clauses its kind calls for.
 *
 * Returns null when nothing substantive is available, so the caller can fall
 * back rather than print a label with no content behind it.
 */
export interface ChosenClause {
  field: string;
  prefix: string;
  share: number;
  value: string;
}

/**
 * Which clauses this record supports and keeps, in reading order.
 *
 * Separated from the rendering so that the learning harness can ask what the
 * program CHOSE to lead with — and score that against what the planner led
 * with — without parsing the rendered string back apart.
 *
 * `override` swaps in a candidate profile, so a proposal derived from one set
 * of published plans can be scored on plans it never saw.
 */
export function chooseSummaryClauses(
  klass: AnalysisClass | null | undefined,
  claims: SummaryClaim[],
  override?: EmphasisProfile | null,
): ChosenClause[] {
  const profile = override ?? emphasisFor(klass);
  if (!profile) return [];

  const usable = claims.filter((c) => c.value.trim().length > 2 && !isNonSubstantive(c.value));
  const used = new Set<string>();

  // Which of this kind's clauses the record actually supports, in the order the
  // published plans read them. A clause can arrive under more than one field
  // name, so the first field that carries usable text wins the slot.
  const available = profile.clauses.flatMap((clause) => {
    for (const field of clause.fields) {
      // Boilerplate is barred from the summary entirely: it is available in the
      // entry's claims, where a reviewer can see it in context.
      const hit = usable.find((c) => c.field === field && !used.has(c.value) && !isBoilerplate(c.value) && !isIntakeRecital(c.value));
      if (!hit) continue;
      used.add(hit.value);
      return [{ field, prefix: clause.prefix, share: clause.share, value: hit.value }];
    }
    return [];
  });

  // Over the cap, the clauses the planner says most often about this kind of
  // record are the ones that keep their place — never simply the first few.
  return selectClauses(available, MAX_CLAUSES);
}

export function composeSummary(
  klass: AnalysisClass | null | undefined,
  label: string,
  claims: SummaryClaim[],
  clip: (s: string, n: number) => string,
  override?: EmphasisProfile | null,
): string | null {
  const selected = chooseSummaryClauses(klass, claims, override);
  const clauses = selected.map((clause, position) => {
    // Clauses are joined with semicolons, so a clause that arrived as a whole
    // sentence sheds its full stop — "…low back pain.; assessment: …" reads as
    // a defect. An elision is not a full stop and stays.
    const sentence = clause.value.replace(/^[A-Z][a-z]+:\s*/, "").trim();
    const text = clip(position < selected.length - 1 ? sentence.replace(/\.$/, "") : sentence, 110);
    // A headline clause usually needs no label — "Surgery — procedure: X"
    // says "procedure" twice. But some labels are not decoration: an
    // IMPRESSION is the radiologist's conclusion rather than a raw finding,
    // and an ADMISSION is testimony against the deponent's own interest.
    // Dropping those would erase what kind of statement the reader is looking
    // at, so they keep their label wherever they appear.
    const keepLabel = position > 0 || EVIDENTIAL_LABELS.has(clause.field);
    return keepLabel ? `${clause.prefix}${text}` : text;
  });

  if (!clauses.length) return null;
  const body = clauses.join("; ");
  return `${label} — ${/[.!?…]$/.test(body) ? body : `${body}.`}`;
}
