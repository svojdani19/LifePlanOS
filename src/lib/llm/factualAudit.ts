// ─────────────────────────────────────────────────────────────────────────────
// Adversarial factual audit.
//
// The pipeline's job before this point is to produce the best draft it can.
// This module's job is the opposite: to find every reason the draft must NOT
// be presented as complete. It is deterministic and runs over the persisted
// artifacts — pages, claims, encounters, synthesis — after generation.
//
// The result is one of five states, and only PASS may be shown as a complete
// AI draft. Even PASS is a draft until a human verifies it: an audit says the
// system found nothing wrong, which is not the same as the record being right.
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIT_RESULTS = ["PASS", "NEEDS_HUMAN_REVIEW", "EXTRACTION_INCOMPLETE", "SOURCE_CONFLICT", "FAILED"] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export interface AuditPage {
  pageNumber: number;
  status: string; // READABLE | BLANK | LOW_CONFIDENCE | UNREADABLE | TRUNCATED | PENDING_OCR | OCR_FAILED
  ocrConfidence: number | null;
}

export interface AuditClaim {
  id?: string;
  field: string;
  claimType?: string;
  value: string;
  excerpt: string;
  page: number | null;
  warning?: string;
}

export interface AuditEncounter {
  id: string;
  sourceDocumentId: string;
  dateStatus: string;
  encounterDate: string | null;
  provider: string | null;
  encounterType: string | null;
  factualSummary: string;
  synthesis?: string | null;
  /** sentence -> supporting claim ids, when a synthesis was generated. */
  sentenceClaimMap?: Record<string, string[]> | null;
  claims: AuditClaim[];
  page: number | null;
  status: string;
  /**
   * Disputes about THIS entry that the adjudicator could not settle.
   *
   * A conflict belongs to the entry it is about. Counting every unresolved
   * dispute document-wide put whole productions into source conflict over a
   * disagreement about one claim in one entry — on McHenry, 505 of 547 current
   * rows, which is what kept the review queue from ever draining.
   */
  unresolvedDisputes?: number;
}

export interface AuditInput {
  encounters: AuditEncounter[];
  pages: AuditPage[];
  /** Extraction runs that did not complete for this document/case. */
  failedExtractions: number;
  /** Sections/chunks that could not be processed after retries. */
  failedSections?: number;
  /** Dated note-headers the deterministic segmenter found with no extracted encounter. */
  coverageGaps?: number;
  /** The source text arrived clipped at the storage cap. */
  truncatedSource?: boolean;
  /**
   * Unresolved disputes that name no entry, so they cannot be pinned to one.
   * Entry-specific ones travel on the entry (AuditEncounter.unresolvedDisputes).
   */
  unresolvedDisputes: number;
  /** True once every uploaded document covering the period finished processing. */
  allDocumentsProcessed: boolean;
}

export interface AuditOutcome {
  result: AuditResult;
  findings: string[]; // PHI-safe
  /**
   * One result per input encounter, in order.
   *
   * The document-level `result` answers "is this document's processing sound
   * as a whole"; this answers "is THIS entry sound", which is what a row's
   * status should reflect. An entry inherits every document-level defect that
   * genuinely bears on it — unreadable pages, unprocessed sections, missing
   * coverage — but not a conflict that belongs to a different entry.
   */
  perEncounter: AuditResult[];
}

/** Causal / future-care language that a FACTUAL record may not assert. */
const CAUSAL_RE = new RegExp(
  [
    // Causation attributed to the incident.
    String.raw`\bcaused by\b`,
    String.raw`\bdue to the (?:accident|collision|incident|injury)\b`,
    String.raw`\bas a result of the (?:accident|collision|incident)\b`,
    String.raw`\battributable to the (?:accident|collision)\b`,
    String.raw`\brelated to the subject (?:accident|collision)\b`,
    // Future-care necessity asserted as a record fact.
    String.raw`\bsupports?\s+(?:the\s+)?(?:need|indication)\s+for\b`,
    String.raw`\bsupports?\s+(?:the\s+)?(?:anticipated|future|ongoing)\s+(?:care|treatment|need)\b`,
    String.raw`\bwill require\b`,
    String.raw`\bnecessitates?\s+future\b`,
  ].join("|"),
  "i",
);

/** Statements the system must never make about an absence of records. */
const NO_TREATMENT_RE = /\bno (?:documented )?treatment (?:occurred|was (?:provided|rendered))\b/i;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Audit a case's draft record. Ordering of severity matters: a case whose
 * source could not be read fully is EXTRACTION_INCOMPLETE regardless of how
 * clean the extracted part looks, because the clean part is not the record.
 */
export function auditFactualRecord(input: AuditInput): AuditOutcome {
  const findings: string[] = [];
  let sawConflict = false;
  let sawFailure = false;
  let sawIncomplete = false;
  let sawReviewNeeded = false;

  // Flags raised by facts about the DOCUMENT — unreadable pages, unprocessed
  // sections, missing coverage. Every entry inherits these: an entry drawn
  // from a partly-processed record is itself part of a partly-processed
  // record. Kept separate from flags an individual entry raises, which must
  // NOT spread to its neighbours.
  let docConflict = false;
  let docFailure = false;
  let docIncomplete = false;
  let docReview = false;
  const ownConflict: boolean[] = input.encounters.map(() => false);
  const ownFailure: boolean[] = input.encounters.map(() => false);
  const ownReview: boolean[] = input.encounters.map(() => false);

  // ── 1. Source completeness ────────────────────────────────────────────────
  const unreadable = input.pages.filter((p) => ["UNREADABLE", "OCR_FAILED", "BLANK"].includes(p.status));
  const pending = input.pages.filter((p) => p.status === "PENDING_OCR");
  const lowConf = input.pages.filter((p) => p.status === "LOW_CONFIDENCE");
  const truncated = input.pages.filter((p) => p.status === "TRUNCATED");
  if (pending.length) {
    sawIncomplete = true;
    findings.push(`${pending.length} page(s) are still awaiting OCR; the record is not fully processed.`);
  }
  if (unreadable.length) {
    sawIncomplete = true;
    findings.push(`${unreadable.length} page(s) could not be read; their content is absent from this draft.`);
  }
  if (truncated.length) {
    sawIncomplete = true;
    findings.push(`${truncated.length} page(s) were truncated during processing.`);
  }
  if (input.failedExtractions > 0) {
    sawIncomplete = true;
    findings.push(`${input.failedExtractions} document(s) failed extraction; their content is not represented.`);
  }
  if ((input.failedSections ?? 0) > 0) {
    sawIncomplete = true;
    findings.push(`${input.failedSections} section(s) of the source could not be processed; their content is not represented.`);
  }
  if ((input.coverageGaps ?? 0) > 0) {
    sawIncomplete = true;
    findings.push(`${input.coverageGaps} dated note header(s) in the source have no extracted encounter; the record may be under-extracted.`);
  }
  if (input.truncatedSource) {
    sawIncomplete = true;
    findings.push("The source text was clipped at the storage cap; content beyond it is not represented.");
  }
  if (lowConf.length) {
    sawReviewNeeded = true;
    findings.push(`${lowConf.length} page(s) have low-confidence OCR; extracted facts require verification against the source.`);
  }
  if (!input.allDocumentsProcessed) {
    sawIncomplete = true;
    findings.push("Not every uploaded document has completed processing.");
  }

  // ── 2. Unresolved disagreement between extraction passes ──────────────────
  if (input.unresolvedDisputes > 0) {
    sawConflict = true;
    findings.push(`${input.unresolvedDisputes} extraction disagreement(s) remain unresolved.`);
  }

  const readablePages = new Set(input.pages.filter((p) => p.status !== "PENDING_OCR").map((p) => p.pageNumber));

  // Everything raised so far is a fact about the document, and every entry
  // inherits it. What the per-entry loop raises below belongs to its entry.
  docConflict = sawConflict;
  docFailure = sawFailure;
  docIncomplete = sawIncomplete;
  docReview = sawReviewNeeded;

  // ── 3. Per-encounter checks ───────────────────────────────────────────────
  const seen = new Map<string, number>();
  for (const [index, e] of input.encounters.entries()) {
    const label = e.encounterDate ?? "undated";

    // Disputes about THIS entry that no adjudicator could settle.
    if ((e.unresolvedDisputes ?? 0) > 0) {
      sawConflict = true;
      ownConflict[index] = true;
      findings.push(`${e.unresolvedDisputes} extraction disagreement(s) about the entry for ${label} remain unresolved.`);
    }

    if (!e.claims.length) {
      sawFailure = true;
      ownFailure[index] = true;
      findings.push(`An encounter (${label}) carries no supporting claims.`);
      continue;
    }

    for (const c of e.claims) {
      // Citation integrity.
      if (!c.excerpt || c.excerpt.trim().length < 3) {
        sawFailure = true;
        ownFailure[index] = true;
        findings.push(`A claim (${c.field}, ${label}) has no supporting excerpt.`);
      }
      if (c.page != null && readablePages.size && !readablePages.has(c.page)) {
        sawConflict = true;
        ownConflict[index] = true;
        findings.push(`A claim cites page ${c.page}, which is not an established page of its source document.`);
      }
      if (c.warning && /low-confidence OCR/.test(c.warning)) {
        sawReviewNeeded = true;
        ownReview[index] = true;
      }
      if (c.warning && /carried forward/.test(c.warning)) {
        sawReviewNeeded = true;
        ownReview[index] = true;
      }
      // Factual record may not assert causation or future-care necessity.
      if (CAUSAL_RE.test(c.value)) {
        sawConflict = true;
        ownConflict[index] = true;
        findings.push(`A claim (${c.field}, ${label}) asserts causation or future-care necessity, which is not a documented record fact.`);
      }
    }

    // Summary integrity.
    if (CAUSAL_RE.test(e.factualSummary)) {
      sawConflict = true;
      ownConflict[index] = true;
      findings.push(`The factual summary for ${label} asserts causation or future-care necessity.`);
    }
    if (NO_TREATMENT_RE.test(e.factualSummary)) {
      sawFailure = true;
      ownFailure[index] = true;
      findings.push(`The factual summary for ${label} states that no treatment occurred, which the absence of records cannot establish.`);
    }

    // A synthesis must map every sentence to supporting claims.
    if (e.synthesis) {
      const map = e.sentenceClaimMap ?? {};
      const sentences = splitSentences(e.synthesis);
      const claimIds = new Set(e.claims.map((c, i) => c.id ?? String(i)));
      for (const s of sentences) {
        const support = map[s] ?? map[norm(s)];
        if (!support || support.length === 0) {
          sawFailure = true;
          ownFailure[index] = true;
          findings.push(`A synthesized sentence for ${label} has no mapped supporting claim.`);
          continue;
        }
        if (support.some((id) => !claimIds.has(id))) {
          sawConflict = true;
          ownConflict[index] = true;
          findings.push(`A synthesized sentence for ${label} cites a claim id that is not part of this encounter.`);
        }
      }
    }

    // Undated content must not be presented as chronology.
    if (e.dateStatus === "UNKNOWN" && e.encounterDate) {
      sawFailure = true;
      findings.push(`An encounter is marked undated yet carries a date value.`);
    }
    if (e.dateStatus === "DISPUTED") {
      sawConflict = true;
      findings.push(`An encounter (${label}) has a disputed date that no human has resolved.`);
    }

    // Duplicate detection: same document, date, provider and summary.
    const key = `${e.sourceDocumentId}|${e.encounterDate ?? "u"}|${norm(e.provider ?? "")}|${norm(e.factualSummary).slice(0, 60)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  const dupes = [...seen.values()].filter((n) => n > 1).length;
  if (dupes > 0) {
    sawReviewNeeded = true;
    docReview = true;
    findings.push(`${dupes} apparent duplicate encounter group(s) require review.`);
  }

  // ── 4. Chronological ordering of dated encounters ─────────────────────────
  // Disclosed, never a flag. Productions arrive in whatever order the
  // custodian assembled them — reverse-chronological charts are routine, and
  // billing packets are ordered by claim — so extraction order says nothing
  // about whether the extraction is faithful. Treating it as a review flag
  // knocked practically every document out of PASS on a fact about filing.
  const dated = input.encounters.filter((e) => e.encounterDate).map((e) => e.encounterDate!);
  const sorted = [...dated].sort();
  if (dated.join("|") !== sorted.join("|")) {
    findings.push("Dated encounters appear in the source in an order other than chronological; the chronology orders them by date.");
  }

  // ── 5. Nothing extracted at all ───────────────────────────────────────────
  if (input.encounters.length === 0) {
    return {
      result: input.pages.length === 0 ? "FAILED" : "EXTRACTION_INCOMPLETE",
      findings: [...findings, "No encounters were extracted from the available source pages."],
      perEncounter: [],
    };
  }

  // Severity order: a hard integrity failure outranks a source conflict, which
  // outranks incompleteness, which outranks an ordinary review flag.
  const grade = (failure: boolean, conflict: boolean, incomplete: boolean, review: boolean): AuditResult =>
    failure ? "FAILED" : conflict ? "SOURCE_CONFLICT" : incomplete ? "EXTRACTION_INCOMPLETE" : review ? "NEEDS_HUMAN_REVIEW" : "PASS";

  const result = grade(sawFailure, sawConflict, sawIncomplete, sawReviewNeeded);

  // Each entry: what the DOCUMENT's own state implies for it, plus what the
  // entry itself raised. A neighbour's unresolved dispute is not this entry's
  // conflict.
  const perEncounter = input.encounters.map((_, i) =>
    grade(docFailure || ownFailure[i], docConflict || ownConflict[i], docIncomplete, docReview || ownReview[i]),
  );

  return { result, findings, perEncounter };
}

/** Split synthesized prose into sentences for claim mapping. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Only a PASS may be presented as a complete AI draft. */
export function isPresentableAsCompleteDraft(result: AuditResult | null | undefined): boolean {
  return result === "PASS";
}
