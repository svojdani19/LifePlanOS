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
  /**
   * Fields of THIS entry the source contradicts, confirmed by adjudication.
   * Stronger than an unresolved dispute: the disagreement was settled against
   * the extraction, and no verified replacement value exists.
   */
  contradictedFields?: string[];
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
  /**
   * Encounters the CRITIC says the source contains and the extraction missed.
   *
   * These were collected, written to the run record, and read by nothing — so
   * a second pass could name an omitted encounter while every row still
   * passed and the case stayed exportable. An omission is under-extraction:
   * the draft is not the record.
   */
  criticOmissions?: number;
  /** Places the critic could not tell where one note ends and the next begins. */
  unclearBoundaries?: number;
  /** True once every uploaded document covering the period finished processing. */
  allDocumentsProcessed: boolean;
  /**
   * THIS document's own run did not finish — it paused at a chunk budget, or
   * stopped part-way.
   *
   * Document-scope, not case-scope: content this document's entries sit among
   * has not been read yet, so its own entries are genuinely incomplete. Kept
   * separate from `allDocumentsProcessed`, which is about OTHER documents and
   * must never change how this document's entries are graded.
   */
  thisDocumentIncomplete?: boolean;
}

/** A finding the audit derived, named by what it is actually about. */
export interface ScopedAuditFinding {
  scope: "CASE" | "DOCUMENT" | "PAGE" | "NOTE" | "ENTRY" | "CLAIM";
  type: string;
  blocking: boolean;
  detail: string;
  /** Present when the finding concerns specific pages. */
  pageStart?: number | null;
  pageEnd?: number | null;
  /** Index into `input.encounters`, when the finding is about one entry. */
  encounterIndex?: number | null;
  claimIndex?: number | null;
  field?: string | null;
}

export interface AuditOutcome {
  result: AuditResult;
  findings: string[]; // PHI-safe — LEGACY, kept for compatibility
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
  /**
   * The same conclusions, each named by the thing it concerns. This is what
   * review presentation and metrics read; `findings` above is the legacy flat
   * array that was copied onto every row.
   */
  scoped: ScopedAuditFinding[];
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
  /**
   * Document-level incompleteness that does NOT belong to any single entry:
   * the record is missing something, but the entries it did produce are each
   * faithful to what they cite. It sets the document's own result and the
   * case-level gate, and stops there.
   */
  let docOnlyIncomplete = false;
  /**
   * Facts about the CASE — a sibling document failed, or others are still
   * processing. They block the case and never touch an entry's result, so
   * processing order cannot change how an entry is graded.
   */
  let caseOnlyIncomplete = false;
  const scoped: ScopedAuditFinding[] = [];
  const ownConflict: boolean[] = input.encounters.map(() => false);
  const ownFailure: boolean[] = input.encounters.map(() => false);
  const ownReview: boolean[] = input.encounters.map(() => false);

  // ── 1. Source completeness ────────────────────────────────────────────────
  // BLANK is deliberately NOT here. The page ledger distinguishes two things
  // that look identical from the outside: a page whose own native text layer
  // carries no content (BLANK — read successfully, and there was nothing on
  // it), and a page whose OCR returned nothing (UNREADABLE — which may be a
  // blank sheet or a scan nobody could read, and only a human looking at the
  // image can tell). Treating BLANK as unreadable said "this page could not be
  // read" about a page that was read perfectly, and manufactured a blocking
  // finding per blank sheet — routine filler in a legal production.
  //
  // FAILED is here for the opposite reason: it is a page inside a chunk the
  // pipeline could not process, and it was in neither this list nor the export
  // gate — so a page whose content was never read at all was silently sound.
  const unreadable = input.pages.filter((p) => ["UNREADABLE", "OCR_FAILED", "FAILED"].includes(p.status));
  const pending = input.pages.filter((p) => p.status === "PENDING_OCR");
  const lowConf = input.pages.filter((p) => p.status === "LOW_CONFIDENCE");
  const truncated = input.pages.filter((p) => p.status === "TRUNCATED");
  // Page problems are recorded PER PAGE. One finding per affected page keeps
  // "page 4 is unreadable" and "page 9 is unreadable" two problems, and lets
  // the review surface show each once where it belongs.
  const pageFinding = (type: string, page: number, detail: string) =>
    scoped.push({ scope: "PAGE", type, blocking: true, detail, pageStart: page, pageEnd: page });
  if (pending.length) {
    sawIncomplete = true;
    findings.push(`${pending.length} page(s) are still awaiting OCR; the record is not fully processed.`);
    for (const pg of pending) pageFinding("PAGE_UNREADABLE", pg.pageNumber, "This page is still awaiting OCR; its content is not yet represented.");
  }
  if (unreadable.length) {
    sawIncomplete = true;
    findings.push(`${unreadable.length} page(s) could not be read; their content is absent from this draft.`);
    for (const pg of unreadable) pageFinding("PAGE_UNREADABLE", pg.pageNumber, "This page could not be read; its content is absent from this draft.");
  }
  if (truncated.length) {
    sawIncomplete = true;
    findings.push(`${truncated.length} page(s) were truncated during processing.`);
    for (const pg of truncated) pageFinding("PAGE_TRUNCATED", pg.pageNumber, "This page was truncated during processing; content beyond the cut is not represented.");
  }
  if (input.failedExtractions > 0) {
    // A DIFFERENT document failing is a case-completion fact. It says nothing
    // about this entry, and letting it in made an entry's audit result depend
    // on which other documents happened to be processed first.
    caseOnlyIncomplete = true;
    findings.push(`${input.failedExtractions} document(s) failed extraction; their content is not represented.`);
    scoped.push({ scope: "CASE", type: "DOCUMENT_EXTRACTION_FAILED", blocking: true, detail: `${input.failedExtractions} document(s) failed extraction; their content is not represented.` });
  }
  if ((input.failedSections ?? 0) > 0) {
    sawIncomplete = true;
    findings.push(`${input.failedSections} section(s) of the source could not be processed; their content is not represented.`);
    scoped.push({ scope: "DOCUMENT", type: "SECTION_NOT_PROCESSED", blocking: true, detail: `${input.failedSections} section(s) of this document could not be processed; their content is not represented.` });
  }
  if ((input.coverageGaps ?? 0) > 0) {
    // The DOCUMENT is under-extracted; each entry it did produce is not
    // thereby a defective entry. Copying this onto every row made 347 rows
    // report a problem that belonged to the document — and to the case's
    // completion gate, which now carries it explicitly (factualReviewState
    // reads the run's persisted coverageGaps, so export still cannot
    // complete over a missing encounter).
    docOnlyIncomplete = true;
    findings.push(`${input.coverageGaps} dated note header(s) in the source have no extracted encounter; the record may be under-extracted.`);
    scoped.push({ scope: "DOCUMENT", type: "MISSING_ENCOUNTER", blocking: true, detail: `${input.coverageGaps} dated note header(s) in this document have no extracted encounter; the record may be under-extracted.` });
  }
  if ((input.criticOmissions ?? 0) > 0) {
    sawIncomplete = true;
    findings.push(
      `${input.criticOmissions} encounter(s) present in the source were not extracted, per the independent critic pass; the draft does not represent the whole record.`,
    );
    scoped.push({ scope: "DOCUMENT", type: "MISSING_ENCOUNTER", blocking: true, detail: `${input.criticOmissions} encounter(s) present in this document were not extracted, per the independent critic pass.` });
  }
  if ((input.unclearBoundaries ?? 0) > 0) {
    sawReviewNeeded = true;
    findings.push(
      `${input.unclearBoundaries} place(s) in the source where one note's boundary could not be determined; entries there may combine or split records.`,
    );
    scoped.push({ scope: "DOCUMENT", type: "UNCLEAR_NOTE_BOUNDARY", blocking: false, detail: `${input.unclearBoundaries} place(s) in this document where a note boundary could not be determined.` });
  }
  if (input.truncatedSource) {
    sawIncomplete = true;
    findings.push("The source text was clipped at the storage cap; content beyond it is not represented.");
    scoped.push({ scope: "DOCUMENT", type: "SOURCE_CLIPPED", blocking: true, detail: "This document's text was clipped at the storage cap; content beyond it is not represented." });
  }
  if (lowConf.length) {
    sawReviewNeeded = true;
    findings.push(`${lowConf.length} page(s) have low-confidence OCR; extracted facts require verification against the source.`);
    for (const pg of lowConf) {
      scoped.push({ scope: "PAGE", type: "PAGE_LOW_CONFIDENCE", blocking: false, detail: "This page's OCR confidence is low; facts drawn from it need checking against the source.", pageStart: pg.pageNumber, pageEnd: pg.pageNumber });
    }
  }
  if (input.thisDocumentIncomplete) {
    sawIncomplete = true;
    findings.push("This document's extraction did not run to completion; part of it has not been read.");
    scoped.push({ scope: "DOCUMENT", type: "SECTION_NOT_PROCESSED", blocking: true, detail: "This document's extraction did not run to completion; part of it has not been read." });
  }
  if (!input.allDocumentsProcessed) {
    // Also case-level: this entry is not less faithful because a sibling
    // document is still in the queue.
    caseOnlyIncomplete = true;
    findings.push("Not every uploaded document has completed processing.");
    scoped.push({ scope: "CASE", type: "DOCUMENTS_STILL_PROCESSING", blocking: true, detail: "Not every uploaded document has completed processing." });
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
  const seen = new Map<string, number[]>();
  for (const [index, e] of input.encounters.entries()) {
    const label = e.encounterDate ?? "undated";

    // Fields adjudication confirmed the source contradicts.
    if (e.contradictedFields?.length) {
      sawConflict = true;
      ownConflict[index] = true;
      findings.push(`The source contradicts the extracted ${e.contradictedFields.join(" and ")} for the entry shown as ${label}; a reviewer must set it from the record.`);
      for (const field of e.contradictedFields) {
        scoped.push({
          scope: "ENTRY",
          type: field === "date" ? "CONTRADICTED_DATE" : "CONTRADICTED_PROVIDER",
          blocking: true,
          encounterIndex: index,
          field,
          detail: `The source contradicts the extracted ${field} for this entry; a reviewer must set it from the record.`,
        });
      }
    }

    // Disputes about THIS entry that no adjudicator could settle.
    if ((e.unresolvedDisputes ?? 0) > 0) {
      sawConflict = true;
      ownConflict[index] = true;
      findings.push(`${e.unresolvedDisputes} extraction disagreement(s) about the entry for ${label} remain unresolved.`);
      scoped.push({ scope: "ENTRY", type: "UNRESOLVED_DISPUTE", blocking: true, encounterIndex: index, detail: `${e.unresolvedDisputes} extraction disagreement(s) about this entry remain unresolved.` });
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

    // Duplicate detection: same document, date, provider and summary. The
    // members are remembered, not just the count — a two-row duplicate group
    // used to mark every one of a 176-row document as needing review.
    const key = `${e.sourceDocumentId}|${e.encounterDate ?? "u"}|${norm(e.provider ?? "")}|${norm(e.factualSummary).slice(0, 60)}`;
    seen.set(key, [...(seen.get(key) ?? []), index]);
  }

  const duplicateGroups = [...seen.values()].filter((members) => members.length > 1);
  if (duplicateGroups.length > 0) {
    sawReviewNeeded = true;
    // The entries in the group need a look; their neighbours do not.
    for (const members of duplicateGroups) for (const i of members) ownReview[i] = true;
    findings.push(`${duplicateGroups.length} apparent duplicate encounter group(s) require review.`);
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
      scoped: [
        ...scoped,
        { scope: "DOCUMENT", type: "SECTION_NOT_PROCESSED", blocking: true, detail: "No encounters were extracted from the available source pages." },
      ],
    };
  }

  // Severity order: a hard integrity failure outranks a source conflict, which
  // outranks incompleteness, which outranks an ordinary review flag.
  const grade = (failure: boolean, conflict: boolean, incomplete: boolean, review: boolean): AuditResult =>
    failure ? "FAILED" : conflict ? "SOURCE_CONFLICT" : incomplete ? "EXTRACTION_INCOMPLETE" : review ? "NEEDS_HUMAN_REVIEW" : "PASS";

  const result = grade(sawFailure, sawConflict, sawIncomplete || docOnlyIncomplete || caseOnlyIncomplete, sawReviewNeeded);

  // Each entry: what the DOCUMENT's own state implies for it, plus what the
  // entry itself raised. A neighbour's unresolved dispute is not this entry's
  // conflict.
  const perEncounter = input.encounters.map((_, i) =>
    grade(docFailure || ownFailure[i], docConflict || ownConflict[i], docIncomplete, docReview || ownReview[i]),
  );

  return { result, findings, perEncounter, scoped };
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
