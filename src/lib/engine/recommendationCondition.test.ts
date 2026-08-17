// One item, one diagnosis — for every part of its panel.
//
// The evidence buckets were built from the item's stored conditionId while the
// Clinical Reasoning block beside them ran its own mapper. A panel could argue
// about one diagnosis and cite findings belonging to another.
//
// Synthetic data only.
import { describe, expect, it } from "vitest";
import { resolveRecommendationCondition } from "@/lib/engine/recommendationCondition";
import type { CondInput } from "@/lib/engine/integrity";

const cond = (id: string, name: string): CondInput => ({ id, name }) as CondInput;
const LUMBAR = cond("c-lumbar", "Lumbar radiculopathy");
const CERVICAL = cond("c-cervical", "Cervical disc disorder with radiculopathy");

describe("one authoritative condition per recommendation", () => {
  it("uses the mapped condition when the service names an anatomy", () => {
    const r = resolveRecommendationCondition({ service: "Lumbar epidural steroid injection", conditionId: LUMBAR.id }, [LUMBAR, CERVICAL]);
    expect(r.condition?.id).toBe(LUMBAR.id);
    expect(r.conflict).toBeNull();
  });

  it("honours the stored link for a region-neutral service", () => {
    // A TENS unit names no anatomy; the persisted link is the better evidence
    // of what it serves than a mapper reading the service text.
    const r = resolveRecommendationCondition({ service: "TENS unit and supplies", conditionId: LUMBAR.id }, [LUMBAR, CERVICAL]);
    expect(r.condition?.id).toBe(LUMBAR.id);
    expect(r.source).toBe("persisted");
  });

  it("reports a disagreement rather than silently picking a winner", () => {
    // Stored against the cervical diagnosis, but the service is lumbar.
    const r = resolveRecommendationCondition({ service: "Lumbar epidural steroid injection", conditionId: CERVICAL.id }, [LUMBAR, CERVICAL]);
    expect(r.conflict).not.toBeNull();
    expect(r.conflict!.persistedName).toMatch(/Cervical/);
    expect(r.conflict!.mappedName).toMatch(/Lumbar/);
  });

  it("is not a disagreement when the mapper simply found nothing", () => {
    const r = resolveRecommendationCondition({ service: "Home health aide", conditionId: LUMBAR.id }, [LUMBAR]);
    expect(r.conflict).toBeNull();
  });

  it("returns nothing rather than inventing a condition", () => {
    const r = resolveRecommendationCondition({ service: "Home health aide", conditionId: null }, []);
    expect(r.condition).toBeNull();
    expect(r.source).toBe("none");
  });

  it("gives the same answer every time it is asked — the point of the exercise", () => {
    const item = { service: "TENS unit and supplies", conditionId: LUMBAR.id };
    const answers = new Set(Array.from({ length: 10 }, () => resolveRecommendationCondition(item, [LUMBAR, CERVICAL]).condition?.id));
    expect(answers.size).toBe(1);
  });
});
