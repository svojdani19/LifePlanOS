import { prisma } from "@/lib/db";
import { validateCase, type CaseValidation } from "@/lib/engine/validation";
import type { IntegrityReport } from "@/lib/engine/integrity";

// ─────────────────────────────────────────────────────────────────────────────
// Case Review Assistant — attention projection + lifecycle.
//
// The assistant does NOT run a second validation engine. It PROJECTS the
// deterministic findings already produced by validateCase() (integrity /
// consistency / evidence-quality / completeness) plus the physician-review
// status into lifecycle-tracked AttentionItems, deduplicated by a stable
// fingerprint so re-projection UPDATES the same item (preserving triage) rather
// than duplicating. Findings that no longer exist are SUPERSEDED; resolved /
// dismissed items stay in history and are never silently re-opened.
//
// Pure functions (projectAttention / reconcileAttention / caseReadiness) hold the
// logic and are unit-tested directly; the async wrappers persist + audit.
// ─────────────────────────────────────────────────────────────────────────────

export type AttentionSeverity = "CRITICAL" | "HIGH" | "MODERATE" | "LOW" | "INFORMATIONAL";
export type AttentionStatus = "OPEN" | "IN_REVIEW" | "DEFERRED" | "RESOLVED" | "DISMISSED" | "SUPERSEDED";
const ACTIVE: AttentionStatus[] = ["OPEN", "IN_REVIEW", "DEFERRED"];

export interface AttentionDraft {
  validationRuleId: string; // stable fingerprint (dedup key)
  category: string;
  severity: AttentionSeverity;
  title: string;
  summary: string;
  whyItMatters: string;
  suggestedAction: string;
  entityType: string | null;
  entityId: string | null;
  sourceDocumentId: string | null;
  sourcePage: number | null;
  exportBlocking: boolean;
}

const SEV: Record<string, AttentionSeverity> = { Critical: "CRITICAL", High: "HIGH", Moderate: "MODERATE", Low: "LOW" };
export const SEVERITY_RANK: Record<AttentionSeverity, number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3, INFORMATIONAL: 4 };

// The order attention items are worked in mirrors the AI pipeline — resolve
// upstream (diagnosis, evidence) before downstream (literature, consistency,
// costs, review) so fixing a cause clears its effects. Each item carries the
// stage label for the focus-flow UI.
const PIPELINE: { label: string; cats: string[] }[] = [
  { label: "Records & intake", cats: ["missing_records", "incomplete_info"] },
  { label: "Diagnosis", cats: ["diagnosis_mismatch"] },
  { label: "Objective evidence", cats: ["missing_evidence"] },
  { label: "Recommendations", cats: ["unsupported_recommendation"] },
  { label: "Literature", cats: ["literature"] },
  { label: "Consistency", cats: ["recommendation_conflict", "staged_care"] },
  { label: "Costs & coding", cats: ["cpt_mismatch", "pricing_mismatch", "duplicate_cost"] },
  { label: "Physician review", cats: ["physician_review_pending"] },
  { label: "Export readiness", cats: ["other"] },
];
export function pipelineRank(category: string): number {
  const i = PIPELINE.findIndex((s) => s.cats.includes(category));
  return i === -1 ? PIPELINE.length : i;
}
export function stageLabel(category: string): string {
  return PIPELINE[pipelineRank(category)]?.label ?? "Review";
}

const fingerprint = (service: string, result: string) => `${service}::${result}`.toLowerCase().replace(/\s+/g, " ").trim();

// Map a finding's `result` to an assistant category + why-it-matters. Unknown
// results fall through to a safe generic category — never dropped.
function categorize(result: string): { category: string; why: string } {
  const r = result.toLowerCase();
  if (/diagnosis mismatch|no supporting diagnosis/.test(r)) return { category: "diagnosis_mismatch", why: "A recommendation not tied to a documented diagnosis in the right body region is easily challenged as misattributed." };
  if (/code mismatch|missing code|requires review/.test(r)) return { category: "cpt_mismatch", why: "An incorrect or missing CPT/HCPCS code undermines the cost basis for the service." };
  if (/pricing mismatch|bundled estimate/.test(r)) return { category: "pricing_mismatch", why: "A price not tied to the correct code/modality can be excluded by an opposing economist." };
  if (/mutually exclusive/.test(r)) return { category: "recommendation_conflict", why: "Two recommendations that cannot both occur are both in the total — the damages figure is internally inconsistent." };
  if (/duplicate|overlapping/.test(r)) return { category: "duplicate_cost", why: "The same care is counted twice, inflating the total." };
  if (/lacks a documented trigger|missing timing|conditional/.test(r)) return { category: "staged_care", why: "A staged/contingent item without a documented trigger or timing can be treated as concurrent and double-counted." };
  if (/irrelevant literature|citation|literature/.test(r)) return { category: "literature", why: "A citation that does not match the diagnosis, procedure, region, or population weakens the evidentiary basis." };
  if (/no objective evidence|objective/.test(r)) return { category: "missing_evidence", why: "Objective evidence is thin for this recommendation on the present record." };
  if (/unsupported item in totals|insufficient support/.test(r)) return { category: "unsupported_recommendation", why: "An item is included in the total without adequate record support or physician approval." };
  return { category: "other", why: "This finding affects the completeness or defensibility of the plan." };
}

export interface ProjectItem { id?: string | null; service: string; physicianStatus?: string | null }

/** Project the deterministic validation results (+ physician-review status) into
 *  attention drafts. One draft per finding; plus a draft per recommendation still
 *  awaiting physician review. Pure. */
export function projectAttention(validation: CaseValidation, items: ProjectItem[]): AttentionDraft[] {
  const drafts: AttentionDraft[] = [];
  for (const f of validation.findings) {
    const { category, why } = categorize(f.result);
    const item = items.find((i) => i.service === f.service);
    drafts.push({
      validationRuleId: fingerprint(f.service, f.result),
      category,
      severity: SEV[f.severity] ?? "MODERATE",
      title: f.result,
      summary: f.issue,
      whyItMatters: why,
      suggestedAction: f.suggestion,
      entityType: "recommendation",
      entityId: item?.id ?? f.service,
      sourceDocumentId: null,
      sourcePage: null,
      exportBlocking: f.exportBlocking,
    });
  }
  // Physician-review-pending is a structured signal (not a validation finding);
  // surfaced as ONE aggregate item with the count, not one row per recommendation.
  const pending = items.filter((it) => (it.physicianStatus ?? "PENDING") === "PENDING");
  if (pending.length) {
    const names = pending.slice(0, 6).map((p) => `“${p.service}”`).join(", ");
    drafts.push({
      validationRuleId: "case::physician_review_pending",
      category: "physician_review_pending",
      severity: "MODERATE",
      title: `${pending.length} recommendation${pending.length === 1 ? "" : "s"} awaiting physician review`,
      summary: `${names}${pending.length > 6 ? `, and ${pending.length - 6} more` : ""}.`,
      whyItMatters: "A recommendation carries substantially more weight at deposition once a physician has reviewed and endorsed it.",
      suggestedAction: "Route the plan to the reviewing physician for approval.",
      entityType: "report",
      entityId: null,
      sourceDocumentId: null,
      sourcePage: null,
      exportBlocking: false,
    });
  }
  // De-duplicate identical fingerprints within one projection (keep the first).
  const seen = new Set<string>();
  return drafts.filter((d) => (seen.has(d.validationRuleId) ? false : (seen.add(d.validationRuleId), true)));
}

export interface ExistingAttention { id: string; validationRuleId: string; status: AttentionStatus }
export interface ReconcilePlan {
  create: AttentionDraft[];
  update: { id: string; draft: AttentionDraft }[];
  supersede: string[]; // ids to mark SUPERSEDED (the underlying issue is gone)
}

/** Reconcile a fresh projection against existing items: update still-active items
 *  in place (preserving status/assignee/resolution), supersede active items whose
 *  issue disappeared, respect resolved/dismissed history (never re-create), and
 *  create genuinely new items. Pure. */
export function reconcileAttention(existing: ExistingAttention[], drafts: AttentionDraft[]): ReconcilePlan {
  const draftByFp = new Map(drafts.map((d) => [d.validationRuleId, d]));
  const handled = new Set<string>();
  const create: AttentionDraft[] = [];
  const update: { id: string; draft: AttentionDraft }[] = [];
  const supersede: string[] = [];
  for (const e of existing) {
    if (ACTIVE.includes(e.status)) {
      const d = draftByFp.get(e.validationRuleId);
      if (d) { update.push({ id: e.id, draft: d }); handled.add(e.validationRuleId); }
      else supersede.push(e.id); // issue no longer present → supersede
    } else if (e.status === "RESOLVED" || e.status === "DISMISSED") {
      handled.add(e.validationRuleId); // respect the user's resolution; keep in history
    }
    // SUPERSEDED existing rows are inert history.
  }
  for (const d of drafts) if (!handled.has(d.validationRuleId)) create.push(d);
  return { create, update, supersede };
}

export interface ReadinessStage {
  stage: "physician_review" | "attorney_review" | "draft_export" | "final_export";
  label: string;
  ready: boolean;
  satisfied: string[];
  outstanding: string[];
  blocking: string[];
  nextActions: string[];
}

/** Multi-factor readiness (never a single opaque score): each stage lists what is
 *  satisfied, outstanding, blocking, and the next actions — derived from the
 *  active attention items and the validation counts. Pure. */
export function caseReadiness(
  active: { severity: AttentionSeverity; category: string; exportBlocking: boolean; title: string }[],
  counts: IntegrityReport["counts"],
): ReadinessStage[] {
  const critical = active.filter((a) => a.severity === "CRITICAL" || a.exportBlocking);
  const high = active.filter((a) => a.severity === "HIGH");
  const pendingReview = active.filter((a) => a.category === "physician_review_pending");
  const criticalTitles = [...new Set(critical.map((c) => c.title))];
  const hasRecommendations = counts.proposed > 0;

  const physician: ReadinessStage = {
    stage: "physician_review", label: "Ready for physician review",
    ready: hasRecommendations && critical.filter((c) => /diagnosis|code|pricing/i.test(c.title)).length === 0,
    satisfied: [hasRecommendations ? `${counts.proposed} recommendations drafted` : ""].filter(Boolean),
    outstanding: [],
    blocking: criticalTitles.filter((t) => /diagnosis|code|pricing/i.test(t)),
    nextActions: hasRecommendations ? ["Send the plan to the reviewing physician"] : ["Generate the future-care plan first"],
  };
  const attorney: ReadinessStage = {
    stage: "attorney_review", label: "Ready for attorney review",
    ready: physician.ready && high.length === 0,
    satisfied: [counts.physicianApproved ? `${counts.physicianApproved} recommendations physician-approved` : ""].filter(Boolean),
    outstanding: [pendingReview.length ? `${pendingReview.length} recommendations awaiting physician review` : "", high.length ? `${high.length} high-priority items` : ""].filter(Boolean),
    blocking: criticalTitles,
    nextActions: high.length ? ["Resolve the high-priority attention items"] : pendingReview.length ? ["Complete physician review"] : ["Proceed to attorney review"],
  };
  const draft: ReadinessStage = {
    stage: "draft_export", label: "Ready for draft export",
    ready: hasRecommendations, // draft is always available (with a watermark) once a plan exists
    satisfied: hasRecommendations ? ["A plan exists; draft export is available with a DRAFT watermark and an unresolved-issues appendix"] : [],
    outstanding: [], blocking: [],
    nextActions: ["Export draft (watermarked)"],
  };
  const final: ReadinessStage = {
    stage: "final_export", label: "Ready for final export",
    ready: hasRecommendations && critical.length === 0,
    satisfied: [critical.length === 0 ? "No export-blocking findings" : "", `${counts.included} recommendations included in totals`].filter(Boolean),
    outstanding: high.length ? [`${high.length} high-priority items (non-blocking)`] : [],
    blocking: criticalTitles,
    nextActions: critical.length ? [`Resolve ${critical.length} critical/blocking item${critical.length === 1 ? "" : "s"} before final export`] : ["Export final report"],
  };
  return [physician, attorney, draft, final];
}

// ── Grounded question answering (deterministic; LLM optional) ────────────────
// Answers case-specific review questions ONLY from the structured attention data
// + validation counts — it never invents facts, never claims physician approval
// that isn't recorded, and marks suggestions distinctly from facts. An LLM layer
// (behind the credentialed seam) could rephrase these; the grounding is here.

export interface AnswerItem {
  severity: AttentionSeverity;
  category: string;
  title: string;
  summary: string;
  suggestedAction: string;
  exportBlocking: boolean;
  entityType: string | null;
  entityId: string | null;
}
export interface CaseAnswer {
  answer: string;
  /** the case entities this answer is grounded in (for a direct link) */
  basis: { label: string; entityType: string | null; entityId: string | null }[];
  disclaimer: string;
}

const DISCLAIMER = "This is a review aid grounded in the current case findings. It does not approve recommendations, costs, or physician opinions, and reports only what the record and validation results show.";
const listTitles = (items: AnswerItem[], n = 8) => items.slice(0, n).map((i) => `• ${i.title}${i.entityType === "recommendation" && i.entityId ? ` (${i.entityId})` : ""}`).join("\n");
const basisOf = (items: AnswerItem[], n = 8) => items.slice(0, n).map((i) => ({ label: i.title, entityType: i.entityType, entityId: i.entityId }));

export function answerCaseQuestion(question: string, data: { active: AnswerItem[]; readiness: ReadinessStage[]; counts: IntegrityReport["counts"] }): CaseAnswer {
  const q = question.toLowerCase();
  const a = data.active;
  const pick = (pred: (i: AnswerItem) => boolean) => a.filter(pred).sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]);
  const ans = (answer: string, items: AnswerItem[]): CaseAnswer => ({ answer, basis: basisOf(items), disclaimer: DISCLAIMER });

  if (/final|finaliz|prevent|block|export/.test(q)) {
    const crit = pick((i) => i.severity === "CRITICAL" || i.exportBlocking);
    return ans(crit.length ? `${crit.length} critical/export-blocking item${crit.length === 1 ? "" : "s"} must be resolved before final export:\n${listTitles(crit)}` : "No export-blocking findings remain — the case is clear for final export on the validation side (physician approval and attorney sign-off are separate).", crit);
  }
  if (/weak|weakest|thin|worst/.test(q)) {
    const weak = pick((i) => ["missing_evidence", "unsupported_recommendation", "literature", "diagnosis_mismatch"].includes(i.category));
    return ans(weak.length ? `The recommendations with the thinnest support are:\n${listTitles(weak)}` : "No recommendations were flagged for weak support.", weak);
  }
  if (/physician|approv|sign-?off|endors/.test(q)) {
    const pend = a.filter((i) => i.category === "physician_review_pending");
    return ans(pend.length ? `${pend[0].title}. ${pend[0].summary} No physician-approval event is recorded for these.` : `No recommendations are awaiting physician review; ${data.counts.physicianApproved} are physician-approved.`, pend);
  }
  if (/cost|duplicate|double|overlap/.test(q)) {
    const dup = pick((i) => i.category === "duplicate_cost" || i.category === "pricing_mismatch");
    return ans(dup.length ? `${dup.length} cost issue${dup.length === 1 ? "" : "s"} (duplication/overlap or pricing basis):\n${listTitles(dup)}` : "No duplicated or overlapping costs were detected.", dup);
  }
  if (/citation|literature|article|evidence relev/.test(q)) {
    const lit = pick((i) => i.category === "literature");
    return ans(lit.length ? `${lit.length} literature issue${lit.length === 1 ? "" : "s"}:\n${listTitles(lit)}` : "No irrelevant or weak citations were flagged.", lit);
  }
  if (/missing|evidence gap|objective/.test(q)) {
    const gap = pick((i) => i.category === "missing_evidence" || i.category === "diagnosis_mismatch");
    return ans(gap.length ? `Evidence gaps:\n${listTitles(gap)}` : "No open objective-evidence gaps were flagged.", gap);
  }
  if (/inconsist/ .test(q) || /conflict|mutually exclusive|contradict/.test(q)) {
    const conf = pick((i) => i.category === "recommendation_conflict" || i.category === "staged_care");
    return ans(conf.length ? `${conf.length} consistency issue${conf.length === 1 ? "" : "s"} between recommendations:\n${listTitles(conf)}` : "No conflicting or mutually-exclusive recommendations were detected.", conf);
  }
  if (/changed|version|since/.test(q)) {
    return ans("Version-to-version changes are shown in the case's version comparison. This review reflects the current case state; I don't infer prior versions here.", []);
  }
  if (/first|priorit|start|where.*begin/.test(q)) {
    const top = pick(() => true);
    return ans(top.length ? `Start with the highest-severity items:\n${listTitles(top, 5)}` : "There are no open attention items — the case is clean on the current findings.", top.slice(0, 5));
  }
  // Default: a readiness overview.
  const crit = pick((i) => i.severity === "CRITICAL" || i.exportBlocking);
  const high = pick((i) => i.severity === "HIGH");
  return ans(`Case review summary: ${crit.length} critical/blocking, ${high.length} high-priority, ${a.length} open item${a.length === 1 ? "" : "s"} total. ${crit.length ? "Final export is blocked until the critical items are resolved." : "No export-blocking findings remain."} Ask about weak recommendations, costs, citations, physician review, conflicts, or what to review first.`, [...crit, ...high]);
}

// ── Async persistence + lifecycle ────────────────────────────────────────────

const toRow = (d: AttentionDraft) => ({
  validationRuleId: d.validationRuleId, category: d.category, severity: d.severity, title: d.title,
  summary: d.summary, whyItMatters: d.whyItMatters, suggestedAction: d.suggestedAction,
  entityType: d.entityType, entityId: d.entityId, sourceDocumentId: d.sourceDocumentId,
  sourcePage: d.sourcePage, exportBlocking: d.exportBlocking,
});

/** Re-project the case and persist: create new items, refresh active ones,
 *  supersede vanished ones. Resolved/dismissed history is preserved. Returns the
 *  active queue, the readiness stages, and the validation counts. */
export async function syncAttention(caseId: string, firmId: string, createdById?: string) {
  const validation = await validateCase(caseId);
  const items = await prisma.futureCareItem.findMany({ where: { caseId, supersededAt: null }, select: { id: true, service: true, physicianStatus: true } });
  const drafts = projectAttention(validation, items);
  const existing = await prisma.attentionItem.findMany({ where: { caseId }, select: { id: true, validationRuleId: true, status: true } });
  const plan = reconcileAttention(existing as ExistingAttention[], drafts);

  const now = new Date();
  await prisma.$transaction([
    ...plan.create.map((d) => prisma.attentionItem.create({ data: { ...toRow(d), caseId, firmId, createdById } })),
    ...plan.update.map((u) => prisma.attentionItem.update({ where: { id: u.id }, data: { ...toRow(u.draft) } })),
    ...plan.supersede.map((id) => prisma.attentionItem.update({ where: { id }, data: { status: "SUPERSEDED", resolvedAt: now } })),
  ]);

  const activeItems = await prisma.attentionItem.findMany({ where: { caseId, status: { in: ACTIVE } }, orderBy: { createdAt: "asc" } });
  // Work order = AI-pipeline stage, then severity within a stage.
  activeItems.sort(
    (a, b) => pipelineRank(a.category) - pipelineRank(b.category) || SEVERITY_RANK[a.severity as AttentionSeverity] - SEVERITY_RANK[b.severity as AttentionSeverity],
  );
  const active = activeItems.map((a) => ({ ...a, stageLabel: stageLabel(a.category) }));
  const readiness = caseReadiness(activeItems.map((a) => ({ severity: a.severity as AttentionSeverity, category: a.category, exportBlocking: a.exportBlocking, title: a.title })), validation.counts);
  return { active, readiness, counts: validation.counts, blocking: validation.blocking };
}
