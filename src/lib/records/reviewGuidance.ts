// ─────────────────────────────────────────────────────────────────────────────
// Why is this record in Attention Required, and what should be done about it?
//
// A card that says "needs review" and nothing else is a dead end. On the
// reference case every one of 180 flagged records showed exactly that: no
// reason, no next step, and a Verify button the server would refuse. The
// reviewer's only route forward was to guess.
//
// So every flagged record states, in plain language:
//   • WHY it is flagged, from the strongest evidence actually recorded;
//   • WHAT to do about it, as concrete steps;
//   • whether it can be attested at all, so no one clicks into a refusal.
//
// The reasons are derived from persisted evidence, never invented. When the
// evidence for a conflict was not recorded — rows graded before dispute state
// had columns — that is said outright rather than dressed up: an honest
// "we cannot show you why, here is how to find out" beats a confident
// sentence nobody can check.
// ─────────────────────────────────────────────────────────────────────────────

export interface GuidanceInput {
  status: string;
  auditResult: string | null;
  dateStatus: string;
  /** Null on rows graded before dispute state was persisted. */
  auditVersion?: string | null;
  unresolvedDisputes?: number | null;
  contradictedFields?: string[] | null;
  staleReason?: string | null;
  /** Fields this note's own fragments disagree about. */
  fragmentDisagreement?: string[] | null;
  corroboration?: { result?: string; unreproducedFields?: string[] } | null;
  findings?: { type: string; detail: string; blocking: boolean; field?: string | null; status: string }[];
  /**
   * Warnings the extractor recorded against individual claims. These are the
   * evidence behind most NEEDS_HUMAN_REVIEW grades, and they name the field and
   * page — so the card can say what to look at instead of "something".
   */
  claimWarnings?: { field?: string | null; page?: number | null; warning?: string | null }[];
}

export interface ReviewGuidance {
  /**
   * ONE imperative sentence: what this record needs from the reviewer.
   *
   * The card used to lead with evidence — an eight-fragment note opened with
   * four raw extraction claims and a "Show all 318 claims" link, so the first
   * thing a physician read was an account number and some garbled OCR. The
   * question they are actually answering is "what do you need from me", and
   * this is the answer. `why` and `steps` remain, one level down, for when
   * the short answer is not enough.
   */
  requirement: string;
  /** One sentence: why this is here. */
  why: string;
  /** What the reviewer can do, most direct first. */
  steps: string[];
  /**
   * False when a blocking exception must be corrected or dispositioned first.
   * The button is disabled with this reason rather than failing on click.
   */
  canAttest: boolean;
  /** Short label for the reason, for grouping and telemetry. */
  kind:
    | "UNDATED"
    | "STALE"
    | "GENERATION_LOSS"
    | "CONTRADICTED_FIELD"
    | "FRAGMENT_DISAGREEMENT"
    | "UNRESOLVED_DISPUTE"
    | "NOT_CORROBORATED"
    | "DOCUMENT_INCOMPLETE"
    | "INTEGRITY_FAILURE"
    | "LEGACY_CONFLICT"
    | "LOW_CONFIDENCE_OCR"
    | "CARRIED_FORWARD"
    | "REVIEW_FLAG"
    | "CLEAN";
}

/**
 * Is this note an EXCEPTION, or a sound record carrying a CAUTION?
 *
 * The distinction the review queue was missing. On the reference case 155 of
 * 239 notes were exceptions, and 64 of them were things no reviewer could act
 * on:
 *
 *   • 46 said, in their own guidance, "This entry is sound in itself; the
 *     DOCUMENT it came from is incomplete… Nothing needs correcting on this
 *     card." That is the very defect the scoped-finding model exists to kill —
 *     a document-level problem copied onto every note inside it — and it was
 *     still happening through the inherited audit RESULT rather than through
 *     findings. The document's blocker is shown once at document scope and
 *     gates the export; the note is fine.
 *
 *   • 18 carried text copied forward from an earlier note. The text is
 *     genuinely in the source; both "yes, that is what the note says" and "no,
 *     correct it" are legitimate outcomes of reading the page.
 *
 * An EXCEPTION is a note that cannot be attested as it stands — something is
 * wrong with THIS record and a person must change or dispose of it. A CAUTION
 * is a note a person may attest, having been told what to look at first. Both
 * show their panel; only an exception holds the queue.
 */
export type AttentionLevel = "EXCEPTION" | "CAUTION" | "CLEAN";

/** Kinds a reviewer can attest over, once they have read the caution. */
const CAUTION_KINDS: ReadonlySet<ReviewGuidance["kind"]> = new Set([
  "DOCUMENT_INCOMPLETE",
  "LEGACY_CONFLICT",
  "CARRIED_FORWARD",
  "LOW_CONFIDENCE_OCR",
  "REVIEW_FLAG",
]);

export function attentionLevel(guidance: ReviewGuidance): AttentionLevel {
  if (guidance.kind === "CLEAN") return "CLEAN";
  return CAUTION_KINDS.has(guidance.kind) ? "CAUTION" : "EXCEPTION";
}

/**
 * Field keys are written for code — `objectiveFindings`, `pastMedicalHistory`.
 * A reviewer is reading a sentence, so say them the way they would be said.
 */
const humanField = (field: string): string =>
  field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();

const fieldPhrase = (fields: readonly string[]): string => {
  const named = fields.map(humanField);
  if (named.length === 1) return `the ${named[0]}`;
  return `the ${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
};

/**
 * "the assessment and plan (pp. 12, 14)" — what to look at, and where. The
 * verb has to agree with it, so the count comes back too.
 */
const warnedPhrase = (warned: NonNullable<GuidanceInput["claimWarnings"]>): { subject: string; plural: boolean } => {
  const fields = [...new Set(warned.map((w) => w.field).filter((f): f is string => !!f))];
  const pages = [...new Set(warned.map((w) => w.page).filter((p): p is number => typeof p === "number"))].sort((a, b) => a - b);
  const where = pages.length ? ` (p${pages.length > 1 ? "p" : ""}. ${pages.join(", ")})` : "";
  return { subject: `${fields.length ? fieldPhrase(fields) : "some content"}${where}`, plural: fields.length > 1 };
};

/**
 * Derive the reviewer-facing reason and next steps for one canonical note.
 *
 * Ordered by what a reviewer should deal with first: a contradiction the
 * adjudicator confirmed outranks a generic conflict, which outranks a
 * document-level completeness problem this record did not cause.
 */
export function guidanceFor(input: GuidanceInput): ReviewGuidance {
  const openFindings = (input.findings ?? []).filter((f) => f.status === "OPEN" || f.status === "CONFIRMED");
  const blocking = openFindings.filter((f) => f.blocking);

  // 1. A field the source actively contradicts — the most specific thing there is.
  const contradicted = input.contradictedFields?.length
    ? input.contradictedFields
    : blocking.filter((f) => f.type.startsWith("CONTRADICTED_")).map((f) => f.field ?? f.type.replace("CONTRADICTED_", "").toLowerCase());
  if (contradicted?.length) {
    return {
      kind: "CONTRADICTED_FIELD",
      requirement: `Correct ${fieldPhrase(contradicted)} to match the source, or reject this record.`,
      why: `An independent check read the source and found it contradicts ${fieldPhrase(contradicted)} recorded here. Nothing was changed automatically, because the correct value was never established.`,
      steps: [
        `Open the cited page and read ${fieldPhrase(contradicted)} in the source.`,
        `Use Correct to set ${fieldPhrase(contradicted)} from what the record actually says.`,
        "If this entry does not belong to the case at all, use Reject.",
      ],
      canAttest: false,
    };
  }

  // 2. The note's own fragments disagree with each other. Taking the first
  //    populated value would pick a winner silently; say so instead.
  const disagreement = input.fragmentDisagreement ?? [];
  if (disagreement.length) {
    return {
      kind: "FRAGMENT_DISAGREEMENT",
      requirement: `Decide which ${fieldPhrase(disagreement)} the record supports, then correct it.`,
      why: `The extracts that make up this record disagree about ${fieldPhrase(disagreement)}. They were assembled as one note, so one of them describes something else — or the note spans more than one encounter.`,
      steps: [
        `Open the cited pages and read ${fieldPhrase(disagreement)} on each.`,
        `Use Correct to set ${fieldPhrase(disagreement)} for the whole record once you know which reading is right.`,
        "If two different encounters were merged, Reject this record and re-extract the document.",
      ],
      canAttest: false,
    };
  }

  // 3. Stale human work: someone reviewed this, then the source changed.
  if (input.status === "STALE") {
    return {
      kind: "STALE",
      requirement: "Re-confirm this record, or dismiss the stale copy.",
      why: input.staleReason?.trim() || "This entry was reviewed, and its source content changed afterwards, so the earlier review no longer covers what the record now says.",
      steps: [
        "Compare this entry with the fresh draft shown beside it.",
        "Verify it again if it is still correct, or Dismiss the stale copy to keep the fresh draft.",
      ],
      canAttest: true,
    };
  }

  if (input.status === "GENERATION_LOSS") {
    return {
      kind: "GENERATION_LOSS",
      requirement: "Confirm this record is in the source, or reject it.",
      why: "An earlier extraction produced this entry and the current one did not reproduce it, so no current reading of the source supports it.",
      steps: [
        "Check the cited page: if the content is really there, Verify to keep it.",
        "If the source does not support it, Reject — it will leave the records and the chronology.",
      ],
      canAttest: true,
    };
  }

  // 3. A blind second reading disagreed about specific facts.
  if (input.corroboration?.result === "NOT_CORROBORATED") {
    const fields = input.corroboration.unreproducedFields ?? [];
    return {
      kind: "NOT_CORROBORATED",
      requirement: "Check the named fields against the source, then confirm.",
      why: `A second reading of the source, taken without sight of this extraction, did not reproduce ${fields.length ? fieldPhrase(fields) : "every fact recorded here"}.`,
      steps: [
        "Check the named fields against the cited page.",
        "Correct anything the source does not support, then Verify.",
      ],
      canAttest: true,
    };
  }

  // 4. A disagreement that was recorded but never settled.
  const disputes = input.unresolvedDisputes ?? 0;
  if (disputes > 0) {
    return {
      kind: "UNRESOLVED_DISPUTE",
      requirement: "Decide which reading the source supports, then correct or confirm.",
      why: `A second pass disagreed with ${disputes} extracted fact${disputes === 1 ? "" : "s"} here, and reading the source did not settle the disagreement either way.`,
      steps: [
        "Open the cited page and decide which reading the source supports.",
        "Correct the entry if the extraction is wrong; Verify if it is right.",
      ],
      canAttest: false,
    };
  }

  // 5. No supportable date.
  if (input.dateStatus === "UNKNOWN") {
    return {
      kind: "UNDATED",
      requirement: "Set the service date from the source, or reclassify this as material that carries none.",
      why: "No date in the source could be supported for this entry, so it is held off the dated chronology rather than being placed on a guessed date.",
      steps: [
        "Read the service date from the source page and set it in the date field on this card.",
        "If this material carries no service date at all — a fee schedule, a letter — reclassify it so it is not expected to have one.",
      ],
      canAttest: true,
    };
  }

  // 6. A conflict whose evidence predates the columns that would record it.
  if (input.auditResult === "SOURCE_CONFLICT" && !input.auditVersion) {
    return {
      kind: "LEGACY_CONFLICT",
      requirement: "Check this record against its cited page, then confirm.",
      why: "An earlier extraction graded this entry a source conflict, but that run did not record what the disagreement was, so it cannot be shown to you here.",
      steps: [
        "Check the entry against its cited page — that is the fastest resolution.",
        "Verify it if the source supports it, or Correct it if not.",
        "Re-extracting this document will reproduce the disagreement with its reasons, or clear it.",
      ],
      canAttest: true,
    };
  }

  // 7. Document-level incompleteness this entry did not cause.
  if (input.auditResult === "EXTRACTION_INCOMPLETE") {
    return {
      kind: "DOCUMENT_INCOMPLETE",
      requirement: "Nothing on this record. Read it and confirm.",
      why: "This entry is sound in itself; the DOCUMENT it came from is incomplete — part of it was not read, or a dated note produced no entry.",
      steps: [
        "Nothing needs correcting on this card.",
        "The document-level problem is listed with the document above and blocks a final export until it is resolved.",
      ],
      canAttest: true,
    };
  }

  if (input.auditResult === "FAILED") {
    return {
      kind: "INTEGRITY_FAILURE",
      requirement: "Correct this record so every statement has support, or reject it.",
      why: "This entry failed an integrity check — it carries no citable claim, or a claim with no supporting excerpt, so there is nothing to verify against the source.",
      steps: ["Check the cited page.", "Correct the entry so every statement has support, or Reject it."],
      canAttest: false,
    };
  }

  if (blocking.length) {
    return {
      kind: "REVIEW_FLAG",
      requirement: "Check this record against its cited page, then confirm.",
      why: blocking[0].detail,
      steps: ["Resolve the finding shown below, then verify."],
      canAttest: false,
    };
  }

  if (openFindings.length || input.auditResult === "NEEDS_HUMAN_REVIEW") {
    // A finding recorded against this entry already says what is wrong; use its
    // own words rather than a category.
    if (openFindings.length) {
      return {
        kind: "REVIEW_FLAG",
      requirement: "Check this record against its cited page, then confirm.",
        why: openFindings[0].detail,
        steps: ["Check the entry against its cited page.", "Verify if it is right; Correct or Reject if not."],
        canAttest: true,
      };
    }

    // Otherwise the reason is on the claims themselves. These two warnings are
    // what the extractor raises, and between them they account for nearly every
    // review flag on the reference case — so name the field and the page rather
    // than telling the reviewer it is "commonly" one thing or another.
    const warned = (input.claimWarnings ?? []).filter((w) => w.warning);
    const lowOcr = warned.filter((w) => /low-confidence OCR/i.test(w.warning!));
    if (lowOcr.length) {
      const { subject, plural } = warnedPhrase(lowOcr);
      return {
        kind: "LOW_CONFIDENCE_OCR",
      requirement: "Check the named field against the page, then confirm.",
        why: `${subject} ${plural ? "were" : "was"} read from a page whose text recognition scored low confidence, so the characters themselves may not be what the page says.`,
        steps: [
          "Open the cited page and read the named field directly off the source.",
          "Correct anything the page does not support, then Verify.",
        ],
        canAttest: true,
      };
    }

    const copied = warned.filter((w) => /carried forward/i.test(w.warning!));
    if (copied.length) {
      const { subject, plural } = warnedPhrase(copied);
      return {
        kind: "CARRIED_FORWARD",
      requirement: "Check whether this was assessed at this visit, then confirm or correct.",
        why: `${subject} ${plural ? "repeat" : "repeats"} wording that already appeared in an earlier note in this record. The text is genuinely in the source, but copied-forward history is not evidence the finding was observed again at this visit.`,
        steps: [
          "Open the cited page and check whether this was assessed at this visit or brought forward from a previous one.",
          "If it was only carried forward, Correct the entry so it states what happened here.",
          "If the entry faithfully reflects the note as written, Verify it as it stands.",
        ],
        canAttest: true,
      };
    }

    return {
      kind: "REVIEW_FLAG",
      requirement: "Check this record against its cited page, then confirm.",
      why: "An automated check flagged this entry for a human's eye. The check that fired was recorded against the document rather than against this entry, so it cannot be named on this card.",
      steps: [
        "Check the entry against its cited page — that resolves it either way.",
        "Verify if the source supports it; Correct or Reject if not.",
        "The document's own findings are listed with the document above.",
      ],
      canAttest: true,
    };
  }

  return {
    kind: "CLEAN",
    requirement: "Read this record against its cited pages and confirm it.",
    why: "Automated checks found nothing wrong with this record. It still needs a person to confirm it.",
    steps: ["Read the record against its cited pages.", "Verify to attest it."],
    canAttest: true,
  };
}
