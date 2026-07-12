import { describe, it, expect } from "vitest";
import {
  bodyRegion,
  mapRecommendationToCondition,
  validateCode,
  validatePricing,
  evaluateCitation,
  filterCitations,
  classifyRecommendation,
  runIntegrityCheck,
  reviewLabel,
  functionalFinding,
  type CondInput,
  type RecInput,
} from "./integrity";

const conditions: CondInput[] = [
  { id: "spine", name: "L1 burst fracture with residual deficit", relatedness: "RELATED", supportingRecords: "Op note 06/12" },
  { id: "knee", name: "Fracture of tibial plateau, left knee", relatedness: "RELATED", supportingRecords: "MRI 06/08" },
  { id: "bladder", name: "Neurogenic bladder (incomplete)", relatedness: "RELATED", supportingRecords: "Urology consult" },
];

describe("body-region mapping", () => {
  it("maps a total knee arthroplasty to the knee diagnosis, not the (primary) lumbar diagnosis", () => {
    const rec: RecInput = { service: "Total knee arthroplasty", specialty: "Orthopedic Surgery" };
    const m = mapRecommendationToCondition(rec, conditions);
    expect(m.region).toBe("knee");
    expect(m.condition?.id).toBe("knee");
    expect(m.matched).toBe(true);
  });

  it("maps spine surgeon follow-up to the spine diagnosis", () => {
    const m = mapRecommendationToCondition({ service: "Spine surgeon follow-up visits", specialty: "Neurosurgery" }, conditions);
    expect(m.condition?.id).toBe("spine");
  });

  it("maps urology care to the neurogenic bladder diagnosis", () => {
    const m = mapRecommendationToCondition({ service: "Urology evaluation and catheter supplies", specialty: "Urology" }, conditions);
    expect(m.condition?.id).toBe("bladder");
  });

  it("flags a region-specific rec with no matching diagnosis as unmatched", () => {
    const m = mapRecommendationToCondition({ service: "Rotator cuff repair", specialty: "Orthopedic Surgery" }, conditions);
    expect(m.region).toBe("shoulder");
    expect(m.matched).toBe(false);
    expect(m.conditionId).toBeNull();
  });

  it("maps region-agnostic case management to an injury-related diagnosis without a mismatch", () => {
    const m = mapRecommendationToCondition({ service: "Medical case management", specialty: "Case Management" }, conditions);
    expect(m.matched).toBe(true);
    expect(bodyRegion(m.condition!.name)).toBeTruthy();
  });
});

describe("CPT / HCPCS validation", () => {
  it("rejects a spine revision billed with a knee arthroplasty code (27487)", () => {
    const r = validateCode({ service: "Lumbar fusion revision", cptCode: "27487" });
    expect(r.status).toBe("Code mismatch");
    expect(r.detail).toMatch(/knee/i);
  });

  it("validates a total knee arthroplasty with 27447", () => {
    expect(validateCode({ service: "Total knee arthroplasty", cptCode: "27447" }).status).toBe("Validated");
  });

  it("flags an interlaminar code (62323) on a transforaminal injection", () => {
    const r = validateCode({ service: "Transforaminal epidural steroid injection, lumbar", cptCode: "62323" });
    expect(r.status).toBe("Code mismatch");
    expect(r.expected).toContain("64483");
  });

  it("validates a transforaminal injection with 64483", () => {
    expect(validateCode({ service: "Transforaminal epidural steroid injection, lumbar", cptCode: "64483" }).status).toBe("Validated");
  });

  it("flags an EMG/NCS study coded as an MRI (imaging)", () => {
    expect(validateCode({ service: "EMG/NCS electrodiagnostic study", cptCode: "72148" }).status).toBe("Code mismatch");
  });

  it("reports a missing code", () => {
    expect(validateCode({ service: "Revision total knee arthroplasty", cptCode: "" }).status).toBe("Missing code");
  });
});

describe("pricing validation", () => {
  it("rejects MRI pricing for an EMG/NCS study", () => {
    const r = validatePricing({ service: "EMG/NCS electrodiagnostic study", cptCode: "", pricingSource: "MRI lumbar spine benchmark (CMS 72148)", unitCost: 1200 });
    expect(r.status).toBe("Pricing mismatch");
  });

  it("flags a precise price with no code and no bundled disclosure", () => {
    const r = validatePricing({ service: "Home health aide package", cptCode: "", pricingSource: "Agency rate", unitCost: 45000 });
    expect(r.status).toBe("Unsupported bundled estimate");
  });

  it("accepts a bundled estimate that is disclosed as such", () => {
    const r = validatePricing({ service: "Home modification allowance", cptCode: "", pricingSource: "Bundled estimate — contractor allowance", unitCost: 15000 });
    expect(r.status).toBe("Validated");
  });
});

describe("literature relevance", () => {
  const uroCtx = { diagnosis: "Neurogenic bladder", region: "genitourinary" as const, service: "Urology evaluation", adult: true };

  it("rejects congenital/pediatric literature for an adult traumatic neurogenic bladder", () => {
    const r = evaluateCitation({ title: "Management of congenital neurogenic bladder in children", pubtype: ["Review"] }, uroCtx);
    expect(r.populationMatch).toBe(false);
    expect(r.relevant).toBe(false);
  });

  it("accepts an adult neurogenic-bladder guideline", () => {
    const r = evaluateCitation({ title: "Clinical practice guideline for neurogenic bladder management in adults", pubtype: ["Guideline"] }, uroCtx);
    expect(r.relevant).toBe(true);
    expect(r.evidenceLevel).toBe(1);
  });

  it("rejects an unrelated case report for a non-rare condition", () => {
    const r = evaluateCitation({ title: "A case report of an unusual hip presentation", pubtype: ["Case Reports"] }, { diagnosis: "Neurogenic bladder", service: "Urology evaluation" });
    expect(r.relevant).toBe(false);
  });

  it("filterCitations keeps the relevant guideline and drops the pediatric one", () => {
    const { kept, rejected } = filterCitations(
      [
        { title: "Congenital neurogenic bladder in the pediatric population" },
        { title: "Consensus guideline on neurogenic bladder in adults with spinal cord injury", pubtype: ["Guideline"] },
      ],
      uroCtx,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toMatch(/adults/i);
    expect(rejected).toHaveLength(1);
  });
});

describe("recommendation status & inclusion", () => {
  it("does not include an unsupported, unapproved item in the total", () => {
    const r = classifyRecommendation({ service: "Speculative future surgery", probability: "POSSIBLE", physicianStatus: "PENDING" }, { matched: true, codeCritical: false, hasRecordSupport: false });
    expect(r.includedInTotal).toBe(false);
    expect(r.status).toBe("POSSIBLE_CONTINGENCY");
  });

  it("includes a record-supported, probable item pending confirmation", () => {
    const r = classifyRecommendation({ service: "Pain management visits", probability: "PROBABLE", physicianStatus: "PENDING" }, { matched: true, codeCritical: false, hasRecordSupport: true });
    expect(r.includedInTotal).toBe(true);
    expect(r.status).toBe("RECORD_SUPPORTED_PENDING");
  });

  it("excludes an item with a critical coding defect", () => {
    const r = classifyRecommendation({ service: "Lumbar fusion revision", probability: "PROBABLE", physicianStatus: "PENDING" }, { matched: true, codeCritical: true, hasRecordSupport: true });
    expect(r.includedInTotal).toBe(false);
  });

  it("includes a physician-approved item", () => {
    const r = classifyRecommendation({ service: "Knee injections", probability: "PROBABLE", physicianStatus: "APPROVED" }, { matched: true, codeCritical: false, hasRecordSupport: true });
    expect(r.includedInTotal).toBe(true);
    expect(r.status).toBe("SUPPORTED_INCLUDED");
  });
});

describe("physician-review labels", () => {
  it("does not label a pending item as physician-approved", () => {
    const label = reviewLabel("PENDING", true);
    expect(label).not.toMatch(/approved/i);
    expect(label).toMatch(/awaiting/i);
  });

  it("labels an approved item as physician approved (an approval action occurred)", () => {
    expect(reviewLabel("APPROVED", true)).toMatch(/physician approved/i);
  });
});

describe("functional finding extraction", () => {
  const text = "Patient tolerated therapeutic exercise. Gait training with rolling walker. Standing tolerance limited to 10 minutes. No cognitive complaints noted.";

  it("carries a documented rolling walker into the ambulation domain", () => {
    const f = functionalFinding(text, /walk|ambulat|gait|walker/i);
    expect(f).not.toBeNull();
    expect(f!.snippet.toLowerCase()).toContain("rolling walker");
  });

  it("classifies a measured finding as quantified", () => {
    const f = functionalFinding(text, /\bstand/i);
    expect(f!.quantified).toBe(true); // "10 minutes"
  });

  it("returns null for an un-addressed domain", () => {
    expect(functionalFinding(text, /driv/i)).toBeNull();
  });
});

describe("integrity check — export blocking", () => {
  const hasRecordSupport = (_r: RecInput, m: CondInput | null) => !!(m && m.supportingRecords);

  it("blocks export on a wrong-region diagnosis mapping and a code mismatch", () => {
    const report = runIntegrityCheck({
      recommendations: [
        { service: "Total knee arthroplasty", cptCode: "27447", probability: "PROBABLE" }, // maps to knee — ok
        { service: "Lumbar fusion revision", cptCode: "27487", probability: "PROBABLE" }, // knee code on spine — critical
        { service: "Rotator cuff repair", cptCode: "29827", probability: "PROBABLE" }, // no shoulder dx — critical
      ],
      conditions,
      hasRecordSupport,
    });
    expect(report.blocking).toBe(true);
    const critical = report.findings.filter((f) => f.severity === "Critical");
    expect(critical.length).toBeGreaterThanOrEqual(2);
    // The two defective items are excluded from the total.
    expect(report.counts.included).toBe(1);
  });

  it("does not block a clean, record-supported plan", () => {
    const report = runIntegrityCheck({
      recommendations: [
        { service: "Total knee arthroplasty", cptCode: "27447", probability: "PROBABLE" },
        { service: "Spine surgeon follow-up", cptCode: "99214", probability: "PROBABLE" },
        { service: "Urology evaluation", cptCode: "99204", probability: "PROBABLE" },
      ],
      conditions,
      hasRecordSupport,
    });
    expect(report.blocking).toBe(false);
    expect(report.counts.included).toBe(3);
  });
});
