// ─────────────────────────────────────────────────────────────────────────────
// What each safeguard CLAIMS, in a form that can be tested.
//
// This exists because of a repeated failure with one shape. Three mechanisms
// shipped in a week — machine corroboration, deterministic dispute
// resolution, one-decision cross-document review — and each announced a
// guarantee in its user-facing label that its implementation did not deliver:
//
//   • "corroborated" was awarded to a claim the source NEGATED, because the
//     comparator dropped two-letter words before comparing;
//   • a dispute about an entry's date was "resolved" by discarding it, so a
//     blocking conflict became silence;
//   • "one review covers every copy" fanned out request-by-request from the
//     browser and ignored the failures.
//
// Each was caught by an outside reader, not by the 2,200 tests — because the
// tests asked "does the code do what it does", never "does the label tell the
// truth". So every safeguard registers here: the words a user is shown, what
// those words assert, what they explicitly do NOT assert, and REFUTATIONS —
// inputs where honouring the claim requires the mechanism to withhold its
// blessing. The accompanying test runs the refutations against the real
// implementations and fails when a label outruns its behaviour.
//
// A safeguard with no refutation is not registered; the test fails on it. An
// unfalsifiable guarantee is the thing this file exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Words a label may not use unless the safeguard's claim declares it.
 *
 * Attestation language is the sharpest end of this: only a person can attest,
 * so a machine mechanism labelling itself "verified" or "confirmed" is
 * claiming a thing it structurally cannot do. INDEPENDENCE words are the
 * subtler end — "independent" asserts separation from the thing being
 * checked, which is a configuration fact, not a hope.
 */
export const ATTESTATION_WORDS = ["verified", "attested", "certified", "approved", "confirmed", "signed off"];
export const INDEPENDENCE_WORDS = ["independent", "independently", "second opinion", "cross-checked"];

export interface SafeguardClaim {
  id: string;
  /** Where the mechanism lives, so a reader can go and check. */
  module: string;
  /** The exact words a user is shown. Every one is scanned for over-claiming. */
  labels: string[];
  /** What the mechanism does assert, in plain terms. */
  asserts: string;
  /** What it must never be read as asserting. */
  doesNotAssert: string[];
  /** True only if the mechanism genuinely establishes human attestation. */
  assertsAttestation?: boolean;
  /** True only if the mechanism is genuinely separated from what it checks. */
  assertsIndependence?: boolean;
  /**
   * Why an honest label is worth the words: what a reader would wrongly
   * conclude if the mechanism over-claimed. Recorded for the humans who
   * maintain this, not asserted by the test.
   */
  consequenceIfOverclaimed: string;
}

export const SAFEGUARD_CLAIMS: SafeguardClaim[] = [
  {
    id: "machine-corroboration",
    module: "src/lib/records/corroboration.ts",
    labels: [
      "Machine-corroborated — blind second reading agrees; pending human review",
      "Machine-corroborated — a blind second reading reproduced every fact; pending human review",
      "blind second reading",
    ],
    asserts:
      "A second reading of the source, performed without sight of the extracted content, stated every fact this entry records, agreeing exactly on negation, laterality, anatomy, dates and quantities.",
    doesNotAssert: [
      "that a human reviewed the entry",
      "that the entry is clinically correct",
      "that a different model performed the reading, unless one is configured",
      "that the record as a whole is complete",
    ],
    assertsAttestation: false,
    assertsIndependence: false,
    consequenceIfOverclaimed:
      "A physician could take a corroborated row as reviewed and export a fact no person ever read — and, before the discriminant gate, a fact the source explicitly negated.",
  },
  {
    id: "dispute-adjudication",
    module: "src/lib/llm/extractionCritic.ts",
    labels: ["extraction disagreement(s) remain unresolved", "dispute discarded as unusable"],
    asserts:
      "Every criticism of the extraction is either upheld, rejected on the source, recorded as unresolved for a human, or discarded ONLY when it names no target that exists in the extraction.",
    doesNotAssert: [
      "that a discarded dispute was answered",
      "that an unresolved dispute stops mattering",
      "that an upheld criticism of an entry's date or provider has been corrected",
    ],
    consequenceIfOverclaimed:
      "A contested service date or treating clinician could disappear from the review queue while the row presents as sound.",
  },
  {
    id: "group-review",
    module: "src/app/api/cases/[caseId]/records/encounters/group/route.ts",
    labels: ["one review covers every copy", "This record also appears in"],
    asserts:
      "A single decision is applied to every listed row or to none of them, and each row is checked against the content the reviewer was shown before anything is written.",
    doesNotAssert: ["that copies not listed on the card are covered", "that a correction to one row applies to its copies"],
    assertsAttestation: true, // this one DOES record a human's decision
    consequenceIfOverclaimed:
      "A reviewer could believe every production's copy was signed while some remained unreviewed, or content that changed after display could carry their signature.",
  },
  {
    id: "factual-audit",
    module: "src/lib/llm/factualAudit.ts",
    labels: ["AI draft — audit passed, pending review"],
    asserts:
      "Deterministic checks over the persisted artifacts found nothing wrong with THIS entry, and nothing document-wide that bears on it.",
    doesNotAssert: ["that a human reviewed it", "that the extraction found everything the source contains"],
    assertsAttestation: false,
    consequenceIfOverclaimed: "An audit-passed row could be exported as though a person had checked it.",
  },
  {
    id: "provenance-upgrade",
    module: "src/lib/records/provenanceUpgrade.ts",
    labels: ["One-time provenance upgrade"],
    asserts: "A review recorded before content fingerprinting existed cannot be proven to match the current source, so it is staled once for re-review.",
    doesNotAssert: ["that the earlier reviewer's work was wrong", "that the content changed"],
    consequenceIfOverclaimed: "A physician could think their earlier review was found defective rather than merely unverifiable.",
  },
  {
    id: "patient-attribution",
    module: "src/lib/records/patientAttribution.ts",
    labels: ["Treating provider"],
    asserts: "A provider name that an adjudicator confidently identified as the patient's own has been cleared, leaving the entry unattributed.",
    doesNotAssert: ["that the true provider is known", "that every misattributed name has been found"],
    consequenceIfOverclaimed: "An unattributed entry could read as though its author had been established.",
  },
];

/** Words in a label that the claim has not earned the right to use. */
export function overclaimedWords(claim: SafeguardClaim): string[] {
  const haystack = claim.labels.join(" ").toLowerCase();
  const found: string[] = [];
  if (!claim.assertsAttestation) {
    for (const w of ATTESTATION_WORDS) {
      // "pending human review" and "human review" are honest; the offence is
      // claiming the act is DONE.
      if (new RegExp(`\\b${w}\\b`, "i").test(haystack)) found.push(w);
    }
  }
  if (!claim.assertsIndependence) {
    for (const w of INDEPENDENCE_WORDS) if (new RegExp(`\\b${w}\\b`, "i").test(haystack)) found.push(w);
  }
  return found;
}
