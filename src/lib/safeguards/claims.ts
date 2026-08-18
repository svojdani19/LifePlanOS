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

/**
 * What it takes for a claim to be SATISFIED rather than merely implemented.
 *
 * The registry's first version tested behaviour: given this input, does the
 * mechanism withhold its blessing? That caught labels outrunning logic, and
 * missed the next failure entirely — `reviewWithCopies` was correct code, it
 * passed its refutation, and nothing called it. The card kept promising that
 * one review covered every copy while the wired path submitted one document's
 * rows. A guarantee implemented in unreachable code is not a guarantee.
 *
 * So a claim is satisfied only when all five hold:
 *
 *   1. the user-facing surface makes the claim;
 *   2. a rendered action invokes the implementing path;
 *   3. the request carries the protected data the claim depends on;
 *   4. the server enforces the invariant independently of the client;
 *   5. persistence and the final gate reflect the result.
 *
 * A server-only invariant (nothing is claimed on screen) registers with no
 * `surface` or `rendered` — but its enforcing module must still be reachable
 * from real code, which is checked the same way.
 */
export interface ReachabilityContract {
  /** 1. Where the claim is made, and the words that make it. */
  surface?: { file: string; claimText: string[] };
  /** 2. The function that implements it, and the rendered actions calling it. */
  rendered?: { entryPoint: string; invokedBy: string[] };
  /** 3. Protected data the request must carry — hashes, ids, fingerprints. */
  carries?: string[];
  /** 4. The server module, and what it must be seen to enforce itself. */
  server: { file: string; enforces: string[] };
  /** 5. Where the result is persisted or gated on. */
  persists?: { file: string; contains: string[] };
  /**
   * Exported symbols that must be referenced from non-test code. This is the
   * dead-implementation check: a symbol nothing outside its own file and its
   * tests uses is not wired to anything.
   */
  reachableSymbols?: { file: string; symbols: string[] }[];
  /** Text that must NOT appear anywhere — a retired unreachable path. */
  forbidden?: { file: string; text: string[] }[];
}

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
  /** How this claim is proved reachable, end to end. */
  reachability?: ReachabilityContract;
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
    reachability: {
      surface: { file: "src/components/case/CaseWorkspace.tsx", claimText: ["One decision here", "This record also appears in"] },
      rendered: { entryPoint: "async function reviewNote", invokedBy: ['reviewNote(e, "verify")', 'reviewNote(e, "reject")'] },
      // Every member's hash, and the note identity the server resolves from.
      carries: ["encounters/group", "note.contentHashes", "canonicalNoteId: note.id"],
      server: {
        file: "src/app/api/cases/[caseId]/records/encounters/group/route.ts",
        // Exact membership, displayed content, and all-or-none.
        enforces: ["parseCanonicalNoteId", "not a member of this note", "did not display", "$transaction", "encounterContentHash"],
      },
      // The copies are members of the note, so the payload carries them.
      reachableSymbols: [{ file: "src/lib/records/noteProjection.ts", symbols: ["projectNotes"] }],
      forbidden: [{ file: "src/components/case/CaseWorkspace.tsx", text: ["reviewWithCopies"] }],
    },
  },
  {
    id: "canonical-note-review",
    module: "src/app/api/cases/[caseId]/records/encounters/group/route.ts",
    labels: ["Verify record", "Reject"],
    asserts:
      "One decision covers exactly the rows of one canonical note, as those rows stand now, and the server refuses it over an unresolved exception rather than relying on a disabled button.",
    doesNotAssert: ["that the record is clinically correct", "that the document it came from is complete"],
    assertsAttestation: true,
    consequenceIfOverclaimed:
      "A signature could cover unrelated rows, half a record, or an entry whose date the source contradicts.",
    reachability: {
      surface: { file: "src/components/case/CaseWorkspace.tsx", claimText: ["Verify"] },
      rendered: { entryPoint: "async function reviewNote", invokedBy: ['reviewNote(e, "verify")'] },
      carries: ["canonicalNoteId: note.id", "expectedContentHash"],
      server: {
        file: "src/app/api/cases/[caseId]/records/encounters/group/route.ts",
        enforces: [
          // Membership from the note id, not from the request.
          "parseCanonicalNoteId",
          // Exact set: no extras, no gaps.
          "not exactly the rows of this canonical note",
          // Orphan rows are a note of ONE.
          "claimedRowIds.length === 1",
          // The row's own integrity state, checked here.
          "row.auditResult",
          "unresolvedDisputes",
          "contradictedFields",
          "unresolved finding must be dispositioned first",
        ],
      },
      reachableSymbols: [{ file: "src/lib/records/reviewBurden.ts", symbols: ["parseCanonicalNoteId", "canonicalNoteId"] }],
    },
  },
  {
    id: "finding-disposition",
    module: "src/app/api/cases/[caseId]/records/findings/route.ts",
    labels: ["This is real", "Resolved", "Not a problem", "Blocks final export"],
    asserts:
      "A reviewer's answer to a finding is recorded against that exact finding and the exact source state it was displayed over, with the actor, the prior and new status, and a reason when a blocker is closed.",
    doesNotAssert: [
      "that closing a finding fixes the underlying record",
      "that a dismissal still applies after the source changes",
      "that the machine may answer a finding on a human's behalf",
    ],
    assertsAttestation: true,
    consequenceIfOverclaimed:
      "A blocker could be closed over content the reviewer never saw, or a dismissal could silently carry across a source change into content nobody has read.",
    reachability: {
      surface: { file: "src/components/case/FindingList.tsx", claimText: ["Blocks final export", "This is real"] },
      rendered: { entryPoint: "async function disposition", invokedBy: ['disposition(f, "confirm")', 'disposition(f, "resolve")', 'disposition(f, "dismiss")'] },
      carries: ["records/findings", "expectedFingerprint", "expectedSourceFingerprint"],
      server: {
        file: "src/app/api/cases/[caseId]/records/findings/route.ts",
        enforces: [
          "requireCanonicalPermission",
          "changed since it was displayed",
          "the source content changed since this finding was displayed",
          "Closing a blocking finding requires a reason",
          "dispositionSourceFingerprint",
          "$transaction",
        ],
      },
      reachableSymbols: [{ file: "src/components/case/FindingList.tsx", symbols: ["FindingList", "FoldedFindings"] }],
    },
  },
  {
    id: "note-wide-correction",
    module: "src/app/api/cases/[caseId]/records/encounters/group/correct/route.ts",
    labels: ["Changing the type or date re-runs the chronology and care plan"],
    asserts:
      "A structural correction is applied to every fragment of the canonical note in one transaction, or to none of them, with one audit event and one downstream rebuild.",
    doesNotAssert: ["that a summary or claim correction applies note-wide", "that the correction was verified"],
    consequenceIfOverclaimed:
      "A date correction could land on two of three fragments and report success, leaving a record that disagrees with itself on the chronology.",
    reachability: {
      surface: { file: "src/components/case/CaseWorkspace.tsx", claimText: ["Changing the type or date re-runs the chronology"] },
      rendered: {
        entryPoint: "async function patchNote",
        invokedBy: ["patchNote(e, { encounterDate:", "patchNote(e, { analysisClass:", "patchNote(e, { substanceClass:"],
      },
      carries: ["encounters/group/correct", "canonicalNoteId: note.id", "expectedContentHash"],
      server: {
        file: "src/app/api/cases/[caseId]/records/encounters/group/correct/route.ts",
        enforces: ["parseCanonicalNoteId", "not exactly the rows of this canonical note", "$transaction", "records.note_correct", "ConcurrentChange"],
      },
    },
  },
  {
    id: "finding-lifecycle",
    module: "src/lib/records/recordFindings.ts",
    labels: ["no longer produced by the current deterministic audit"],
    asserts:
      "An automated pass closes only findings that are still OPEN, machine-produced, and inside the scope it actually evaluated; a human's CONFIRMED, DISMISSED or RESOLVED answer is never closed by a machine.",
    doesNotAssert: [
      "that a finding it could not reproduce is gone",
      "that a dismissal covers content the source has changed since",
      "that a partial pass may answer a case-level question",
    ],
    consequenceIfOverclaimed:
      "Re-auditing one document could clear a missing-encounter blocker belonging to a document nobody looked at, and sweep a physician's confirmation away with it.",
    reachability: {
      // Server-only: nothing on screen claims this, but it must be wired.
      server: {
        file: "src/lib/records/recordFindings.ts",
        enforces: ["MACHINE_SOURCES", 'status: "OPEN"', "evaluatedDocumentIds", "evaluatedWholeCase", "dispositionOutlivedItsSource", "dispositionHistory"],
      },
      reachableSymbols: [{ file: "src/lib/records/recordFindings.ts", symbols: ["writeFindings"] }],
    },
  },
  {
    id: "export-gate-visible-findings",
    module: "src/lib/records/structuredRecord.ts",
    labels: ["must be corrected or dispositioned before a final export"],
    asserts:
      "Every unresolved blocking finding is both counted once by identity in the final-export gate AND returned to the review surface at the scope it names, so nothing blocks an export invisibly.",
    doesNotAssert: ["that a visible finding has been answered", "that an answered finding was fixed"],
    consequenceIfOverclaimed:
      "A case could be blocked from export by findings that no screen showed and no action could close.",
    reachability: {
      surface: { file: "src/components/case/CaseWorkspace.tsx", claimText: ["Case-level findings", "Findings about this document"] },
      server: {
        file: "src/lib/records/structuredRecord.ts",
        enforces: [
          // Routed to a scope, never dropped.
          "routeScopedFindings",
          // Every target column the routing reads is actually selected.
          "canonicalNoteId: true",
          "sourceDocumentId: true",
          // Counted once each in the gate.
          "distinctBlocking",
          "must be corrected or dispositioned before a final export",
        ],
      },
      persists: { file: "src/lib/documents/extractionRun.ts", contains: ["writeFindings", "audit.scoped"] },
      reachableSymbols: [{ file: "src/lib/records/structuredRecord.ts", symbols: ["routeScopedFindings"] }],
    },
  },
  {
    id: "item-evidence-ledger",
    module: "src/lib/engine/evidenceLedger.ts",
    labels: ["Supporting clinical evidence", "Expert-selected evidence", "Add a citation"],
    asserts:
      "Each finding shown under a recommendation passed both an anatomy check and a service-compatibility check for the claim it is offered against; a hand-entered citation resolved to a real, retrievable article, and names the role and credential of whoever chose it.",
    doesNotAssert: [
      "that every source considered is shown — the per-claim cap is disclosed",
      "that a frequency or duration is established when no cadence-bearing source exists",
      "that a patient's report establishes the necessity of surgery, imaging or an injection",
      "that an absence of supporting evidence is evidence against",
      "that a hand-entered citation was chosen by a physician — the row names the contributor's actual role",
    ],
    consequenceIfOverclaimed:
      "Five services of one diagnosis would each appear supported by findings that establish only the condition, and an unresolvable reference could be printed as a citation.",
    reachability: {
      surface: { file: "src/components/case/CaseWorkspace.tsx", claimText: ["Expert-selected evidence", "Add a citation"] },
      rendered: { entryPoint: "function AddCitation", invokedBy: ["<AddCitation onAdd={onAddEvidence} />"] },
      carries: ["DOI, PMID, or article title", "onAdd("],
      server: {
        file: "src/app/api/cases/[caseId]/future-care/[itemId]/evidence/route.ts",
        // The SAME canonical key the control is gated on, and the contributor
        // snapshot the heading depends on.
        enforces: ['requireCanonicalPermission(ctx, "futurecare.edit"', "findCandidates", "could not be resolved", "addedByRole", "auditLog"],
      },
      persists: { file: "src/lib/engine/persistLedger.ts", contains: ["addedById: null", "physicianRowsPreserved", "relinkPhysicianEvidence"] },
      reachableSymbols: [
        { file: "src/lib/engine/evidenceLedger.ts", symbols: ["supportsClaim", "buildLedgerWithCap"] },
        { file: "src/lib/engine/persistLedger.ts", symbols: ["persistMachineLedger", "relinkPhysicianEvidence"] },
      ],
    },
  },
  {
    // A READ-MODEL claim. The reachability contract was built to catch code
    // that is never CALLED; this is the mirror failure — data that is never
    // READ. The ledger was written correctly on every generation and no
    // consumer displayed it, so four independent re-derivations stood in for
    // the record, and a plan could be printed over a different set of findings
    // than the one it was approved on with nothing anywhere saying so.
    //
    // `reachableSymbols` therefore names the comparison, and `surface` names
    // the words that promise it. A read model whose consumers do not read it
    // fails this claim the same way an unreachable implementation does.
    id: "recorded-evidence-read-model",
    module: "src/lib/engine/evidenceSet.ts",
    labels: ["Recorded evidence, by claim", "Evidence ledger of record", "Evidence ledger status"],
    asserts:
      "What is displayed and cited for a recommendation is the evidence ledger AS PERSISTED, and where the current record would produce a different set, the difference is stated with its counts rather than resolved silently.",
    doesNotAssert: [
      "that the recorded set is the correct one — which set is right is a question about the case",
      "that a stale set has been reconciled; it is reported, not repaired",
      "that hand-entered citations bear on staleness — they are not derived from anything",
    ],
    consequenceIfOverclaimed:
      "A physician's approval would carry silently onto evidence they never saw, and a report would cite findings the plan was not built on.",
    reachability: {
      surface: { file: "src/components/case/CaseWorkspace.tsx", claimText: ["Recorded evidence, by claim"] },
      rendered: { entryPoint: "function RecordedEvidence", invokedBy: ["<RecordedEvidence rows={recordedEvidence}"] },
      // Checked inside RecordedEvidence's own body: the component must hold the
      // persisted rows AND run the comparison, not merely receive them.
      carries: ["compareEvidenceSets(", "describeEvidenceSet(", "rows.length ?"],
      server: {
        file: "src/app/(app)/cases/[caseId]/page.tsx",
        enforces: ["recommendationEvidence", "addedById == null", "recordedEvidence"],
      },
      // The consumer that would otherwise print a re-derivation: the report.
      persists: { file: "src/lib/export/report.ts", contains: ["recordedByItem", "Evidence ledger of record", "describeEvidenceSet"] },
      reachableSymbols: [
        { file: "src/lib/engine/evidenceSet.ts", symbols: ["compareEvidenceSets", "describeEvidenceSet", "evidenceSetFingerprint"] },
      ],
    },
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
    id: "claim-salvage",
    module: "src/lib/llm/recordExtraction.ts",
    labels: ["claim dropped", "encounter dropped: no claim survived parsing"],
    asserts:
      "A single unparseable claim was dropped, with its field and the reason recorded, and the rest of its page was kept — and the page is marked incomplete so the range is re-read rather than presented as whole.",
    doesNotAssert: [
      "that a response where nothing survived is an empty page",
      "that a salvaged page carries everything its source range holds",
      "that the dropped claim was wrong about the record",
    ],
    consequenceIfOverclaimed:
      "A model answering unusably would read as a page that simply contained nothing, which is the same false statement as a bad extraction — only quieter.",
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
