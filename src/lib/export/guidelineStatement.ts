/**
 * What the report may say about guideline support for one recommendation.
 *
 * It printed a "Guideline basis" line built from `guidelineSourcesFor` — a
 * category-and-region lookup that returns ODG plus whichever specialty bodies
 * plausibly cover the area — and described them as "applied to determine
 * whether this care is medically necessary now or in the future".
 *
 * None of that was true of this recommendation. The list is generic: it is
 * derived from the service category, not from anything about this patient, and
 * no one had checked that any of those bodies says anything about this pairing.
 * Every row in the diagnosis-to-intervention table ships UNVERIFIED, so the
 * engine's own position was that it could not vouch for the mapping — while the
 * exported report named real organisations and said their guidance had been
 * applied.
 *
 * A defence expert reads "ODG applied" as a checkable claim. This module decides
 * which claim the record can actually support.
 */

export type GuidelineSupportState =
  /** Verified, item-specific guidance recorded in this item's basis. */
  | "APPLIED"
  /** A mapping exists but nobody has verified it against its publication. */
  | "REVIEW_CANDIDATE"
  /** The basis no longer matches the record, so its guidance cannot be cited. */
  | "STALE_BASIS"
  /** The guideline search failed or never ran; absence proves nothing. */
  | "RETRIEVAL_UNRESOLVED"
  /** Nothing to say. */
  | "NONE";

export interface GuidelineStatementInput {
  /** Verified, item-specific guidance from the recorded basis. */
  verifiedItemSpecific: readonly { title: string; claim: string }[];
  /** Guideline rows recorded as accepted evidence for this item. */
  recordedGuidelineEvidence: readonly { text: string; source: string | null }[];
  /** Generic category/region sources. CONTEXT ONLY — never support. */
  genericSources: readonly string[];
  /** Whether the recorded basis still matches the current record. */
  basisState: "CURRENT" | "STALE" | "MISSING";
  /** Latest outcome of the standard-of-care producer for this case. */
  retrieval: { status: string; failure: string | null; failedSources?: readonly string[] } | null;
}

export interface GuidelineStatement {
  state: GuidelineSupportState;
  /** The label the report prints beside the text. */
  label: string;
  text: string;
}

/**
 * Decide the guideline statement.
 *
 * Order matters, and it runs strictest-first: a claim of applied support has to
 * survive every reason it might be unfounded before it can be made.
 */
export function guidelineStatement(input: GuidelineStatementInput): GuidelineStatement {
  const generic = input.genericSources.slice(0, 3);
  const contextTail = generic.length
    ? ` The sources consulted for this service category are ${generic.join("; ")}; they are listed as context and are not item-specific support.`
    : "";

  // A basis that no longer describes the plan cannot lend its guidance to it.
  if (input.basisState !== "CURRENT") {
    return {
      state: "STALE_BASIS",
      label: "Guideline status",
      text:
        input.basisState === "MISSING"
          ? `No recorded basis exists for this recommendation, so no guideline can be cited as applied to it.${contextTail}`
          : `The recorded basis for this recommendation no longer matches the record, so its guideline material is not cited as applied support.${contextTail}`,
    };
  }

  // A search that failed or never ran cannot support either "guidance applies"
  // or "no guidance exists".
  const r = input.retrieval;
  if (r && (r.status === "FAILED" || r.status === "NOT_ATTEMPTED")) {
    return {
      state: "RETRIEVAL_UNRESOLVED",
      label: "Guideline status",
      text: `The guideline search for this case did not complete (${r.status.toLowerCase().replace(/_/g, " ")}${r.failure ? `: ${r.failure.toLowerCase().replace(/_/g, " ")}` : ""}), so no statement is made about whether published guidance applies to this recommendation.${contextTail}`,
    };
  }

  // A partial run retrieved real guidance AND could not reach some sources.
  // The results stand; the narrower coverage is stated rather than left to be
  // inferred from a clean-looking document.
  const partialTail =
    r && r.status === "PARTIAL"
      ? ` Some sources could not be reached during this search (${(r.failedSources ?? []).join(", ") || "one or more sources"}), so coverage here is narrower than a complete run — that is not evidence that no further guidance exists.`
      : "";

  if (input.verifiedItemSpecific.length) {
    const cited = input.verifiedItemSpecific
      .slice(0, 3)
      .map((g) => `${g.title} — ${g.claim}`)
      .join("; ");
    return {
      state: "APPLIED",
      label: "Guideline basis",
      text: `${cited}. Each was verified against its publication for this diagnosis and intervention, and is recorded in this recommendation's basis.${partialTail}`,
    };
  }

  // A mapping exists and is unverified. It stays visible as a review candidate
  // — deleting it would hide something a physician may want to check — but it
  // is not described as applied, does not support necessity, and does not enter
  // any total.
  if (input.recordedGuidelineEvidence.length) {
    const shown = input.recordedGuidelineEvidence
      .slice(0, 3)
      .map((g) => `${g.text}${g.source ? ` (${g.source})` : ""}`)
      .join("; ");
    return {
      state: "REVIEW_CANDIDATE",
      label: "Guideline review candidates",
      text: `${shown}. These pairings have not been verified against their publications and are shown for review only — they are not relied upon as support for medical necessity.${partialTail}${contextTail}`,
    };
  }

  if (generic.length) {
    return {
      state: "NONE",
      label: "Guideline status",
      text: `No verified, item-specific guideline support is recorded for this recommendation.${partialTail}${contextTail}`,
    };
  }

  return { state: "NONE", label: "Guideline status", text: "No verified, item-specific guideline support is recorded for this recommendation." };
}
