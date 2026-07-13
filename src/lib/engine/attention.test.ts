import { describe, it, expect } from "vitest";
import { projectAttention, reconcileAttention, caseReadiness, answerCaseQuestion, type AttentionDraft, type ExistingAttention } from "./attention";
import type { CaseValidation } from "./validation";

const counts = { proposed: 3, recordSupported: 2, physicianApproved: 0, awaitingReview: 3, excluded: 1, included: 2 };

const validation: CaseValidation = {
  findings: [
    { service: "Lumbar fusion", result: "Mutually exclusive recommendations both totaled", issue: "Both pathways are included in the total.", severity: "Critical", suggestion: "Include only the more probable; reclassify the other.", exportBlocking: true },
    { service: "Pain management visits", result: "Irrelevant literature", issue: "The only citation failed the relevance filter.", severity: "High", suggestion: "Cite relevant guideline/cohort evidence.", exportBlocking: false },
  ],
  blocking: true,
  counts,
};
const items = [
  { id: "i1", service: "Lumbar fusion", physicianStatus: "PENDING" },
  { id: "i2", service: "Pain management visits", physicianStatus: "APPROVED" },
];

describe("projectAttention", () => {
  const drafts = projectAttention(validation, items);
  const byFp = (frag: string) => drafts.find((d) => d.validationRuleId.includes(frag));

  it("projects each validation finding, preserving severity and export-blocking", () => {
    const conflict = drafts.find((d) => d.category === "recommendation_conflict");
    expect(conflict?.severity).toBe("CRITICAL");
    expect(conflict?.exportBlocking).toBe(true);
    const lit = drafts.find((d) => d.category === "literature");
    expect(lit?.severity).toBe("HIGH");
    expect(lit?.whyItMatters).toMatch(/diagnosis|procedure|region|population/i);
  });

  it("surfaces physician-review-pending only for un-reviewed recommendations", () => {
    expect(byFp("physician_review_pending")).toBeTruthy(); // Lumbar fusion is PENDING
    expect(drafts.filter((d) => d.category === "physician_review_pending")).toHaveLength(1); // not the APPROVED one
  });

  it("cites the affected recommendation entity, not a free-text guess", () => {
    const conflict = drafts.find((d) => d.category === "recommendation_conflict")!;
    expect(conflict.entityType).toBe("recommendation");
    expect(conflict.entityId).toBe("i1");
  });

  it("does not emit duplicate fingerprints within one projection", () => {
    const fps = drafts.map((d) => d.validationRuleId);
    expect(new Set(fps).size).toBe(fps.length);
  });
});

describe("reconcileAttention (dedup / supersede / history)", () => {
  const drafts = projectAttention(validation, items);
  const fp = (frag: string) => drafts.find((d) => d.validationRuleId.includes(frag))!.validationRuleId;

  it("updates a still-active item in place — never creates a duplicate", () => {
    const existing: ExistingAttention[] = [{ id: "a1", validationRuleId: fp("mutually exclusive"), status: "OPEN" }];
    const plan = reconcileAttention(existing, drafts);
    expect(plan.update.map((u) => u.id)).toContain("a1");
    expect(plan.create.some((c) => c.validationRuleId === fp("mutually exclusive"))).toBe(false);
  });

  it("keeps a RESOLVED finding out of the active queue and never re-creates it (history preserved)", () => {
    const existing: ExistingAttention[] = [{ id: "a1", validationRuleId: fp("mutually exclusive"), status: "RESOLVED" }];
    const plan = reconcileAttention(existing, drafts);
    expect(plan.create.some((c) => c.validationRuleId === fp("mutually exclusive"))).toBe(false);
    expect(plan.update).toHaveLength(0);
    expect(plan.supersede).toHaveLength(0); // resolved item stays as history, not superseded
  });

  it("supersedes an active item whose underlying issue has disappeared", () => {
    const existing: ExistingAttention[] = [{ id: "gone", validationRuleId: "old-service::old finding", status: "OPEN" }];
    const plan = reconcileAttention(existing, drafts);
    expect(plan.supersede).toContain("gone");
  });

  it("creates genuinely new findings", () => {
    const plan = reconcileAttention([], drafts);
    expect(plan.create.length).toBe(drafts.length);
    expect(plan.update).toHaveLength(0);
    expect(plan.supersede).toHaveLength(0);
  });
});

describe("caseReadiness", () => {
  const active = (d: AttentionDraft) => ({ severity: d.severity, category: d.category, exportBlocking: d.exportBlocking, title: d.title });
  const drafts = projectAttention(validation, items).map(active);

  it("blocks final export while a critical/blocking item is open, but keeps draft export available", () => {
    const stages = caseReadiness(drafts, counts);
    const final = stages.find((s) => s.stage === "final_export")!;
    const draft = stages.find((s) => s.stage === "draft_export")!;
    expect(final.ready).toBe(false);
    expect(final.blocking.length).toBeGreaterThan(0);
    expect(draft.ready).toBe(true); // draft is available with a watermark
  });

  it("clears final export once no critical/blocking items remain", () => {
    const noCritical = drafts.filter((d) => d.severity !== "CRITICAL" && !d.exportBlocking);
    const stages = caseReadiness(noCritical, counts);
    expect(stages.find((s) => s.stage === "final_export")!.ready).toBe(true);
  });

  it("never reduces readiness to a single opaque score — every stage lists its findings", () => {
    const stages = caseReadiness(drafts, counts);
    expect(stages).toHaveLength(4);
    for (const s of stages) expect(Array.isArray(s.blocking) && Array.isArray(s.nextActions)).toBe(true);
  });
});

describe("answerCaseQuestion (grounded, cites entities, never approves)", () => {
  const active = projectAttention(validation, items).map((d) => ({
    severity: d.severity, category: d.category, title: d.title, summary: d.summary,
    suggestedAction: d.suggestedAction, exportBlocking: d.exportBlocking, entityType: d.entityType, entityId: d.entityId,
  }));
  const readiness = caseReadiness(active, counts);
  const ask = (q: string) => answerCaseQuestion(q, { active, readiness, counts });

  it("answers what blocks finalization with the actual blocking findings, citing entities", () => {
    const r = ask("What prevents this case from being finalized?");
    expect(r.answer).toMatch(/mutually exclusive|export-blocking|critical/i);
    expect(r.basis.some((b) => b.entityType === "recommendation" && b.entityId === "i1")).toBe(true);
    expect(r.disclaimer).toMatch(/does not approve/i);
  });

  it("reports pending physician review without claiming approval", () => {
    const r = ask("Which recommendations lack physician approval?");
    expect(r.answer).toMatch(/awaiting physician review|no physician-approval event/i);
    expect(r.answer).not.toMatch(/approved by/i);
  });

  it("surfaces irrelevant citations and cost duplication from the findings", () => {
    expect(ask("Which citations are irrelevant?").answer).toMatch(/literature/i);
    expect(ask("what should I review first?").answer).toMatch(/highest-severity|critical|mutually exclusive/i);
  });

  it("never fabricates when there are no findings of a kind", () => {
    const clean = answerCaseQuestion("are any costs duplicated?", { active: [], readiness, counts });
    expect(clean.answer).toMatch(/no duplicated|no .*cost/i);
    expect(clean.basis).toHaveLength(0);
  });
});
