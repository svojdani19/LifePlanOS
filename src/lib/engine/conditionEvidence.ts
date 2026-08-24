// ─────────────────────────────────────────────────────────────────────────────
// What actually justifies a causation finding.
//
// A condition card used to be able to say
//
//     Objective evidence: See medical records.
//
// which is not evidence. It is an instruction to go and look, printed in the
// field where the finding is supposed to be supported — and it survived
// because the text locator, which greps raw document text sentence by
// sentence, found nothing citable and the placeholder was left standing.
//
// It found nothing because it was searching the wrong artifact. The extraction
// pipeline already produces TYPED, validated, page-cited claims, and on the
// reference case "Chronic pain syndrome" — the one condition left with the
// placeholder — has an `assessment` claim reading exactly "Chronic Pain
// Syndrome". A clinician's own recorded assessment is stronger evidence than
// any sentence a regex can find, and it was being ignored.
//
// The clinical grading matters as much as the finding. A condition named in
// PAST MEDICAL HISTORY is evidence the patient had it BEFORE the incident —
// which bears on apportionment and argues against relatedness. Quoting it as
// "objective evidence" for an injury-related finding would be worse than the
// placeholder, because it would look supported. So each quote is graded, and
// only a diagnosis or an objective finding may headline a causation opinion.
// ─────────────────────────────────────────────────────────────────────────────

import { DX_GENERIC, hasTerm, sigTerms } from "./chronology";
import { isCitableEvidence } from "@/lib/documents/assertion";

/**
 * How strongly a quote supports a CAUSATION finding — not how confident the
 * extraction is. Ordered strongest first.
 */
export type EvidenceStrength =
  /** The clinician's own diagnostic statement. */
  | "DIAGNOSIS"
  /** Something measured or observed: imaging, operative findings, examination. */
  | "OBJECTIVE"
  /** Recorded as pre-existing history — bears AGAINST an injury-related finding. */
  | "HISTORY"
  /** The patient's report, or care aimed at it. Context, not objective support. */
  | "REPORTED";

const FIELD_STRENGTH: Record<string, EvidenceStrength> = {
  assessment: "DIAGNOSIS",
  diagnosis: "DIAGNOSIS",
  operativeFindings: "OBJECTIVE",
  diagnosticStudies: "OBJECTIVE",
  objectiveFindings: "OBJECTIVE",
  pastMedicalHistory: "HISTORY",
  subjective: "REPORTED",
  treatment: "REPORTED",
  medications: "REPORTED",
  recommendations: "REPORTED",
};

const RANK: Record<EvidenceStrength, number> = { DIAGNOSIS: 0, OBJECTIVE: 1, HISTORY: 2, REPORTED: 3 };

/** Strengths that may stand as the objective support for a causation opinion. */
export const SUPPORTING_STRENGTHS: ReadonlySet<EvidenceStrength> = new Set<EvidenceStrength>(["DIAGNOSIS", "OBJECTIVE"]);

export interface ClaimLike {
  field?: string | null;
  value?: string | null;
  excerpt?: string | null;
  page?: number | null;
}

export interface EncounterLike {
  id?: string;
  sourceDocumentId: string;
  encounterDate?: Date | string | null;
  claims?: unknown;
}

export interface ConditionEvidence {
  documentId: string;
  /** The encounter the claim was extracted from, when the caller supplies it. */
  encounterId: string | null;
  filename: string;
  page: number | null;
  quote: string;
  /** The extraction field the quote came from — why it is graded as it is. */
  field: string;
  strength: EvidenceStrength;
  /** When the record carrying it is dated, for pre/post-incident reasoning. */
  recordedOn: string | null;
  /**
   * True when the quote is the record's OWN words (a claim excerpt), false
   * when it is the extraction's normalised value. Both are legitimate; only
   * one may be presented in a report as what the chart says.
   */
  verbatim: boolean;
}

const trimQuote = (s: string) => {
  const v = s.replace(/\s+/g, " ").trim();
  return v.length > 180 ? v.slice(0, 177).trimEnd() + "…" : v;
};

const claimsOf = (e: EncounterLike): ClaimLike[] => (Array.isArray(e.claims) ? (e.claims as ClaimLike[]) : []);

/**
 * Does this claim actually assert the condition?
 *
 * The same distinctive-term rule the chronology and the text locator use, so a
 * generic word ("pain", "syndrome") cannot attach a quote to the wrong
 * diagnosis — plus the assertion check, so a negated or hypothetical mention
 * ("no evidence of chronic pain syndrome") is never quoted as support.
 */
function assertsCondition(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  const citable = terms.filter((t) => hasTerm(lower, t) && isCitableEvidence(text, t));
  if (!citable.length) return false;
  const distinctive = citable.filter((t) => !DX_GENERIC.has(t));
  // A distinctive term of real length, or two corroborating terms together.
  // "Chronic Pain Syndrome" qualifies on "syndrome" + "chronic"; a bare
  // "pain" never does.
  return distinctive.some((t) => t.length >= 5) || citable.length >= 2;
}

/**
 * Find the evidence for one condition in the case's VALIDATED extracted
 * claims — the same claims a reviewer verifies on the Records page, so a
 * causation card cites what a human has (or will have) attested to.
 *
 * Returns strongest-first, at most one quote per document per strength, so a
 * condition documented across twelve visits does not print twelve identical
 * lines.
 */
export function locateConditionEvidenceInClaims(
  encounters: readonly EncounterLike[],
  filenameFor: ReadonlyMap<string, string>,
  conditionName: string,
  max = 4,
): ConditionEvidence[] {
  const terms = sigTerms(conditionName);
  if (!terms.length) return [];

  const out: ConditionEvidence[] = [];
  const seen = new Set<string>();
  for (const enc of encounters) {
    for (const c of claimsOf(enc)) {
      const field = c.field ?? "";
      const strength = FIELD_STRENGTH[field];
      if (!strength) continue; // untyped page text is never causation evidence
      const text = `${c.value ?? ""} ${c.excerpt ?? ""}`.trim();
      if (!text || !assertsCondition(text, terms)) continue;

      // One quote per document per strength: the same diagnosis recorded at
      // every visit is one piece of evidence, not twelve.
      const key = `${enc.sourceDocumentId}|${strength}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        documentId: enc.sourceDocumentId,
        encounterId: enc.id ?? null,
        filename: filenameFor.get(enc.sourceDocumentId) ?? "record on file",
        page: c.page ?? null,
        quote: trimQuote(c.excerpt || c.value || ""),
        field,
        strength,
        recordedOn: enc.encounterDate ? new Date(enc.encounterDate).toISOString().slice(0, 10) : null,
        // `excerpt` is the record's own sentence; `value` is the extraction's
        // normalisation of it. A report that quotes the second as the first
        // attributes words to a clinician who did not write them.
        verbatim: !!c.excerpt,
      });
    }
  }
  return out.sort((a, b) => RANK[a.strength] - RANK[b.strength]).slice(0, max);
}

export interface EvidenceStatement {
  /** The sentence printed in the objective-evidence field. Never a placeholder. */
  objectiveEvidence: string;
  /** Set when the finding is not objectively supported and a person must act. */
  missingInfo: string | null;
  /** True when a diagnosis or objective finding backs the condition. */
  supported: boolean;
}

const FIELD_WORD: Record<string, string> = {
  assessment: "assessment",
  diagnosis: "diagnosis",
  operativeFindings: "operative findings",
  diagnosticStudies: "diagnostic study",
  objectiveFindings: "examination findings",
  pastMedicalHistory: "past medical history",
  subjective: "reported history",
  treatment: "treatment record",
  medications: "medication record",
  recommendations: "recommendation",
};

const cite = (e: ConditionEvidence) =>
  `"${e.quote}" — ${FIELD_WORD[e.field] ?? e.field}, ${e.filename}${e.page != null ? `, p. ${e.page}` : ""}${e.recordedOn ? ` (${e.recordedOn})` : ""}`;

/**
 * State the objective evidence for a condition, or state its absence.
 *
 * Three outcomes, and the last two are the point of this function:
 *
 *   • a diagnosis or objective finding backs it → quote the strongest one;
 *   • only history or a patient report mentions it → say exactly that, and
 *     name it as something a physician must resolve, because a past-medical-
 *     history entry argues the condition PRE-DATES the incident;
 *   • nothing in the records asserts it → say nothing was located.
 *
 * No branch produces "see medical records", which is an instruction printed
 * where a justification belongs.
 */
export function stateObjectiveEvidence(found: readonly ConditionEvidence[], conditionName: string): EvidenceStatement {
  const supporting = found.filter((e) => SUPPORTING_STRENGTHS.has(e.strength));
  if (supporting.length) {
    return { objectiveEvidence: supporting.slice(0, 2).map(cite).join("; "), missingInfo: null, supported: true };
  }

  const history = found.filter((e) => e.strength === "HISTORY");
  if (history.length) {
    return {
      objectiveEvidence: `No objective finding for ${conditionName} was located in the records. It appears in the past medical history: ${cite(history[0])}.`,
      missingInfo: `${conditionName} is documented as pre-existing history rather than as an objective finding after the incident. A physician must establish whether it is injury-related, an aggravation, or unrelated.`,
      supported: false,
    };
  }

  const reported = found.filter((e) => e.strength === "REPORTED");
  if (reported.length) {
    return {
      objectiveEvidence: `No objective finding for ${conditionName} was located. The records refer to it only in reported history or care: ${cite(reported[0])}.`,
      missingInfo: `${conditionName} is supported only by reported history or treatment, not by an examination, study or recorded diagnosis. Physician review is required before it carries a causation opinion.`,
      supported: false,
    };
  }

  return {
    objectiveEvidence: `No supporting finding for ${conditionName} was located in the ingested records.`,
    missingInfo: `Nothing in the records asserts ${conditionName}. Either the supporting records have not been produced, or this condition should not carry a causation opinion.`,
    supported: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// One citation per document, page and quote.
//
// Two locators feed a causation card and they overlap by design:
// `locateConditionEvidenceInClaims` reads the validated extracted claims, while
// `locateConditionEvidence` greps the raw document text. A quote that is both a
// validated claim and a literal string in the document is therefore found
// twice, and both copies were persisted — so a card cited
// "River Oaks BR&MR w Aff.pdf — p. 1 'Chronic Pain Syndrome'" twice over,
// reading as two independent corroborating records when there is one.
//
// The display string built beside it was already deduped; the JSON the causation
// panel actually renders was not.
// ─────────────────────────────────────────────────────────────────────────────

/** The persisted citation shape. `field` is present only on claim-backed rows. */
export interface EvidenceSourceRow {
  documentId?: string | null;
  encounterId?: string | null;
  filename?: string | null;
  page?: number | null;
  quote?: string | null;
  field?: string | null;
  verbatim?: boolean;
}

const citationIdentity = (s: EvidenceSourceRow): string =>
  `${String(s.documentId ?? "")}|${s.page ?? ""}|${String(s.quote ?? "").trim().toLowerCase()}`;

/**
 * Collapse citations that point at the same words in the same place.
 *
 * Order is significant and load-bearing: pass the claim-backed rows FIRST, so
 * that when the same quote arrives from both locators the surviving copy is the
 * one carrying `field` — the extraction field the quote came from, which is what
 * lets everything downstream grade it DIAGNOSIS / OBJECTIVE / HISTORY instead of
 * assuming objective.
 */
export function dedupeEvidenceSources<T extends EvidenceSourceRow>(sources: readonly T[]): T[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const key = citationIdentity(s);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
