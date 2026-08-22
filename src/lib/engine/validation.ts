// ─────────────────────────────────────────────────────────────────────────────
// Validation service — the server-side wrapper around the pure integrity check
// (src/lib/engine/integrity.ts). Loads a case's recommendations and diagnoses,
// runs the deterministic check, and PERSISTS the findings as ValidationFinding
// rows so the review workflow can display them without rebuilding a report.
//
// Findings are derived data: every run REPLACES the case's rows atomically.
// Called after plan (re)generation and on report export; also exposed via
// GET/POST /api/cases/:id/validation for on-demand refresh from the UI.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";
import { checkIndication } from "@/lib/engine/indications";
import {
  runIntegrityCheck,
  type CondInput,
  type RecInput,
  type IntegrityReport,
} from "./integrity";
import { validateEvidenceQuality } from "./citationQuality";
import { buildRecommendationDossier, validateRecommendationCompleteness, type DossierChronoEvent, type DossierCondition } from "./medicalNecessity";
import { compareBasis } from "@/lib/engine/recommendationBasis";
import { isBasisDivergenceFinding, encodeBasisFinding, decodeBasisFinding, reconciliationCovers, reconcilable, statusForFinding, snapshotOf, snapshotDifferences, type BasisSnapshot } from "@/lib/engine/basisReconciliation";
import { loadRecordedBases, unreadableBasisFinding, type BasisStore } from "@/lib/engine/basisStore";
import { assembleBasis } from "@/lib/engine/basisAssembly";
import { CHRONOLOGY_OUTPUT_WHERE } from "@/lib/records/encounterLifecycle";
import { resolveRecommendationCondition } from "@/lib/engine/recommendationCondition";
import { assumptionsFor } from "@/lib/engine/generate";
import { reasoningFindings, type ReasoningItem } from "./clinicalReasoning";
import { baselineLifeExpectancy, lifeExpectancyFindings, parseBasis, type BasisSex } from "./lifeExpectancy";
import type { CondInput as ReasoningCond } from "./integrity";

export interface CaseValidation {
  findings: {
    service: string;
    result: string;
    issue: string;
    severity: string;
    suggestion: string;
    exportBlocking: boolean;
  }[];
  blocking: boolean;
  counts: IntegrityReport["counts"];
}

/** Run the integrity check over a case's current data (no persistence). */
export async function validateCase(caseId: string): Promise<CaseValidation> {
  const [items, conditions, kase, chronology, interviews] = await Promise.all([
    prisma.futureCareItem.findMany({ where: { caseId, supersededAt: null }, include: { condition: true } }),
    prisma.condition.findMany({ where: { caseId } }),
    prisma.case.findUnique({
      where: { id: caseId },
      // The projection assumptions are part of the basis now, so validation
      // needs the same inputs the generator used to compute them.
      select: { id: true, dateOfBirth: true, sex: true, lifeExpectancyYears: true, lifeExpectancyBasis: true, specialty: true, additionalSpecialties: true, discountRate: true, medicalInflation: true, geographicFactor: true },
    }),
    // THE SAME chronology the generator recorded the basis from: OUTPUT rows
    // only, in a deterministic order. This read every row — superseded and
    // stale included — in whatever order the database returned, so validation
    // derived a different dossier than the one on file and reported all 34
    // items BASIS_STALE the instant they were generated. A checker must derive
    // independently; it must not derive from a different record.
    prisma.chronologyEvent.findMany({ where: { caseId, ...CHRONOLOGY_OUTPUT_WHERE }, orderBy: [{ eventDate: "asc" }, { id: "asc" }] }),
    prisma.interviewFinding.findMany({ where: { caseId } }).catch(() => []),
  ]);
  const adult = !kase?.dateOfBirth || (Date.now() - kase.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000) >= 18;
  // The narrative differs with the subject's name, and the narrative is not
  // hashed — but the life expectancy drives lifetime quantities, so a
  // hard-coded 40 would derive a different dossier from the recorded one.
  const dossierCase = { subject: "the patient", pronounPoss: "the patient's", lifeExpectancyYears: kase?.lifeExpectancyYears ?? 40, adult };
  const report = runIntegrityCheck({
    recommendations: items as unknown as RecInput[],
    conditions: conditions as unknown as CondInput[],
  });
  // Clinical Evidence Sprint — validate the stored citations themselves:
  // incompatible citations, weak primaries, cross-region article reuse.
  const evidenceFindings = validateEvidenceQuality(items as never, adult);
  // Refactor Sprint — each recommendation must be complete (supporting
  // diagnosis, objective evidence, medical-necessity rationale).
  // Validation DERIVES independently — that is its job. A checker that read the
  // recorded basis could never notice the basis had drifted from the record.
  //
  // What was missing is that nobody was told when the two disagreed. Each item
  // now also yields a BASIS_MISSING or BASIS_STALE finding, and because those
  // are export-blocking, the existing lifecycle gate does the rest: draft
  // export continues with the disclosure and the unresolved-issues appendix,
  // final expert export is refused until the plan is regenerated or the finding
  // is explicitly resolved.
  const caseAssumptions = kase ? assumptionsFor(kase as never) : { lifeExpectancyYears: 40, discountRate: 0, medicalInflation: 0, geographicFactor: 1 };

  // An unreadable store is not an empty one. This loaded the bases with
  // `.catch(() => [])`, so a failed read produced zero bases and the loop below
  // emitted BASIS_MISSING for every item on the case — a statement about the
  // record, made by code that never managed to read the record.
  const basisLoad = await loadRecordedBases(prisma as unknown as BasisStore, caseId);
  const recordedBases = basisLoad.readable
    ? (basisLoad.byItem as Map<string, { basisHash?: string | null }>)
    : new Map<string, { basisHash?: string | null }>();
  const basisFindings: { service: string; result: string; issue: string; severity: string; suggestion: string; exportBlocking: boolean }[] = [];
  if (!basisLoad.readable) basisFindings.push(unreadableBasisFinding(basisLoad.reason));

  const completenessFindings = items.flatMap((it) => {
    // The CANONICAL resolver, not the raw stored link. `it.condition` is the
    // persisted conditionId, which the resolver may legitimately remap by
    // anatomy — so for 8 items on the reference case validation was deriving a
    // dossier about a different diagnosis than the basis was recorded from, and
    // reporting the difference as staleness. This is the same defect that had
    // the panel and the evidence ledger arguing about a cervical versus a
    // lumbar diagnosis; validation was the last caller still reading the link.
    const cond = resolveRecommendationCondition(it as never, conditions as never).condition as DossierCondition | null;
    const dossier = buildRecommendationDossier(it as never, cond, chronology as unknown as DossierChronoEvent[], dossierCase, interviews as never);
    const id = (it as { id: string }).id;
    const service = (it as { service: string }).service;
    // The SAME assumptions the generator recorded from — otherwise the witness
    // differs on the projection inputs alone and every item reads stale.
    // Only when the store was readable. Comparing against a map we know is
    // empty-because-broken would manufacture a divergence per item.
    const check = !basisLoad.readable ? null : compareBasis(
      recordedBases.get(id) ?? null,
      assembleBasis({
        item: it as never,
        dossier,
        conditions: conditions as never,
        chronology: chronology as unknown as DossierChronoEvent[],
        kase: dossierCase,
        interviews: interviews as never,
        assumptions: { ...caseAssumptions, pricedAt: (it as { pricedAt?: Date | null }).pricedAt?.toISOString() ?? null, conditionName: cond?.name ?? null },
      }),
    );
    if (check && check.state !== "CURRENT") {
      basisFindings.push({
        service,
        // The divergence's OWN identity, in the result code.
        //
        // Disposition is carried across re-runs on `${service}::${result}`, and
        // the issue text for these findings is fixed — so a reviewer who
        // resolved one divergence silently resolved every later one on the same
        // item, and `openBlockingCount` stopped counting it. Embedding the hash
        // pair means a different divergence is a different finding, and reopens
        // as OPEN.
        // Immutable item id + BOTH full hashes. Twelve trailing hex characters
        // is not a hash, and recovering the item by service name collided
        // whenever a case carried two recommendations of the same service.
        result: encodeBasisFinding({
          state: check.state === "MISSING" ? "MISSING" : "STALE",
          futureCareItemId: id,
          recordedHash: check.storedHash ?? null,
          derivedHash: check.derivedHash,
        }),
        issue:
          check.state === "MISSING"
            ? "No recommendation basis has been recorded for this item, so the exported report has nothing authoritative to render from."
            : "The recorded basis for this item no longer matches the current record. The plan and the report would state different things.",
        severity: "Critical",
        suggestion:
          "Regenerate the plan to record a current basis. Resolving this finding closes only THIS divergence — a later, different divergence raises a new finding with its own hash pair.",
        // Draft export continues and says so; final expert export is refused.
        exportBlocking: true,
      });
    }
    return validateRecommendationCompleteness(it as never, dossier, !!cond);
  });
  // Clinical Reasoning Engine (Phase D) — reasoning-derived gating: double-count
  // detection (blocking) plus advisory frequency/support flags on totaled lines.
  const includedIds = new Set(items.filter((it) => report.perItem.get(it as unknown as RecInput)?.includedInTotal).map((it) => (it as { id: string }).id));
  const reasoning = reasoningFindings(
    items as unknown as ReasoningItem[],
    conditions as unknown as (ReasoningCond & { id: string })[],
    chronology as unknown as DossierChronoEvent[],
    dossierCase,
    includedIds,
  );
  // Life-expectancy basis — the projection horizon every totaled lifetime line
  // multiplies through must have a recorded, internally consistent basis
  // (actuarial baseline, documented adjustments, or physician determination).
  const ageYears = kase?.dateOfBirth ? (Date.now() - kase.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000) : null;
  const currentBaseline = ageYears != null ? baselineLifeExpectancy(ageYears, (kase?.sex ?? "UNKNOWN") as BasisSex) : null;
  const lifetimeIncluded = items.filter(
    (it) => includedIds.has((it as { id: string }).id) && (it as { isLifetime?: boolean }).isLifetime,
  );
  const leFindings = lifeExpectancyFindings({
    basis: parseBasis(kase?.lifeExpectancyBasis),
    yearsInUse: kase?.lifeExpectancyYears ?? currentBaseline?.years ?? 40,
    currentBaseline,
    lifetimePresentValue: lifetimeIncluded.reduce((s, it) => s + ((it as { presentValue?: number }).presentValue ?? 0), 0),
    lifetimeItemCount: lifetimeIncluded.length,
  });
  // Indication checklists — the record must document each service's clinical
  // prerequisite. Unmet checklists are advisory findings, never silent drops.
  const evidenceQuotes = conditions
    .flatMap((c) => (Array.isArray((c as { evidenceSources?: unknown }).evidenceSources) ? ((c as { evidenceSources?: unknown }).evidenceSources as { quote?: string }[]) : []))
    .map((e) => e.quote ?? "");
  const corpus = [
    ...conditions.map((c) => (c as { name?: string; diagnosis?: string }).name ?? (c as { diagnosis?: string }).diagnosis ?? ""),
    ...evidenceQuotes,
    ...chronology.map((e) => (e as { description?: string | null }).description ?? ""),
  ].join(" \n ");
  const indicationFindings = items.flatMap((it) => {
    const r = checkIndication((it as { service: string }).service, corpus);
    if (!r || r.met) return [];
    return [{
      service: (it as { service: string }).service,
      result: "Indication checklist",
      issue: `The record does not document the clinical prerequisite for this service: ${r.requirement}.`,
      severity: "Moderate",
      suggestion: "Document the indication in the record, attach supporting evidence, or have the physician confirm/reject the item.",
      exportBlocking: false,
    }];
  });
  // Claim-level re-verification — every stored evidence quote must still exist
  // verbatim in its source document's extracted text (guards against stale or
  // drifted citations surviving re-ingestion).
  const docTexts = new Map(
    (await prisma.document.findMany({ where: { caseId }, select: { id: true, extractedText: true } })).map((d) => [d.id, d.extractedText ?? ""]),
  );
  const claimFindings = conditions.flatMap((c) => {
    const sources = Array.isArray((c as { evidenceSources?: unknown }).evidenceSources)
      ? ((c as { evidenceSources?: unknown }).evidenceSources as { documentId?: string; filename?: string; quote?: string }[])
      : [];
    return sources.flatMap((src) => {
      if (!src.quote || !src.documentId) return [];
      const text = docTexts.get(src.documentId);
      if (text == null) return [];
      const normalize = (x: string) => x.replace(/\s+/g, " ").trim();
      if (normalize(text).includes(normalize(src.quote).replace(/…$/, ""))) return [];
      return [{
        service: (c as { name?: string }).name ?? "condition evidence",
        result: "Evidence citation drift",
        issue: `A stored evidence quote no longer appears in its source document (${src.filename ?? src.documentId}): "${src.quote.slice(0, 80)}".`,
        severity: "High",
        suggestion: "Re-run evidence location for this condition; the source document changed since the quote was captured.",
        exportBlocking: false,
      }];
    });
  });
  // Specialty alignment — every recommendation's specialty should be one the
  // case requested at intake (Specialty for Review). A different recommended
  // specialty is surfaced as an advisory, never silently kept or dropped.
  const requestedSpecialties = [
    kase?.specialty,
    ...(Array.isArray(kase?.additionalSpecialties) ? (kase!.additionalSpecialties as string[]) : []),
  ].filter((x): x is string => !!x);
  // Word-token subset match (singular/plural-insensitive) — raw substring
  // matching false-positives on pairs like Urology / Neurology.
  const specTokens = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean).map((w) => w.replace(/s$/, ""));
  const specialtyMatchesRequested = (have: string) =>
    requestedSpecialties.some((want) => {
      const ht = specTokens(have);
      const wt = specTokens(want);
      if (!ht.length || !wt.length) return false;
      return ht.every((w) => wt.includes(w)) || wt.every((w) => ht.includes(w));
    });
  const specialtyFindings: { service: string; result: string; issue: string; severity: string; suggestion: string; exportBlocking: boolean }[] = [];
  if (requestedSpecialties.length) {
    const unmatched = new Map<string, string[]>();
    for (const it of items as { specialty?: string | null; service: string }[]) {
      const spec = (it.specialty ?? "").trim();
      if (!spec || specialtyMatchesRequested(spec)) continue;
      unmatched.set(spec, [...(unmatched.get(spec) ?? []), it.service]);
    }
    for (const [spec, services] of unmatched) {
      specialtyFindings.push({
        service: services.length > 3 ? `${services.slice(0, 3).join(", ")} +${services.length - 3} more` : services.join(", "),
        result: "Specialty not requested at intake",
        issue: `${services.length} recommendation${services.length === 1 ? "" : "s"} carr${services.length === 1 ? "ies" : "y"} the ${spec} specialty, which is not among the specialties selected for review on the Intake page.`,
        severity: "Moderate",
        suggestion: `Add ${spec} to Specialty for Review on the Intake page, or have the clinical team reassign the item's specialty.`,
        exportBlocking: false,
      });
    }
  }

  const findings = [
    // Basis divergence first: it says the plan and the report would disagree,
    // which conditions how every other finding should be read.
    ...basisFindings,
    ...specialtyFindings,
    ...indicationFindings,
    ...claimFindings,
    ...report.findings.map((f) => ({
      service: f.recommendation,
      result: f.result,
      issue: f.issue,
      severity: f.severity,
      suggestion: f.suggestedCorrection,
      exportBlocking: f.exportBlocking,
    })),
    ...evidenceFindings.map((f) => ({
      service: f.recommendation,
      result: f.result,
      issue: f.issue,
      severity: f.severity as string,
      suggestion: f.suggestedCorrection,
      exportBlocking: f.exportBlocking,
    })),
    ...completenessFindings.map((f) => ({
      service: f.recommendation,
      result: f.result,
      issue: f.issue,
      severity: f.severity as string,
      suggestion: f.suggestedCorrection,
      exportBlocking: f.exportBlocking,
    })),
    ...reasoning.map((f) => ({
      service: f.service,
      result: f.result,
      issue: f.issue,
      severity: f.severity as string,
      suggestion: f.suggestion,
      exportBlocking: f.exportBlocking,
    })),
    ...leFindings.map((f) => ({
      service: f.service,
      result: f.result,
      issue: f.issue,
      severity: f.severity as string,
      suggestion: f.suggestion,
      exportBlocking: f.exportBlocking,
    })),
  ];
  return {
    findings,
    blocking: findings.some((f) => f.exportBlocking),
    counts: report.counts,
  };
}

/**
 * Validate and persist: atomically replace the case's ValidationFinding rows
 * with the current results. Returns the validation so callers can respond
 * without a second query.
 */
export async function persistCaseValidation(caseId: string, firmId: string): Promise<CaseValidation> {
  const v = await validateCase(caseId);
  // User dispositions (resolved-as-is / ignored) survive re-runs: a regenerated
  // finding with the same (service, result) inherits the prior disposition. If
  // the data changed enough to alter the finding text/key, it reopens as OPEN.
  const prior = await prisma.validationFinding.findMany({
    where: { caseId, status: { not: "OPEN" } },
    select: { service: true, result: true, status: true, resolvedById: true, resolvedAt: true },
  });
  const dispositionByKey = new Map(prior.map((f) => [`${f.service}::${f.result}`, f]));

  // A basis divergence's status DERIVES from the reconciliation record, every
  // time validation runs. It is not a disposition carried forward on a string
  // key: carrying it meant the export gate, the report's draft banner and the
  // independent divergence check could each be reading a different answer. One
  // source of truth, consulted here, and every gate downstream agrees with it.
  const reconciliations = await prisma.basisReconciliation.findMany({ where: { caseId } });

  await prisma.$transaction([
    prisma.validationFinding.deleteMany({ where: { caseId } }),
    ...(v.findings.length
      ? [prisma.validationFinding.createMany({
          data: v.findings.map((f) => {
            const carried = dispositionByKey.get(`${f.service}::${f.result}`);
            return { ...f, caseId, firmId, ...statusForFinding(f.result, reconciliations as never, carried as never) };
          }),
        })]
      : []),
  ]);
  return v;
}

/** Count of findings that still gate a final export: blocking AND undispositioned. */
export async function openBlockingCount(caseId: string): Promise<number> {
  return prisma.validationFinding.count({ where: { caseId, exportBlocking: true, status: "OPEN" } });
}

export interface BasisDivergence {
  futureCareItemId: string;
  service: string;
  state: "STALE" | "MISSING";
  recordedHash: string | null;
  derivedHash: string;
  /** A credentialed physician has reconciled exactly this divergence. */
  reconciled: boolean;
  /** MISSING is never reconcilable — see `reconcilable` for why. */
  reconcilable: boolean;
  /** The exact finding result code, so a caller can close THAT finding. */
  findingResult: string;
  /**
   * The two readings, in clinical terms. A reviewer cannot judge whether the
   * current record still supports what was recorded by comparing hex strings —
   * asking them to sign one is asking for a signature, not an opinion.
   * Populated only by `basisDivergencesDetailed`; the cheap path leaves them
   * null so callers that only need blocking counts pay nothing for them.
   */
  recorded: BasisSnapshot | null;
  current: BasisSnapshot | null;
  differences: { field: string; recorded: string; current: string }[];
}

/**
 * Which recommendations disagree with their recorded basis, RIGHT NOW.
 *
 * Deliberately independent of ValidationFinding and of every disposition on
 * it. The finding table is a projection with a user-editable status column,
 * and the final-export gate reads only OPEN rows — so dispositioning a
 * BASIS_STALE finding released a report whose record still disagreed with it.
 * This re-derives and compares, and answers to nothing but the data.
 *
 * A divergence counts as reconciled only when a credentialed physician
 * reconciled THIS hash pair. A reconciliation of an earlier divergence does
 * not carry forward: the record moved again, which is a new fact.
 */
export async function basisDivergences(caseId: string): Promise<BasisDivergence[]> {
  const v = await validateCase(caseId);
  const raw = v.findings.filter((f) => isBasisDivergenceFinding(f.result));
  if (!raw.length) return [];

  const reconciliations = await prisma.basisReconciliation.findMany({ where: { caseId } });

  const out: BasisDivergence[] = [];
  for (const f of raw) {
    const id = decodeBasisFinding(f.result);
    if (!id) {
      // A legacy short-tail code. It cannot be matched to a reconciliation with
      // any confidence, so it counts as unreconciled — the safe direction.
      out.push({ futureCareItemId: "", service: f.service, state: "STALE", recordedHash: null, derivedHash: "", reconciled: false, reconcilable: false, findingResult: f.result, recorded: null, current: null, differences: [] });
      continue;
    }
    out.push({
      futureCareItemId: id.futureCareItemId,
      service: f.service,
      state: id.state,
      recordedHash: id.recordedHash,
      derivedHash: id.derivedHash,
      // Exact: item identity AND both full hashes.
      reconciled: reconciliations.some((r) => reconciliationCovers(r, id)),
      reconcilable: reconcilable(id.state).ok,
      findingResult: f.result,
      recorded: null,
      current: null,
      differences: [],
    });
  }
  return out;
}

/**
 * Divergences WITH both readings, for a reviewer who has to decide.
 *
 * Separate from `basisDivergences` because building the witness for every item
 * is real work, and the gates that only need to know whether anything is
 * unreconciled must not pay for it.
 */
export async function basisDivergencesDetailed(caseId: string): Promise<BasisDivergence[]> {
  const rows = await basisDivergences(caseId);
  if (!rows.length) return rows;

  const recordedBases = await prisma.recommendationBasis.findMany({ where: { caseId } });
  const byItem = new Map(recordedBases.map((b) => [b.futureCareItemId, b as unknown as Parameters<typeof snapshotOf>[0]]));

  // The witness, derived the same way generation and validation derive it.
  // The same inputs validateCase derives from, loaded the same way: the OUTPUT
  // chronology in a deterministic order, and the case's own assumptions.
  // Anything else and the witness would differ from the one that raised the
  // finding in the first place.
  const [items, conditions, kase, chronology, interviews] = await Promise.all([
    prisma.futureCareItem.findMany({ where: { caseId, supersededAt: null }, include: { condition: true } }),
    prisma.condition.findMany({ where: { caseId } }),
    prisma.case.findUnique({
      where: { id: caseId },
      select: { id: true, dateOfBirth: true, sex: true, lifeExpectancyYears: true, lifeExpectancyBasis: true, specialty: true, additionalSpecialties: true, discountRate: true, medicalInflation: true, geographicFactor: true },
    }),
    prisma.chronologyEvent.findMany({ where: { caseId, ...CHRONOLOGY_OUTPUT_WHERE }, orderBy: [{ eventDate: "asc" }, { id: "asc" }] }),
    prisma.interviewFinding.findMany({ where: { caseId } }).catch(() => []),
  ]);
  const adult = !kase?.dateOfBirth || (Date.now() - kase.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000) >= 18;
  const dossierCase = { subject: "the patient", pronounPoss: "the patient's", lifeExpectancyYears: kase?.lifeExpectancyYears ?? 40, adult };
  const caseAssumptions = kase ? assumptionsFor(kase as never) : { lifeExpectancyYears: 40, discountRate: 0, medicalInflation: 0, geographicFactor: 1 };

  return rows.map((d) => {
    const it = items.find((x: { id: string }) => x.id === d.futureCareItemId);
    if (!it) return d;
    const cond = resolveRecommendationCondition(it as never, conditions as never).condition as DossierCondition | null;
    const dossier = buildRecommendationDossier(it as never, cond, chronology as unknown as DossierChronoEvent[], dossierCase, interviews as never);
    const witness = assembleBasis({
      item: it as never,
      dossier,
      conditions: conditions as never,
      chronology: chronology as unknown as DossierChronoEvent[],
      kase: dossierCase,
      interviews: interviews as never,
      assumptions: { ...caseAssumptions, pricedAt: (it as { pricedAt?: Date | null }).pricedAt?.toISOString() ?? null, conditionName: cond?.name ?? null },
    });
    const recorded = snapshotOf(byItem.get(d.futureCareItemId));
    const current = snapshotOf(witness as unknown as Parameters<typeof snapshotOf>[0]);
    return { ...d, recorded, current, differences: snapshotDifferences(recorded, current) };
  });
}

/**
 * Divergences that must stop a final export.
 *
 * Fail-closed by construction: anything not explicitly reconciled blocks,
 * whatever the finding table says.
 */
export async function unreconciledBasisDivergences(caseId: string): Promise<BasisDivergence[]> {
  return (await basisDivergences(caseId)).filter((d) => !d.reconciled);
}
