// ─────────────────────────────────────────────────────────────────────────────
// What does this source actually ASSERT?
//
// The compatibility table answers "may a source of this STRENGTH establish this
// claim for a service of this KIND". It is a real gate and it is only half of
// one, because strength is a property of the source's provenance, not of its
// sentence. Every OBJECTIVE chronology finding pertinent to a knee therefore
// carried NECESSITY, FREQUENCY and DURATION for physical therapy identically —
// which is how the reference case ended up with 698 rows under each of three
// claims, the same 698 quotes filed three times.
//
// "MRI shows a full-thickness supraspinatus tear" says nothing whatsoever about
// how OFTEN therapy is needed. "Attends therapy twice weekly" does. The
// difference is semantic, so it is asked semantically:
//
//   statesDiagnosis              a named clinical condition, not a description
//   statesFunctionalDeficit      something the patient cannot do
//   statesPriorTreatment         care already delivered
//   statesTreatmentResponse      what that care achieved, or failed to
//   statesCadence                a rate — per week, every 6 months, BID
//   statesDuration               a span — for 12 weeks, lifelong, through age 18
//   supportsSpecificIntervention an objective finding bearing on whether the
//                                intervention is indicated — for OR against
//   providesCostBasis            a price, a charge, a billed code
//
// Both gates must pass. A source now produces a row for a claim only when it
// is the right KIND of source for that claim AND its text says something about
// it.
//
// Two rules keep this honest:
//
//   STRUCTURE BEATS LEXICON. Where the extraction already recorded which field
//   a quote came from — `functionalStatus`, `procedure`, `imagingFindings` —
//   that field decides, because it is a parsed fact rather than a guess about
//   English. The regexes below only run where structure is absent (interview
//   text, guideline prose) or to add an assertion the field cannot rule out.
//
//   SILENCE IS NOT DENIAL. A source that asserts nothing about frequency
//   produces no FREQUENCY row. It does not produce an OPPOSES row, and it does
//   not make the recommendation unsupported — it simply is not evidence about
//   frequency, which is what was being misrepresented.
// ─────────────────────────────────────────────────────────────────────────────

import type { EvidenceClaim } from "@/lib/engine/evidenceLedger";

export interface AssertionProfile {
  statesDiagnosis: boolean;
  statesFunctionalDeficit: boolean;
  statesPriorTreatment: boolean;
  statesTreatmentResponse: boolean;
  statesCadence: boolean;
  statesDuration: boolean;
  /**
   * An objective finding that bears on whether an intervention is indicated.
   * TOPICAL, not directional: "no structural abnormality" speaks to that
   * question as squarely as "full-thickness tear" does, and the row's `stance`
   * is what records which way it cuts. An earlier draft required pathology to
   * be PRESENT, which silently deleted every opposing finding — the exact
   * failure this module's own header warns about, in reverse.
   */
  supportsSpecificIntervention: boolean;
  providesCostBasis: boolean;
}

export const NO_ASSERTIONS: AssertionProfile = {
  statesDiagnosis: false,
  statesFunctionalDeficit: false,
  statesPriorTreatment: false,
  statesTreatmentResponse: false,
  statesCadence: false,
  statesDuration: false,
  supportsSpecificIntervention: false,
  providesCostBasis: false,
};

/**
 * Which assertions can carry which claim. ANY of the listed ones is enough —
 * a diagnosis and an objective pathological finding are different routes to
 * the same claim of necessity.
 */
export const CLAIM_REQUIRES: Record<EvidenceClaim, readonly (keyof AssertionProfile)[]> = {
  NECESSITY: ["statesDiagnosis", "supportsSpecificIntervention"],
  FREQUENCY: ["statesCadence"],
  DURATION: ["statesDuration"],
  FUNCTIONAL_NEED: ["statesFunctionalDeficit"],
  PRIOR_TREATMENT: ["statesPriorTreatment", "statesTreatmentResponse"],
  COST: ["providesCostBasis"],
};

export function assertionSupportsClaim(profile: AssertionProfile, claim: EvidenceClaim): boolean {
  return CLAIM_REQUIRES[claim].some((key) => profile[key]);
}

// ── Structured provenance ────────────────────────────────────────────────────
// The extraction's own field names. What a `functionalStatus` field contains is
// a functional status; no sentence analysis improves on that.

const FIELD_ASSERTS: Record<string, readonly (keyof AssertionProfile)[]> = {
  assessment: ["statesDiagnosis"],
  diagnosis: ["statesDiagnosis"],
  impression: ["statesDiagnosis"],
  pastMedicalHistory: ["statesDiagnosis"],
  imagingFindings: ["supportsSpecificIntervention"],
  objectiveFindings: ["supportsSpecificIntervention"],
  functionalStatus: ["statesFunctionalDeficit"],
  restrictions: ["statesFunctionalDeficit"],
  procedure: ["statesPriorTreatment"],
  treatment: ["statesPriorTreatment"],
  medications: ["statesPriorTreatment"],
  plan: [],
};

// ── Lexicon ──────────────────────────────────────────────────────────────────
// Deliberately narrow. A missed assertion costs one row of support; a loose
// pattern reinstates exactly the over-claiming this module exists to end.

/** A rate: "2x/week", "twice weekly", "every 3 months", "BID", "q6h". */
const CADENCE =
  /\b(?:\d+\s*(?:x|times?)\s*(?:per|\/|a)?\s*(?:day|week|month|year)|(?:once|twice|three times|four times)\s+(?:a|per|each)?\s*(?:daily|day|week|weekly|month|monthly|year|annually)|every\s+\d+(?:[–-]\d+)?\s*(?:hours?|days?|weeks?|months?|years?)|every\s+(?:other\s+)?(?:day|week|month|year)|(?:daily|nightly|weekly|monthly|quarterly|annually|biannually)\b|\bq(?:\d+)?(?:h|d|wk|mo)\b|\b(?:bid|tid|qid|qhs|prn)\b)/i;

/** A span: "for 12 weeks", "6-week course", "lifelong", "through age 18". */
const DURATION =
  /\b(?:for\s+(?:the\s+next\s+)?\d+(?:[–-]\d+)?\s*(?:days?|weeks?|months?|years?)|\d+(?:[–-]\d+)?[- ](?:day|week|month|year)\s+(?:course|trial|program|protocol|regimen)|(?:lifelong|lifetime|life expectancy|for life|indefinitely|permanent(?:ly)?|chronic(?:ally)?)\b|through\s+age\s+\d+|until\s+(?:skeletal\s+maturity|age\s+\d+)|over\s+the\s+(?:next\s+)?\d+\s*(?:weeks?|months?|years?))/i;

/** A price, an allowed amount, a billed code. */
const COST = /(?:\$\s?\d|\b(?:cpt|hcpcs)\s*(?:code)?\s*\d{4,5}\b|\ballowed amount\b|\bbilled (?:amount|charge)\b|\bcharges?\s+(?:of|totall?ing)\b|\bfee schedule\b|\bcost(?:s)? \$?\d)/i;

/**
 * Something the patient cannot do, or is restricted from doing.
 *
 * Note what is NOT here: a bare "ADLs" or "falls". Those are DOMAIN words, and
 * matching them alone filed "the patient was independent with activities of
 * daily living" as evidence of a functional deficit — a statement of preserved
 * function offered as support for the care that addresses its loss. A deficit
 * needs deficit framing.
 */
const FUNCTIONAL =
  /\b(?:unable to|inability to|cannot|can't|difficulty (?:with|walking|climbing|standing|lifting|sleeping|dressing|rising)|limited (?:in|to|tolerance|ambulation|mobility)|requires? (?:assistance|a cane|a walker|help)|no longer able|antalgic|uses? a (?:cane|walker|wheelchair|brace)|(?:lifting|standing|walking|sitting) (?:restriction|limit|tolerance)|restricted (?:from|to)|(?:difficulty|assistance|help|dependent|limited|impair(?:ed|ment))\s+(?:with\s+|in\s+|for\s+)?(?:ADLs?|activities of daily living)|(?:frequent|recurrent|history of) falls|has fallen)/i;

/**
 * A statement that function is PRESERVED. Not a deficit, and not silence —
 * an explicit finding the other way, which must not be counted as support.
 */
const PRESERVED_FUNCTION =
  /\b(?:independent(?:ly)?\b|no (?:functional )?(?:limitations?|deficits?|restrictions?)\b|full range of motion|ambulates? (?:independently|without (?:difficulty|assistance))|no difficulty|unrestricted|(?:able|abled) to (?:care for (?:self|himself|herself|themselves)|ambulate|walk|transfer|perform)|tolerat(?:es|ed) (?:activity|ambulation|therapy) well|(?:returned|return) to (?:full )?(?:work|duty|activity))/i;

/** Care already delivered. */
const PRIOR_TREATMENT =
  /\b(?:underwent|status[- ]post|s\/p\b|completed\s+\d*\s*(?:sessions?|visits?|weeks?)|received (?:an? )?(?:injection|infusion|course)|(?:was|were) (?:treated|prescribed|referred)|has (?:had|been on|completed)|trial(?:ed)? of|course of (?:physical therapy|steroids?|nsaids?)|arthroscopy|arthroplasty|fusion|injection|physical therapy|occupational therapy|chiropractic)/i;

/** What that care achieved — including that it achieved nothing. */
const TREATMENT_RESPONSE =
  /\b(?:no (?:significant |lasting |meaningful )?(?:relief|improvement|benefit|change)|failed (?:to respond|conservative|therapy|treatment)|(?:did not|didn't) (?:help|improve|respond)|(?:temporary|transient|partial|short[- ]lived|complete|good|excellent) relief|symptoms? (?:improved|worsened|returned|recurred|persisted)|refractory to|unresponsive to|(?:improved|worse) (?:after|following|with)|plateaued)/i;

/** A named condition rather than a description of one. */
const DIAGNOSIS =
  /\b(?:diagnos(?:is|ed|tic impression)|impression\s*:|assessment\s*:|consistent with|(?:M|S|G)\d{2}\.\d|osteoarthritis|radiculopathy|stenosis|tendinopathy|tendinitis|bursitis|neuropathy|myelopathy|spondylo(?:sis|listhesis)|instability|derangement|complex regional pain|post[- ]traumatic|degenerative (?:disc|joint) disease)\b/i;

/** Objective pathology an intervention is aimed at. */

const PATHOLOGY =
  /\b(?:tear|torn|rupture|herniat(?:ion|ed|ing)?|protrusion|extrusion|stenosis|impingement|effusion|edema|fracture|nonunion|malunion|chondral|cartilage loss|bone[- ]on[- ]bone|joint space (?:narrowing|loss)|osteophyte|spur|subluxation|laxity|atrophy|denervation|positive\s+(?:\w+\s+){0,2}(?:sign|test)|grade\s+(?:i|ii|iii|iv|\d)|kellgren|reduced range of motion|rom\s+\d|weakness\s+\d\/5|\d\/5\s+strength)\b/i;

/**
 * A finding stated as an ABSENCE. Topically identical to the pattern above —
 * a normal study is an answer to the same question — and the stance carries
 * the direction.
 */
const NEGATIVE_FINDING =
  /\bno\s+(?:acute\s+|significant\s+|structural\s+|focal\s+|evidence\s+of\s+)?(?:abnormalit(?:y|ies)|tear|fracture|herniation|stenosis|effusion|instability|compression|impingement|degenerative|pathology|findings?)\b|\b(?:unremarkable|within normal limits|normal (?:study|examination|imaging|MRI|radiographs?))\b/i;

export interface ClassifiableSource {
  quote: string;
  /** The extraction field this quote came from, when it came from one. */
  field?: string | null;
  /** Assertions the CALLER knows structurally. Wins over everything below. */
  asserts?: Partial<AssertionProfile>;
}

/**
 * What this source asserts, deterministically.
 *
 * Structure first (the recorded field), lexicon second, caller-supplied
 * structured knowledge last and strongest — a guideline whose duration claim
 * was parsed by `deriveGuidelineDurationClaim` states a duration whatever its
 * prose looks like.
 */
export function classifyAssertion(source: ClassifiableSource): AssertionProfile {
  const profile: AssertionProfile = { ...NO_ASSERTIONS };
  const text = source.quote ?? "";
  if (!text.trim() && !source.asserts) return profile;

  const fieldAsserts = source.field ? FIELD_ASSERTS[source.field] : undefined;
  if (fieldAsserts) for (const key of fieldAsserts) profile[key] = true;

  // The lexicon runs regardless of field, but only ADDS. A `procedure` field
  // whose text reads "12 sessions of therapy, no lasting relief" states prior
  // treatment (structure), a response and a cadence (text). It never subtracts
  // what the field established.
  if (CADENCE.test(text)) profile.statesCadence = true;
  if (DURATION.test(text)) profile.statesDuration = true;
  if (COST.test(text)) profile.providesCostBasis = true;
  if (TREATMENT_RESPONSE.test(text)) profile.statesTreatmentResponse = true;

  // Where structure is silent, the lexicon is the only reader. Where a field
  // spoke, these still apply — one sentence can assert several things.
  if (FUNCTIONAL.test(text)) profile.statesFunctionalDeficit = true;
  if (PRIOR_TREATMENT.test(text)) profile.statesPriorTreatment = true;
  if (!fieldAsserts?.length) {
    if (DIAGNOSIS.test(text)) profile.statesDiagnosis = true;
  }
  if (PATHOLOGY.test(text) || NEGATIVE_FINDING.test(text)) profile.supportsSpecificIntervention = true;

  // A `functionalStatus` field that records PRESERVED function is not a
  // deficit, whatever the field is called. Structure is the better witness
  // than a lexicon right up to the point where the text says the opposite.
  if (profile.statesFunctionalDeficit && PRESERVED_FUNCTION.test(text) && !FUNCTIONAL.test(text)) profile.statesFunctionalDeficit = false;

  if (source.asserts) for (const [k, v] of Object.entries(source.asserts)) if (v != null) profile[k as keyof AssertionProfile] = v;
  return profile;
}

/** Every claim this source's TEXT could speak to, before the strength gate. */
export function claimsAssertedBy(source: ClassifiableSource): EvidenceClaim[] {
  const profile = classifyAssertion(source);
  return (Object.keys(CLAIM_REQUIRES) as EvidenceClaim[]).filter((claim) => assertionSupportsClaim(profile, claim));
}
