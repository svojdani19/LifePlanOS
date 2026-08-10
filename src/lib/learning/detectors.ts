// ─────────────────────────────────────────────────────────────────────────────
// Turning what the pipeline already notices into findings the loop can act on.
//
// The program has had three detectors for a while — the extraction critic, the
// factual audit, and the section ledger — and none of them fed anything that
// outlived the run. A critic finding was a warning string on an encounter; a
// ledger miss was a percentage in a report nobody stored. The defects were
// visible and then they were gone, which is why the same ones kept coming back.
//
// The translation each detector needs is different, and the difference matters:
//
// THE SECTION LEDGER IS SELF-CONFIRMING. It compares extracted claims against
// the uploaded document: "this page prints an Assessment heading and we
// captured nothing from it" is not an opinion. Those arrive VALIDATED, because
// the source has already disagreed with the output and there is nothing for a
// human to adjudicate.
//
// THE CRITIC IS NOT. It is a model asked to find fault, and it obliges. Its
// findings arrive DETECTED and influence nothing until something confirms them.
// Recording them anyway is the point: the rate at which the critic cries wolf
// is a number worth having, and it can only be measured if the rejections are
// kept.
//
// Nothing here writes record text. A finding carries ids, codes and versions.
// ─────────────────────────────────────────────────────────────────────────────

import { detectFinding, validateFinding, type DetectionSource, type PipelineVersions } from "@/lib/learning/findingService";
import { codeFromCorrectionCategory, isFailureCode, type FailureCode } from "@/lib/learning/failureTaxonomy";
import type { SectionVerdict } from "@/lib/records/sectionLedger";
import type { AnalysisClass } from "@/lib/documents/analysisClass";

export interface DetectorContext extends PipelineVersions {
  firmId: string;
  caseId?: string | null;
  documentId?: string | null;
  encounterId?: string | null;
  documentClass?: AnalysisClass | string | null;
}

/**
 * Record the ledger's recoverable misses.
 *
 * Only RECOVERABLE_MISS becomes a finding. ABSENT_FROM_SOURCE is the record not
 * documenting a section, which is not a defect — an emergency note has no
 * operative findings, and manufacturing a failure out of that would drown the
 * real ones.
 *
 * These are validated on creation. The confirmation is deterministic and
 * already done: the heading is in the span and no claim came from it.
 */
export async function detectLedgerMisses(ctx: DetectorContext, sections: readonly SectionVerdict[]) {
  const recoverable = sections.filter((s) => s.state === "RECOVERABLE_MISS");
  const created = [];
  for (const section of recoverable) {
    const finding = await detectFinding({
      ...ctx,
      documentClass: typeof ctx.documentClass === "string" ? ctx.documentClass : null,
      sectionType: section.key,
      failureCode: "MISSED_SECTION",
      detectionSource: "SECTION_LEDGER",
    });
    const validated = await validateFinding({
      findingId: finding.id,
      firmId: ctx.firmId,
      validatorKind: "DETERMINISTIC",
      confirmed: true,
      correctionReason: "SECTION_HEADING_PRESENT_NO_CLAIMS",
    });
    created.push(validated);
  }
  return created;
}

/**
 * Map the extraction critic's and factual audit's warnings onto failure codes.
 *
 * The warnings are prose written for a reviewer, so this reads them for the
 * defect they describe rather than trusting them to be structured. Anything it
 * cannot classify is dropped rather than filed as OTHER: a finding with the
 * wrong code is worse than no finding, because it pollutes the repeat-failure
 * rate for a code that did not actually recur.
 */
const WARNING_PATTERNS: [RegExp, FailureCode][] = [
  [/laterality|left.{0,12}right|right.{0,12}left/i, "WRONG_LATERALITY"],
  [/negation|negative finding.{0,20}(?:reversed|asserted)|stated as present/i, "NEGATION_REVERSED"],
  [/(?:recommended|planned|scheduled).{0,40}(?:as|described).{0,20}(?:delivered|performed|completed)/i, "PLANNED_AS_PERFORMED"],
  [/consent.{0,30}(?:as|treated as).{0,20}treatment/i, "CONSENT_AS_TREATMENT"],
  [/not supported by its excerpt|excerpt does not|claim dropped \(value not supported/i, "UNSUPPORTED_CLAIM"],
  [/no supportable encounter date|date requires human review/i, "WRONG_DATE"],
  [/provider claim dropped|provider not supported/i, "WRONG_PROVIDER"],
  [/copied forward|carried forward as current/i, "COPIED_FORWARD_AS_CURRENT"],
  [/anatom(?:y|ic).{0,20}(?:mismatch|inconsistent)/i, "WRONG_ANATOMY"],
  [/extraction incomplete|pages? not processed/i, "MISSED_ENCOUNTER"],
];

export function codeFromWarning(warning: string): FailureCode | null {
  for (const [re, code] of WARNING_PATTERNS) if (re.test(warning)) return code;
  return null;
}

/**
 * Record critic and audit warnings as unconfirmed allegations.
 *
 * Deliberately does NOT validate them. The critic is a model asked to find
 * fault; the source has not been consulted. They sit at DETECTED, influence
 * nothing, and wait for a deterministic check or a human.
 */
export async function detectFromWarnings(
  ctx: DetectorContext,
  warnings: readonly string[],
  source: DetectionSource = "CRITIC",
) {
  const created = [];
  for (const warning of warnings) {
    const code = codeFromWarning(warning);
    if (!code) continue;
    created.push(
      await detectFinding({
        ...ctx,
        documentClass: typeof ctx.documentClass === "string" ? ctx.documentClass : null,
        failureCode: code,
        detectionSource: source,
      }),
    );
  }
  return created;
}

/**
 * Record pairs the merger could not tell apart.
 *
 * A POSSIBLE_DUPLICATE verdict means the identity decision found nothing
 * conflicting and nothing proving — exactly the state that must not be resolved
 * silently in either direction. It becomes a finding so a reviewer can see what
 * the program was unsure about.
 */
export async function detectPossibleDuplicates(ctx: DetectorContext, possibleDuplicateOf: readonly string[]) {
  if (!possibleDuplicateOf.length) return [];
  return [
    await detectFinding({
      ...ctx,
      documentClass: typeof ctx.documentClass === "string" ? ctx.documentClass : null,
      failureCode: "MISSED_DUPLICATE",
      detectionSource: "DETERMINISTIC_CHECK",
      originalClaimIds: [...possibleDuplicateOf],
    }),
  ];
}

/**
 * Record a reviewer's correction as a confirmed finding.
 *
 * This is the one detection path that arrives already true: a human with
 * standing has changed the output. The existing correction categories say what
 * a reviewer TOUCHED rather than what the program got wrong, so a caller that
 * knows the actual failure code should pass it — the mapping is a fallback, not
 * a preference.
 */
export async function detectFromReviewerCorrection(
  ctx: DetectorContext,
  input: {
    category: string;
    failureCode?: string;
    reviewerId: string;
    reviewerRole: string;
    correctionDelta?: { field: string; changeType: string }[];
    addedClaimIds?: string[];
    removedClaimIds?: string[];
    selectedClaimIds?: string[];
    changedMeaning?: boolean;
  },
) {
  const code =
    input.failureCode && isFailureCode(input.failureCode)
      ? (input.failureCode as FailureCode)
      : codeFromCorrectionCategory(input.category);

  const finding = await detectFinding({
    ...ctx,
    documentClass: typeof ctx.documentClass === "string" ? ctx.documentClass : null,
    failureCode: code,
    detectionSource: "HUMAN_REVIEW",
  });

  return validateFinding({
    findingId: finding.id,
    firmId: ctx.firmId,
    validatorKind: "HUMAN_REVIEWER",
    confirmed: true,
    reviewerId: input.reviewerId,
    reviewerRole: input.reviewerRole,
    correctionReason: input.category,
    correctionDelta: input.correctionDelta,
    addedClaimIds: input.addedClaimIds,
    removedClaimIds: input.removedClaimIds,
    selectedClaimIds: input.selectedClaimIds,
    changedMeaning: input.changedMeaning,
  });
}
