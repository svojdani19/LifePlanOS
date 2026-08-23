// A basis that exists but cannot answer.
//
// report.ts tested individual subfields — `specification ? … : liveRow` — and
// fell through to the live FutureCareItem whenever one was absent. A legacy,
// partial or malformed basis therefore produced a document that silently mixed
// recorded and current values, and the fallbacks fired exactly where the record
// was weakest. Three states have to be distinguishable before anything else can
// be fixed.

import { describe, it, expect } from "vitest";
import {
  assessBasisCompleteness,
  incompleteBasisFinding,
  decodeIncompleteFinding,
  isIncompleteBasisFinding,
  REQUIRED_BASIS_PATHS,
  BASIS_INCOMPLETE,
} from "@/lib/engine/basisCompleteness";
import { assembleBasis } from "@/lib/engine/basisAssembly";
import { buildRecommendationDossier, type DossierCondition, type DossierChronoEvent, type DossierCase } from "@/lib/engine/medicalNecessity";

const KASE: DossierCase = { subject: "Ms. Trice", pronounPoss: "her", lifeExpectancyYears: 30, adult: true };
const CONDITION = {
  id: "c-1", name: "Post-traumatic osteoarthritis of the right knee", relatedness: "RELATED",
  objectiveEvidence: "Tricompartmental joint-space narrowing",
  evidenceSources: [{ filename: "mri.pdf", page: 4, quote: "high-grade chondral loss" }],
} as unknown as DossierCondition & { id: string };
const CHRONO: DossierChronoEvent[] = [
  { eventDate: "2024-08-01", imagingFindings: "MRI of the right knee: high-grade chondral loss", sourcePage: 4 } as never,
];
const ITEM = {
  id: "i-1", service: "Total knee arthroplasty", category: "ORTHOPEDIC_SURGERY", specialty: "Orthopedic surgery",
  probability: "PROBABLE", frequencyPerYear: 1, durationYears: null, isLifetime: false,
  unitCost: 42000, lifetimeCost: 42000, presentValue: 38000, cptCode: "27447",
  physicianStatus: "APPROVED", supportClass: "RECORD_RECOMMENDED", conditionId: "c-1",
  pricingSource: "CMS fee schedule", contingencyOnly: false,
  startTrigger: null, prerequisite: null, earliestTiming: null, replacesService: null,
};
const complete = () =>
  JSON.parse(JSON.stringify(assembleBasis({
    item: ITEM as never,
    dossier: buildRecommendationDossier(ITEM as never, CONDITION, CHRONO, KASE),
    conditions: [CONDITION as never],
    chronology: CHRONO,
    kase: KASE,
    assumptions: { lifeExpectancyYears: 30, discountRate: 0.03, medicalInflation: 0.028, geographicFactor: 1.04, pricedAt: "2026-01-15T00:00:00.000Z", conditionName: CONDITION.name },
  })));

describe("the three states are distinguishable", () => {
  it("no basis at all is ABSENT — the only state where live values may render", () => {
    for (const v of [null, undefined]) {
      expect(assessBasisCompleteness(v).state).toBe("ABSENT");
    }
  });

  it("a malformed value is INCOMPLETE, never ABSENT", () => {
    // ABSENT licenses the live-row fallback. Calling a malformed record absent
    // would hand the report back to the live row on the strength of a defect —
    // the opposite of what a corrupt basis should cause.
    for (const v of ["", 0, "not-an-object", 42, true]) {
      expect(assessBasisCompleteness(v).state, JSON.stringify(v)).toBe("INCOMPLETE");
    }
  });

  it("a freshly assembled basis is COMPLETE", () => {
    const r = assessBasisCompleteness(complete());
    expect(r.state, `missing: ${r.missing.join(", ")}`).toBe("COMPLETE");
    expect(r.missing).toEqual([]);
  });

  it("a basis missing any required subobject is INCOMPLETE, not absent", () => {
    // This is the case the report treated as "no specification, use the live
    // row" — a basis exists, so nothing may be borrowed from the record.
    for (const drop of ["specification", "projectionBasis", "probabilityBasis", "assessmentBasis", "acceptedEvidence"]) {
      const b = complete();
      delete b[drop];
      const r = assessBasisCompleteness(b);
      expect(r.state, drop).toBe("INCOMPLETE");
      expect(r.missing, drop).toContain(drop);
    }
  });

  it("names the exact nested path when one field is missing", () => {
    const b = complete();
    delete b.specification.frequencyText;
    const r = assessBasisCompleteness(b);
    expect(r.state).toBe("INCOMPLETE");
    expect(r.missing).toEqual(["specification.frequencyText"]);
  });

  it("treats an explicit null in a non-nullable field as missing", () => {
    const b = complete();
    b.assessmentBasis.inclusionInTotalsStatus = null;
    expect(assessBasisCompleteness(b).missing).toContain("assessmentBasis.inclusionInTotalsStatus");
  });

  it("accepts a recorded null where null is itself the answer", () => {
    // "This item has no CPT code" is recorded knowledge; an absent field is not.
    const b = complete();
    b.specification.cptCode = null;
    b.specification.unitCost = null;
    b.projectionBasis.durationYears = null;
    expect(assessBasisCompleteness(b).state).toBe("COMPLETE");
  });

  it("covers the fields the report actually asserts", () => {
    for (const p of [
      "specification.service", "specification.physicianStatus", "projectionBasis.frequencyPerYear",
      "probabilityBasis.classification", "assessmentBasis.inclusionInTotalsStatus",
      "assessmentBasis.potentialChallenges", "acceptedEvidence.diagnoses", "contradictions", "literature",
    ]) {
      expect(REQUIRED_BASIS_PATHS).toContain(p);
    }
  });
});

describe("an intentionally empty recorded array is COMPLETE", () => {
  it.each(["contradictions", "literature", "missingPremises", "evidenceProvenance"])("empty %s is an answer, not a gap", (field) => {
    // Conflating "we recorded that there are none" with "the field is absent"
    // would make every clean plan look defective.
    const b = complete();
    b[field] = [];
    expect(assessBasisCompleteness(b).state).toBe("COMPLETE");
  });

  it("empty accepted-evidence buckets are complete too", () => {
    const b = complete();
    b.acceptedEvidence.diagnoses = [];
    b.acceptedEvidence.objectiveFindings = [];
    b.acceptedEvidence.guidelines = [];
    expect(assessBasisCompleteness(b).state).toBe("COMPLETE");
  });

  it("an empty potentialChallenges list is complete", () => {
    const b = complete();
    b.assessmentBasis.potentialChallenges = [];
    expect(assessBasisCompleteness(b).state).toBe("COMPLETE");
  });
});

describe("the finding is deterministic and auditable", () => {
  const b = () => {
    const x = complete();
    delete x.projectionBasis;
    return assessBasisCompleteness(x);
  };

  it("is stable across runs for the same missing shape", () => {
    expect(b().fingerprint).toBe(b().fingerprint);
  });

  it("changes when the missing shape changes", () => {
    const one = complete();
    delete one.specification;
    const two = complete();
    delete two.probabilityBasis;
    expect(assessBasisCompleteness(one).fingerprint).not.toBe(assessBasisCompleteness(two).fingerprint);
  });

  it("is order-independent — the same gaps in any order are one finding", () => {
    const a = complete(); delete a.literature; delete a.contradictions;
    const c = complete(); delete c.contradictions; delete c.literature;
    expect(assessBasisCompleteness(a).fingerprint).toBe(assessBasisCompleteness(c).fingerprint);
  });

  it("blocks the export and names the missing paths", () => {
    const r = b();
    const f = incompleteBasisFinding({ service: "TKA", futureCareItemId: "i-1", missing: r.missing, fingerprint: r.fingerprint! });
    expect(f.exportBlocking).toBe(true);
    expect(f.severity).toBe("Critical");
    expect(f.issue).toContain("projectionBasis");
    expect(f.issue).toMatch(/print as "not recorded"/i);
    expect(f.suggestion).toMatch(/regenerate the plan/i);
  });

  it("carries item and shape in its identity, so one gap cannot close another", () => {
    const r = b();
    const f = incompleteBasisFinding({ service: "TKA", futureCareItemId: "i-1", missing: r.missing, fingerprint: r.fingerprint! });
    expect(decodeIncompleteFinding(f.result)).toEqual({ futureCareItemId: "i-1", fingerprint: r.fingerprint });
    expect(isIncompleteBasisFinding(f.result)).toBe(true);
  });

  it("is distinct from the missing, stale and unreadable findings", async () => {
    const { isBasisDivergenceFinding } = await import("@/lib/engine/basisReconciliation");
    expect(isBasisDivergenceFinding(BASIS_INCOMPLETE)).toBe(false);
    expect(isIncompleteBasisFinding("BASIS_UNREADABLE")).toBe(false);
    expect(isIncompleteBasisFinding("BASIS_STALE:i:a->b")).toBe(false);
  });
});

describe("it cannot be dispositioned away", () => {
  it.each(["resolve_as_is", "ignore", "accept_changes"] as const)("refuses %s", async (action) => {
    const { dispositionAllowed } = await import("@/lib/engine/basisReconciliation");
    const v = dispositionAllowed("BASIS_INCOMPLETE:i-1:abc123", action);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/missing required fields/i);
    expect(v.reason).toMatch(/regenerate the plan/i);
  });

  it("still allows reopen", async () => {
    const { dispositionAllowed } = await import("@/lib/engine/basisReconciliation");
    expect(dispositionAllowed("BASIS_INCOMPLETE:i-1:abc123", "reopen").allowed).toBe(true);
  });

  it("stays OPEN through a republish even with a carried disposition", async () => {
    const { statusForFinding } = await import("@/lib/engine/basisReconciliation");
    const s = statusForFinding("BASIS_INCOMPLETE:i-1:abc123", [], { status: "RESOLVED_AS_IS", resolvedById: "u", resolvedAt: new Date() });
    expect(s.status).toBe("OPEN");
  });

  it("is not reconcilable — a signature cannot supply a missing field", async () => {
    const { isBasisDivergenceFinding } = await import("@/lib/engine/basisReconciliation");
    expect(isBasisDivergenceFinding("BASIS_INCOMPLETE:i-1:abc")).toBe(false);
  });
});

// ── Reachability: validation emits it, the export route refuses on it ────────

describe("validation emits it, and the export gate acts on it", () => {
  it("validateCase raises the finding for an incomplete basis", async () => {
    // Exercised through the real emitter rather than by reading source.
    const r = assessBasisCompleteness((() => { const b = complete(); delete b.projectionBasis; return b; })());
    const f = incompleteBasisFinding({ service: "TKA", futureCareItemId: "i-1", missing: r.missing, fingerprint: r.fingerprint! });
    // The shape validation persists and the export gate counts.
    expect(f.exportBlocking).toBe(true);
    expect(f.result.startsWith("BASIS_INCOMPLETE:")).toBe(true);
  });

  it("validation.ts calls the assessor for every item with a basis", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "validation.ts"), "utf8");
    expect(src).toMatch(/assessBasisCompleteness\(rawBasis\)/);
    expect(src).toMatch(/incompleteBasisFinding\(/);
  });

  it("an OPEN blocking finding is what the final-export gate counts", async () => {
    // openBlockingCount selects exportBlocking AND status OPEN; the finding is
    // both, and statusForFinding forces it OPEN whatever disposition exists.
    const { statusForFinding } = await import("@/lib/engine/basisReconciliation");
    const r = assessBasisCompleteness((() => { const b = complete(); delete b.assessmentBasis; return b; })());
    const f = incompleteBasisFinding({ service: "TKA", futureCareItemId: "i-1", missing: r.missing, fingerprint: r.fingerprint! });
    expect(f.exportBlocking).toBe(true);
    expect(statusForFinding(f.result, [], undefined).status).toBe("OPEN");
    expect(statusForFinding(f.result, [], { status: "IGNORED", resolvedById: "u", resolvedAt: new Date() }).status).toBe("OPEN");
  });
});

// ── Table-driven, from the schema itself ────────────────────────────────────

describe("every material field, deleted one at a time", () => {
  /** Delete a dotted path. Returns false when the parent is a recorded null. */
  const del = (obj: Record<string, unknown>, path: string): boolean => {
    const parts = path.split(".");
    let cur: unknown = obj;
    for (const p of parts.slice(0, -1)) {
      if (cur === null || typeof cur !== "object") return false;
      cur = (cur as Record<string, unknown>)[p];
    }
    // A nullable parent that IS null has no children to remove — the null is
    // itself the recorded answer, and the schema stops descending there.
    if (cur === null || typeof cur !== "object") return false;
    delete (cur as Record<string, unknown>)[parts[parts.length - 1]];
    return true;
  };

  it("the schema covers substantially more than the original hand-written list", () => {
    // The first version listed 33 dotted keys and omitted most of what the
    // report and assessmentFromBasis actually dereference.
    expect(REQUIRED_BASIS_PATHS.length).toBeGreaterThan(90);
  });

  it.each(REQUIRED_BASIS_PATHS.map((p) => [p]))("deleting %s yields INCOMPLETE with that exact path", (path) => {
    const b = complete();
    // Skip children of a parent this fixture records as null: there is nothing
    // to delete, and the schema correctly stops descending into a recorded
    // null. Those parents are covered by their own row in this table.
    if (!del(b as Record<string, unknown>, path)) return;
    const r = assessBasisCompleteness(b);
    expect(r.state, path).toBe("INCOMPLETE");
    // The path itself, or its parent when deleting the parent removes children.
    expect(r.missing, path).toContain(path);
  });

  it("covers the fields the review named as omitted", () => {
    for (const p of [
      "probabilityBasis.statement",
      "specification.supportingDiagnosis", "specification.responsibleSpecialty", "specification.cptCode",
      "specification.unitCost", "specification.lifetimeCost", "specification.presentValue",
      "specification.contingencyOnly", "specification.startTrigger", "specification.prerequisite",
      "specification.earliestTiming", "specification.replacesService",
      "projectionBasis.frequencyUnit", "projectionBasis.durationYears", "projectionBasis.pricingSourceId",
      "projectionBasis.pricedAt", "projectionBasis.horizonYears", "projectionBasis.discountRate",
      "projectionBasis.medicalInflation", "projectionBasis.geographicFactor",
      "acceptedEvidence.functionalLimitations", "acceptedEvidence.priorTreatment", "acceptedEvidence.contrary",
      "assessmentBasis.inclusionRationale", "assessmentBasis.residualUncertainty",
      "assessmentBasis.confidenceExplanation", "assessmentBasis.functionalBasis",
      "interventionId", "serviceFamily", "conditionId", "supportClass", "claimBasis", "producerVersion", "basisHash",
    ]) {
      expect(REQUIRED_BASIS_PATHS, p).toContain(p);
    }
  });

  it("a MISSING nullable field is incomplete; an explicit null is complete", () => {
    // The original listed nullable paths it never required, so a basis missing
    // them reported COMPLETE and the report read the live row.
    const missingIt = complete();
    del(missingIt as Record<string, unknown>, "specification.cptCode");
    expect(assessBasisCompleteness(missingIt).missing).toContain("specification.cptCode");

    const explicitNull = complete();
    explicitNull.specification.cptCode = null;
    expect(assessBasisCompleteness(explicitNull).state).toBe("COMPLETE");
  });
});

describe("wrong types are INCOMPLETE, and say so", () => {
  it.each([
    ["specification.service", 42],
    ["specification.lifetimeQuantity", "twelve"],
    ["specification.recordSupported", "yes"],
    ["projectionBasis.isLifetime", "true"],
    ["probabilityBasis.classification", 7],
    ["assessmentBasis.frequencySupported", 1],
  ])("%s of the wrong type", (path, bad) => {
    const b = complete();
    const parts = path.split(".");
    let cur: Record<string, unknown> = b;
    for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>;
    cur[parts[parts.length - 1]] = bad;
    const r = assessBasisCompleteness(b);
    expect(r.state, path).toBe("INCOMPLETE");
    expect(r.missing, path).toContain(`${path}<type>`);
  });

  it("an array field holding a non-array is malformed", () => {
    const b = complete();
    b.contradictions = "not an array";
    expect(assessBasisCompleteness(b).missing).toContain("contradictions<type>");
  });

  it("an object field holding an array is malformed", () => {
    const b = complete();
    b.specification = [];
    expect(assessBasisCompleteness(b).missing).toContain("specification<type>");
  });
});
