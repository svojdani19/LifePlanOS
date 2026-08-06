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
  /** Claims the critic contested and no adjudicator resolved. */
  unresolvedDisputes: number;
  /** True once every uploaded document covering the period finished processing. */
  allDocumentsProcessed: boolean;
}

export interface AuditOutcome {
  result: AuditResult;
  findings: string[]; // PHI-safe
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

  // ── 3. Per-encounter checks ───────────────────────────────────────────────
  const seen = new Map<string, number>();
  for (const e of input.encounters) {
    const label = e.encounterDate ?? "undated";

    if (!e.claims.length) {
      sawFailure = true;
      findings.push(`An encounter (${label}) carries no supporting claims.`);
      continue;
    }

    for (const c of e.claims) {
      // Citation integrity.
      if (!c.excerpt || c.excerpt.trim().length < 3) {
        sawFailure = true;
        findings.push(`A claim (${c.field}, ${label}) has no supporting excerpt.`);
      }
      if (c.page != null && readablePages.size && !readablePages.has(c.page)) {
        sawConflict = true;
        findings.push(`A claim cites page ${c.page}, which is not an established page of its source document.`);
      }
      if (c.warning && /low-confidence OCR/.test(c.warning)) sawReviewNeeded = true;
      if (c.warning && /carried forward/.test(c.warning)) {
        sawReviewNeeded = true;
      }
      // Factual record may not assert causation or future-care necessity.
      if (CAUSAL_RE.test(c.value)) {
        sawConflict = true;
        findings.push(`A claim (${c.field}, ${label}) asserts causation or future-care necessity, which is not a documented record fact.`);
      }
    }

    // Summary integrity.
    if (CAUSAL_RE.test(e.factualSummary)) {
      sawConflict = true;
      findings.push(`The factual summary for ${label} asserts causation or future-care necessity.`);
    }
    if (NO_TREATMENT_RE.test(e.factualSummary)) {
      sawFailure = true;
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
          findings.push(`A synthesized sentence for ${label} has no mapped supporting claim.`);
          continue;
        }
        if (support.some((id) => !claimIds.has(id))) {
          sawConflict = true;
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
    findings.push(`${dupes} apparent duplicate encounter group(s) require review.`);
  }

  // ── 4. Chronological ordering of dated encounters ─────────────────────────
  const dated = input.encounters.filter((e) => e.encounterDate).map((e) => e.encounterDate!);
  const sorted = [...dated].sort();
  if (dated.join("|") !== sorted.join("|")) {
    sawReviewNeeded = true;
    findings.push("Dated encounters are not in chronological order as presented.");
  }

  // ── 5. Nothing extracted at all ───────────────────────────────────────────
  if (input.encounters.length === 0) {
    return {
      result: input.pages.length === 0 ? "FAILED" : "EXTRACTION_INCOMPLETE",
      findings: [...findings, "No encounters were extracted from the available source pages."],
    };
  }

  // Severity order: a hard integrity failure outranks a source conflict, which
  // outranks incompleteness, which outranks an ordinary review flag.
  const result: AuditResult = sawFailure
    ? "FAILED"
    : sawConflict
      ? "SOURCE_CONFLICT"
      : sawIncomplete
        ? "EXTRACTION_INCOMPLETE"
        : sawReviewNeeded
          ? "NEEDS_HUMAN_REVIEW"
          : "PASS";

  return { result, findings };
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
