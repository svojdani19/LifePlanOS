// ─────────────────────────────────────────────────────────────────────────────
// The reviewable unit is the canonical NOTE.
//
// A reviewer was being asked one question per extraction row — and rows are
// chunk fragments, so three page-slices of one operative note were three
// signatures. Measured on a real case: 561 rows consolidate into 227 notes,
// 84 of them from more than one row. Well over half the decisions existed only
// because the review surface was finer-grained than the record.
//
// The note is what the chronology cites, what the report prints and what the
// plan is built from, so reviewing it is reviewing the actual assertion. The
// rows stay visible beneath as evidence — every claim, every citation, every
// content hash — because a signature must be inspectable.
//
// Two rules keep consolidation honest:
//   • a note shows the WORST status among its rows, so nothing is laundered;
//   • a note carrying any open entry/claim finding is an exception, not clean.
//
// Membership is NOT decided here. It comes from `groupCanonicalEncounters` —
// the same mechanism the burden metric and the server's own membership
// derivation use — so the surface a reviewer signs, the number that says how
// much work is left, and the set of rows the signature actually covers are
// one answer rather than three.
// ─────────────────────────────────────────────────────────────────────────────

import { canonicalNoteId } from "@/lib/records/reviewBurden";
import { groupCanonicalEncounters, resolvedAmbiguityClusters, type CanonicalRow, type MembershipBasis } from "@/lib/records/canonicalEncounters";
import { isOpenFinding, type FindingScope } from "@/lib/records/findingScope";
import { attentionLevel, guidanceFor, type AttentionLevel, type ReviewGuidance } from "@/lib/records/reviewGuidance";
import type { StructuredEncounter } from "@/lib/records/structuredRecord";

/** Worst-first: a note may never present better than its weakest row. */
const STATUS_RANK: Record<string, number> = {
  GENERATION_LOSS: 0,
  STALE: 1,
  AI_DRAFT: 2,
  AI_AUDIT_PASSED: 3,
  HUMAN_EDITED: 4,
  REVIEWED: 5,
  VERIFIED: 6,
};
const AUDIT_RANK: Record<string, number> = {
  FAILED: 0,
  SOURCE_CONFLICT: 1,
  EXTRACTION_INCOMPLETE: 2,
  NEEDS_HUMAN_REVIEW: 3,
  PASS: 4,
};

export interface NoteFinding {
  id: string;
  scope: FindingScope;
  type: string;
  severity: string;
  blocking: boolean;
  source: string;
  detail: string;
  excerpt?: string | null;
  field?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  encounterId?: string | null;
  claimIndex?: number | null;
  status: string;
}

export interface ReviewableNote {
  /** Stable identity: the document plus the rows this note consolidates. */
  id: string;
  sourceDocumentId: string;
  rowIds: string[];
  /** Every underlying row, in full — evidence, not separate decisions. */
  rows: StructuredEncounter[];
  encounterDate: string | null;
  encounterDateEnd: string | null;
  dateStatus: string;
  /** True when the source documents an explicitly open-ended range. */
  openEndedRange: boolean;
  provider: string | null;
  /** Every distinct provider across the note's fragments, in order. */
  providers: string[];
  providerCredentials: string | null;
  facility: string | null;
  encounterType: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  /** Union of every claim across the note's rows. */
  claims: StructuredEncounter["claims"];
  claimCount: number;
  /** Content hash per row, submitted with a review so nothing is signed unseen. */
  contentHashes: { rowId: string; contentHash: string }[];
  /**
   * Members of this note that live in a DIFFERENT document — the same record
   * produced twice. They are part of the decision, not a footnote to it.
   */
  crossDocumentMembers: { id: string; sourceDocumentId: string; page: number | null; status: string; contentHash: string }[];
  /** The WORST status and audit result among the note's rows. */
  status: string;
  auditResult: string | null;
  /** Findings targeted at this note, its entries or their claims. */
  findings: NoteFinding[];
  /** Copies of this record primarily reviewed under another document. */
  copies: NonNullable<StructuredEncounter["copies"]>;
  /** Set when THIS note is itself a copy reviewed elsewhere. */
  reviewedWith?: { filename: string } | null;
  /** Aggregated worst-first across the note's fragments — never the first one. */
  corroboration?: StructuredEncounter["corroboration"];
  /** Fields the note's own fragments disagree about ("date", "provider"). */
  fragmentDisagreement: string[];
  /** The subset of those that makes the record unsound rather than merely broad. */
  materialDisagreement: string[];
  /**
   * Why this record is where it is, and what to do about it. Present on every
   * note — a card that says only "needs review" leaves a reviewer guessing.
   */
  guidance: ReviewGuidance;
  /** EXCEPTION holds the queue; CAUTION is attestable once read; CLEAN is ready. */
  attention: AttentionLevel;
  /** An exception needing correction or disposition. */
  needsAttention: boolean;
  /** Clean, and awaiting one human attestation. */
  awaitingAttestation: boolean;

  // ── Visible and auditable vs. a decision someone owes ────────────────────
  /**
   * Where this record's membership came from, so a reviewer can see whether
   * they are looking at the records builder's own answer or at a
   * compatibility grouping derived for a document that never got one.
   */
  membershipBasis: MembershipBasis;
  /**
   * Set when the identity rules could neither join this record to nearby
   * fragments nor prove it distinct from them. Raised ONCE for the whole
   * cluster of records the question spans, never once per fragment, and the
   * records stay separate — an unproven merge is a deletion.
   *
   * Clears when a reviewer explicitly reviews or verifies THIS record, which
   * is them answering "yes, these are separate". An ambiguity nothing could
   * clear would be an immortal exception.
   */
  ambiguousAssignment: boolean;
  /** The rows the open assignment question spans, for display before deciding. */
  ambiguousWith: string[];
  /** The cluster this record belongs to, on the anchor and the rest alike. */
  ambiguityClusterId: string | null;
  /**
   * A record in an unresolved cluster that is NOT the one carrying the
   * decision. It owes nobody anything — but it is not a settled record
   * either, so a case-level confirmation passes over it until the cluster's
   * one decision is made.
   */
  ambiguityAwaitingAnchor: boolean;
  /**
   * Does a person OWE a decision on this record?
   *
   * True only for a material exception. A clean record and a record carrying a
   * caution are both visible, auditable and still short of a human signature —
   * but neither is an item in a queue somebody is being asked to clear, and
   * treating every sound record as one is what buried the few that were not.
   */
  requiresDecision: boolean;
  /**
   * The other half of that sentence, said explicitly rather than left implied:
   * this record is sound, it has NOT been human-reviewed or attested, and the
   * confirmation it still needs is the case-level one at final release.
   */
  coveredByCaseConfirmation: boolean;
}

/**
 * Aggregate a note's corroboration from its fragments, worst-first.
 *
 * Three rules, and the first draft of this had none of them — it took the
 * first fragment carrying any verdict, so a corroborated opening fragment
 * could present a note whose second fragment an independent reading had
 * refused to reproduce.
 *
 *   • one refusal refuses the note;
 *   • a fragment with no verdict is NOT evidence of agreement, so a note is
 *     corroborated only when EVERY fragment was actually re-read and agreed;
 *   • the reproduced/total counts are summed across fragments, which is the
 *     only arithmetic that means anything at note level, and the unreproduced
 *     field names are unioned.
 */
export function aggregateCorroboration(
  rows: readonly StructuredEncounter[],
): NonNullable<StructuredEncounter["corroboration"]> | null {
  const verdicts = rows.map((r) => r.corroboration ?? null);
  if (verdicts.every((v) => !v)) return null;

  const present = verdicts.filter((v): v is NonNullable<StructuredEncounter["corroboration"]> => !!v);
  const reproduced = present.reduce((n, v) => n + (v.reproduced ?? 0), 0);
  const total = present.reduce((n, v) => n + (v.total ?? 0), 0);
  const unreproducedFields = [...new Set(present.flatMap((v) => v.unreproducedFields ?? []))];

  const anyRefused = present.some((v) => v.result === "NOT_CORROBORATED");
  const everyFragmentRead = verdicts.every((v) => !!v);
  const everyFragmentAgreed = present.every((v) => v.result === "CORROBORATED");

  return {
    // Partial coverage is not corroboration. A note nobody finished re-reading
    // may not wear the badge of one that was reproduced in full.
    result: !anyRefused && everyFragmentRead && everyFragmentAgreed ? "CORROBORATED" : "NOT_CORROBORATED",
    reproduced,
    total,
    unreproducedFields,
  };
}

/**
 * Do the fragments of one note disagree about who or when?
 *
 * Reported so the note stops silently taking the first populated value. Not
 * every disagreement is a defect, though, and the distinction matters:
 *
 *   • DATE is material. A note sits at one point on the chronology, so
 *     fragments dated differently cannot all be that point.
 *
 *   • PROVIDER often is not. A therapy course, a billing ledger and a
 *     multi-visit packet legitimately name several rendering providers — on
 *     the reference case, 27 notes did, some with ten. Treating those as
 *     defects would manufacture review work out of correct segmentation. They
 *     are reported and DISPLAYED in full instead, which fixes the actual
 *     problem: a single value being presented as if it were the whole truth.
 */
export function fragmentDisagreement(rows: readonly StructuredEncounter[]): string[] {
  const fields: string[] = [];
  const distinct = <T>(values: readonly (T | null | undefined)[]) => new Set(values.filter((v): v is T => v != null && v !== ""));
  if (distinct(rows.map((r) => r.encounterDate)).size > 1) fields.push("date");
  if (distinctProviders(rows).length > 1) fields.push("provider");
  return fields;
}

/** Fields whose disagreement makes the record itself unsound. */
export const MATERIAL_DISAGREEMENT_FIELDS: readonly string[] = ["date"];

/**
 * Every distinct provider named across a note's fragments, in the order they
 * appear. Compared case- and punctuation-insensitively, so "A. Rivera, MD" and
 * "A Rivera MD" are one person written twice rather than two people.
 */
export function distinctProviders(rows: readonly StructuredEncounter[]): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (!r.provider) continue;
    const key = norm(r.provider);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r.provider);
  }
  return out;
}

const worst = <T extends string>(values: readonly (T | null)[], rank: Record<string, number>, fallback: T): T => {
  let bestKey: T = fallback;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const v of values) {
    if (v == null) continue;
    const r = rank[v] ?? Number.POSITIVE_INFINITY;
    if (r < bestRank) {
      bestRank = r;
      bestKey = v;
    }
  }
  return bestKey;
};

/**
 * Build the reviewable notes for one document.
 *
 * `segments` is what `buildRecords` persisted; a row no segment claims becomes
 * its own single-row note, so consolidation can never make a row unreviewable.
 */
export function projectNotes(
  documentId: string,
  segments: unknown,
  rows: readonly StructuredEncounter[],
  findings: readonly NoteFinding[],
  /**
   * Every current row in the CASE, so a segment that spans documents resolves
   * all of its members.
   *
   * A production often contains the same operative note twice. The records
   * builder records that by putting both rows in one segment on the primary
   * document — but this projection only ever saw its own document's rows, so
   * the copy silently fell out of the note while the card kept promising that
   * one review covered every copy.
   */
  caseRows?: ReadonlyMap<string, StructuredEncounter>,
): ReviewableNote[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const resolve = (id: string): StructuredEncounter | undefined => byId.get(id) ?? caseRows?.get(id);

  // Membership from the shared mechanism, over THIS document's rows only.
  // `alsoResolvable` lets a persisted segment name a copy that lives in
  // another production — the linkage the builder proved — without making that
  // copy a candidate for the compatibility fallback, which never leaves the
  // document it was called for.
  const grouped = groupCanonicalEncounters({
    documents: [{ id: documentId, segments }],
    rows: rows as readonly CanonicalRow[],
    alsoResolvable: (id) => Boolean(caseRows?.get(id)),
  });

  // Which assignment questions a person has already answered. An explicit
  // review or verification of the ANCHOR is the answer; a content correction
  // is not, because it says nothing about which records these are.
  const settled = resolvedAmbiguityClusters(grouped, (id) => resolve(id)?.status ?? null);

  const openByEntry = new Map<string, NoteFinding[]>();
  for (const f of findings) {
    if (!f.encounterId) continue;
    openByEntry.set(f.encounterId, [...(openByEntry.get(f.encounterId) ?? []), f]);
  }

  return grouped.map((group) => {
    const rowIds = group.rowIds;
    const noteRows = rowIds.map((id) => resolve(id)).filter((r): r is StructuredEncounter => Boolean(r));
    const id = canonicalNoteId(documentId, rowIds);
    const noteFindings = [
      ...findings.filter((f) => f.scope === "NOTE" && (f as { canonicalNoteId?: string }).canonicalNoteId === id),
      ...rowIds.flatMap((rid) => openByEntry.get(rid) ?? []),
    ];
    const openFindings = noteFindings.filter((f) => isOpenFinding(f.status));

    const inUnresolvedCluster = Boolean(group.ambiguityClusterId) && !settled.has(group.ambiguityClusterId!);
    const unresolvedAnchor = group.ambiguityAnchor && inUnresolvedCluster;

    const dated = noteRows.find((r) => r.encounterDate) ?? noteRows[0];
    const status = worst(noteRows.map((r) => r.status), STATUS_RANK, "AI_DRAFT");
    // Worst-first, and an UNGRADED fragment is the worst of all: a note whose
    // rows the audit never read may not present as PASS because that happened
    // to be the fallback when none of them carried a result. It reported a
    // clean audit over a record nothing had audited.
    const auditResult = noteRows.some((r) => !(r as { auditResult?: string | null }).auditResult)
      ? null
      : worst(noteRows.map((r) => (r as { auditResult?: string | null }).auditResult ?? null), AUDIT_RANK, "PASS");
    const pages = noteRows.flatMap((r) => [r.page, r.pageEnd]).filter((p): p is number => typeof p === "number");
    const corroboration = aggregateCorroboration(noteRows);
    const disagreement = fragmentDisagreement(noteRows);
    const providers = distinctProviders(noteRows);
    // Only a material disagreement becomes a review obligation; the rest is
    // shown, not asked about.
    const material = disagreement.filter((f) => MATERIAL_DISAGREEMENT_FIELDS.includes(f));
    // A note whose fragments disagree about the date is not a dated note; the
    // "worst" reading is that its date is not established.
    const noteDateStatus = noteRows.some((r) => r.dateStatus === "UNKNOWN") || material.includes("date")
      ? "UNKNOWN"
      : (dated?.dateStatus ?? "UNKNOWN");

    const guidance = guidanceFor({
      status,
      auditResult,
      // WORST case across the note's fragments, so the explanation and the
      // flag are computed from the same facts. Reading the date off the first
      // dated fragment alone made 27 records display "ready to attest" inside
      // an amber needs-review panel.
      dateStatus: noteDateStatus,
      auditVersion: noteRows.find((r) => (r as { auditVersion?: string | null }).auditVersion)?.auditVersion ?? null,
      // Worst case across the note's rows: one disputed fragment disputes the
      // record, and one contradicted field contradicts it.
      unresolvedDisputes: noteRows.reduce((n, r) => n + ((r as { unresolvedDisputes?: number | null }).unresolvedDisputes ?? 0), 0),
      contradictedFields: [...new Set(noteRows.flatMap((r) => (r as { contradictedFields?: string[] | null }).contradictedFields ?? []))],
      staleReason: noteRows.find((r) => r.staleReason)?.staleReason ?? null,
      fragmentDisagreement: material,
      // Unresolved membership is a fact about THIS record, raised once for the
      // cluster the question spans.
      ambiguousAssignment: unresolvedAnchor,
      ambiguousWith: group.ambiguousWith.length,
      corroboration: corroboration as never,
      findings: openFindings as never,
      // The extractor's own per-claim warnings, carrying the field and page.
      // They are the evidence behind a review flag; without them the card can
      // only say that something, somewhere, was flagged.
      claimWarnings: noteRows.flatMap((r) =>
        r.claims
          .filter((c) => (c as { warning?: string | null }).warning)
          .map((c) => ({ field: c.field ?? null, page: c.page ?? null, warning: (c as { warning?: string | null }).warning ?? null })),
      ),
    });

    // One source of truth: a record is an exception exactly when its
    // explanation says it is. The panel and the flag cannot disagree.
    //
    // "Not clean" is not the same as "cannot be attested". A sound entry
    // inside an incomplete document, or one repeating text from an earlier
    // note, is a record a physician can read and sign — after being told what
    // to look at. Only an EXCEPTION holds the queue; a CAUTION shows its panel
    // and waits in the ready pile. A non-blocking finding is likewise a
    // caution, not an obligation.
    const level = attentionLevel(guidance);
    const needsAttention = openFindings.some((f) => f.blocking) || level === "EXCEPTION";

    return {
      id,
      sourceDocumentId: documentId,
      rowIds,
      rows: noteRows,
      encounterDate: dated?.encounterDate ?? null,
      encounterDateEnd: dated?.encounterDateEnd ?? null,
      dateStatus: noteDateStatus,
      openEndedRange: Boolean(dated?.encounterDate && !dated?.encounterDateEnd && (dated as { openEndedRange?: boolean }).openEndedRange),
      provider: noteRows.find((r) => r.provider)?.provider ?? null,
      // Every provider the note names, so a multi-clinician record is not
      // presented as though one person delivered all of it.
      providers,
      providerCredentials: noteRows.find((r) => r.providerCredentials)?.providerCredentials ?? null,
      facility: noteRows.find((r) => r.facility)?.facility ?? null,
      encounterType: noteRows.find((r) => r.encounterType)?.encounterType ?? null,
      pageStart: pages.length ? Math.min(...pages) : null,
      pageEnd: pages.length ? Math.max(...pages) : null,
      claims: noteRows.flatMap((r) => r.claims),
      claimCount: noteRows.reduce((n, r) => n + r.claims.length, 0),
      // One hash per member, copies included — a decision that claims to cover
      // every copy has to carry every copy's displayed content.
      contentHashes: noteRows.map((r) => ({ rowId: r.id, contentHash: r.contentHash })),
      /** Members drawn from another production, for display before deciding. */
      crossDocumentMembers: noteRows
        .filter((r) => r.sourceDocumentId !== documentId)
        .map((r) => ({ id: r.id, sourceDocumentId: r.sourceDocumentId, page: r.page, status: r.status, contentHash: r.contentHash })),
      status,
      auditResult,
      findings: noteFindings,
      copies: noteRows.flatMap((r) => r.copies ?? []),
      reviewedWith: noteRows.find((r) => r.reviewedWith)?.reviewedWith ?? null,
      corroboration,
      fragmentDisagreement: disagreement,
      materialDisagreement: material,
      guidance,
      attention: level,
      needsAttention,
      membershipBasis: group.basis,
      ambiguousAssignment: unresolvedAnchor,
      ambiguousWith: group.ambiguousWith,
      ambiguityClusterId: group.ambiguityClusterId,
      ambiguityAwaitingAnchor: inUnresolvedCluster && !group.ambiguityAnchor,
      // A decision is owed only for a material exception. Everything else is
      // visible, inspectable, and covered by the case-level confirmation.
      requiresDecision: needsAttention,
      coveredByCaseConfirmation:
        !needsAttention && noteRows.every((r) => r.status === "AI_DRAFT" || r.status === "AI_AUDIT_PASSED"),
      // Awaiting attestation means: nothing blocks it, and every row is still
      // a machine draft awaiting the one human decision this note deserves.
      // A note carrying a caution qualifies — reading the caution IS part of
      // the attestation, and holding it back gave the reviewer a queue they
      // could not drain.
      awaitingAttestation: !needsAttention && noteRows.every((r) => r.status === "AI_DRAFT" || r.status === "AI_AUDIT_PASSED"),
    };
  });
}
