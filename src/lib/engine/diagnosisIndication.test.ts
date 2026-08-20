import { describe, it, expect } from "vitest";
import { classifyDiagnosis, indicationFor, diagnosisSupports, contextReason, INDICATIONS } from "@/lib/engine/diagnosisIndication";
import { resolveIntervention } from "@/lib/engine/serviceOntology";

describe("a diagnosis is read as a clinical concept, not as a string", () => {
  it("collapses the ways one problem is written", () => {
    for (const t of ["M54.16 Radiculopathy, lumbar region", "lumbar radiculopathy", "L5 nerve root impingement with radicular pain", "sciatica"]) {
      expect(classifyDiagnosis(t), t).toContain("RADICULOPATHY");
    }
  });

  it("does not read a bare radiculopathy as a herniation", () => {
    // A herniation is what licenses a discectomy; radiculopathy alone does not.
    expect(classifyDiagnosis("lumbar radiculopathy")).not.toContain("DISC_HERNIATION");
    expect(classifyDiagnosis("L4-5 disc herniation with radiculopathy")).toEqual(expect.arrayContaining(["RADICULOPATHY", "DISC_HERNIATION"]));
  });

  it("keeps a vertebral fracture distinct from an appendicular one", () => {
    expect(classifyDiagnosis("Lumbar burst fracture with residual deficit")).toContain("VERTEBRAL_FRACTURE");
    expect(classifyDiagnosis("Lumbar burst fracture with residual deficit")).not.toContain("APPENDICULAR_FRACTURE");
    expect(classifyDiagnosis("Tibial plateau fracture")).toContain("APPENDICULAR_FRACTURE");
  });
});

describe("the exact panel defects that prompted this", () => {
  const discectomy = resolveIntervention({ service: "Lumbar discectomy" }).id;

  it("does not present chronic regional pain as support for a discectomy", () => {
    // Shown under "Supporting diagnoses" for a lumbar discectomy.
    const dx = "Chronic cervical, thoracic, and lumbar pain with tailbone-region pain and functional limitation";
    expect(indicationFor(dx, discectomy).verdict).toBe("CONTEXT");
    expect(diagnosisSupports(dx, discectomy)).toBe(false);
    expect(contextReason(dx, discectomy)).toMatch(/not an indication for this service/);
  });

  it("does not present a burst fracture as support for a discectomy", () => {
    // A burst fracture indicates STABILISATION — a different operation.
    const dx = "Lumbar burst fracture with residual deficit";
    expect(indicationFor(dx, discectomy).verdict).toBe("CONTEXT");
    expect(indicationFor(dx, "SPINAL_FUSION").verdict).toBe("INDICATED");
  });

  it("does present the diagnosis a discectomy is actually offered for", () => {
    expect(indicationFor("Radiculopathy, lumbar region (M54.16)", discectomy).verdict).toBe("INDICATED");
    expect(indicationFor("L4-5 disc herniation with nerve root contact", discectomy).verdict).toBe("INDICATED");
  });
});

describe("procedures inside one family have different indications", () => {
  it("separates the epidural pathway from the facet pathway", () => {
    // Same family, same anatomy, different clinical problem.
    expect(indicationFor("lumbar radiculopathy", "EPIDURAL_STEROID").verdict).toBe("INDICATED");
    expect(indicationFor("lumbar radiculopathy", "MEDIAL_BRANCH_BLOCK").verdict).toBe("CONTEXT");
    expect(indicationFor("lumbar facet arthropathy", "MEDIAL_BRANCH_BLOCK").verdict).toBe("INDICATED");
    expect(indicationFor("lumbar facet arthropathy", "EPIDURAL_STEROID").verdict).toBe("CONTEXT");
  });

  it("separates the spine operations by what each one treats", () => {
    expect(indicationFor("lumbar spinal stenosis", "LAMINECTOMY_DECOMPRESSION").verdict).toBe("INDICATED");
    expect(indicationFor("spondylolisthesis with segmental instability", "SPINAL_FUSION").verdict).toBe("INDICATED");
    expect(indicationFor("spondylolisthesis with segmental instability", "DISCECTOMY").verdict).toBe("CONTEXT");
  });

  it("keeps a knee treatment out of a spine diagnosis's support", () => {
    expect(indicationFor("lumbar radiculopathy", "VISCOSUPPLEMENTATION").verdict).toBe("CONTEXT");
    expect(indicationFor("right knee osteoarthritis", "VISCOSUPPLEMENTATION").verdict).toBe("INDICATED");
  });

  it("requires CRPS for a sympathetic block, not any pain", () => {
    expect(indicationFor("chronic low back pain", "SYMPATHETIC_BLOCK").verdict).toBe("CONTEXT");
    expect(indicationFor("complex regional pain syndrome, right lower extremity", "SYMPATHETIC_BLOCK").verdict).toBe("INDICATED");
  });
});

describe("non-specific services are marked as such rather than faked", () => {
  it("does not pretend physical therapy or an MRI has a narrow indication list", () => {
    expect(indicationFor("lumbar radiculopathy", "PHYSICAL_THERAPY").verdict).toBe("NON_SPECIFIC");
    expect(indicationFor("right knee osteoarthritis", "MRI").verdict).toBe("NON_SPECIFIC");
    expect(diagnosisSupports("anything at all", "SPECIALIST_FOLLOWUP")).toBe(true);
  });

  it("admits a diagnosis it cannot classify rather than hiding it", () => {
    // Failing open here is deliberate: a concept the lexicon does not know is
    // a gap in the model, and silently dropping the diagnosis would hide
    // evidence a physician needs to see.
    expect(indicationFor("Sequelae of unspecified injury", "DISCECTOMY").verdict).toBe("UNCLASSIFIED");
    expect(diagnosisSupports("Sequelae of unspecified injury", "DISCECTOMY")).toBe(true);
  });
});

describe("the table is reviewable as data", () => {
  it("uses only declared concepts, so a typo cannot silently disable a row", () => {
    const declared = new Set(classifyDiagnosis("").concat([
      "RADICULOPATHY", "DISC_HERNIATION", "SPINAL_STENOSIS", "FACET_ARTHROPATHY", "SEGMENTAL_INSTABILITY",
      "VERTEBRAL_FRACTURE", "MYELOPATHY", "SPINAL_CORD_INJURY", "OSTEOARTHRITIS", "INTRA_ARTICULAR_TEAR",
      "TENDINOPATHY", "APPENDICULAR_FRACTURE", "NONUNION", "JOINT_INSTABILITY", "PERIPHERAL_NEUROPATHY",
      "CRPS", "CHRONIC_PAIN", "MYOFASCIAL_SPASM", "HEADACHE", "TBI_COGNITIVE", "PSYCHIATRIC", "FUNCTIONAL_DEPENDENCE",
    ] as never[]));
    for (const [intervention, allowed] of Object.entries(INDICATIONS)) {
      if (allowed === "ANY" || !allowed) continue;
      for (const r of allowed) expect(declared.has(r.concept as never), `${intervention} → ${r.concept}`).toBe(true);
    }
  });

  it("has a reachable diagnosis for every non-specific-free intervention listed", () => {
    const witness: Record<string, string> = {
      RADICULOPATHY: "lumbar radiculopathy", DISC_HERNIATION: "disc herniation", SPINAL_STENOSIS: "spinal stenosis",
      FACET_ARTHROPATHY: "facet arthropathy", SEGMENTAL_INSTABILITY: "spondylolisthesis", VERTEBRAL_FRACTURE: "burst fracture of the spine",
      MYELOPATHY: "cervical myelopathy", SPINAL_CORD_INJURY: "spinal cord injury", OSTEOARTHRITIS: "knee osteoarthritis",
      INTRA_ARTICULAR_TEAR: "meniscal tear", TENDINOPATHY: "rotator cuff tendinopathy", APPENDICULAR_FRACTURE: "tibial fracture",
      NONUNION: "nonunion", JOINT_INSTABILITY: "joint instability", PERIPHERAL_NEUROPATHY: "peripheral neuropathy",
      CRPS: "complex regional pain syndrome", CHRONIC_PAIN: "chronic pain", MYOFASCIAL_SPASM: "muscle spasm",
      HEADACHE: "migraine", TBI_COGNITIVE: "traumatic brain injury", PSYCHIATRIC: "depression", FUNCTIONAL_DEPENDENCE: "dependent for transfers",
    };
    for (const [intervention, allowed] of Object.entries(INDICATIONS)) {
      if (allowed === "ANY" || !allowed) continue;
      const first = allowed[0].concept as string;
      expect(indicationFor(witness[first], intervention as never).verdict, `${intervention} ← ${first}`).toBe("INDICATED");
    }
  });
});

describe("corrections found by checking the model against real records", () => {
  it("treats cervical radiculopathy as an indication for an ACDF", () => {
    // Caught on the reference case: "Anterior cervical discectomy & fusion
    // (ACDF)" resolves to SPINAL_FUSION, and the first draft of the table
    // excluded radiculopathy from fusion — so the panel called a documented
    // cervical radiculopathy "not an indication" for the operation most
    // clearly offered for it.
    const acdf = resolveIntervention({ service: "Anterior cervical discectomy & fusion (ACDF)" }).id;
    expect(acdf).toBe("SPINAL_FUSION");
    expect(indicationFor("M5412; Radiculopathy, cervical region", acdf).verdict).toBe("INDICATED");
    expect(indicationFor("Cervical Disc Disorder with Radiculopathy M50.10", acdf).verdict).toBe("INDICATED");
  });

  it("reads a long chronic-pain phrase as chronic pain", () => {
    // "Chronic cervical, thoracic, and lumbar pain" puts thirty characters
    // between the two words; a fixed 20-character window read the whole phrase
    // as naming no clinical concept at all.
    expect(classifyDiagnosis("Chronic cervical, thoracic, and lumbar pain with tailbone-region pain and functional limitation"))
      .toEqual(expect.arrayContaining(["CHRONIC_PAIN", "FUNCTIONAL_DEPENDENCE"]));
  });
});

describe("every indication names the guideline that pairs the diagnosis with the procedure", () => {
  it("cites the guideline written about that diagnosis", () => {
    // NASS writes about "lumbar disc herniation with radiculopathy"; that
    // document is where discectomy is discussed. The pairing is the
    // guideline's, not the table author's.
    const r = indicationFor("L4-5 disc herniation with radiculopathy", "DISCECTOMY");
    expect(r.verdict).toBe("INDICATED");
    expect(r.basis).not.toBeNull();
    expect(r.basis).toMatchObject({ sourceId: "nass", namedDiagnosis: expect.stringMatching(/disc herniation with radiculopathy/i) });
  });

  it("cites ASIPP's axial/radicular split, which is why these two rows differ", () => {
    expect(indicationFor("lumbar facet arthropathy", "RADIOFREQUENCY_ABLATION").basis).toMatchObject({ sourceId: "asipp" });
    expect(indicationFor("lumbar radiculopathy", "EPIDURAL_STEROID").basis).toMatchObject({ sourceId: "nass" });
  });

  it("cites CDC for opioids and AAOS for knee arthroplasty", () => {
    expect(indicationFor("chronic low back pain", "OPIOID").basis).toMatchObject({ sourceId: "cdc-opioid" });
    expect(indicationFor("right knee osteoarthritis", "ARTHROPLASTY").basis).toMatchObject({ sourceId: "aaos" });
  });

  it("says CONVENTION where no condition-specific guideline establishes the pairing", () => {
    // Attaching a plausible-sounding guideline to a shower chair is the
    // difference between a citation and a decoration.
    expect(indicationFor("dependent for transfers", "BATHROOM_SAFETY").basis).toBe("CONVENTION");
    expect(indicationFor("dependent for transfers", "ATTENDANT_CARE").basis).toBe("CONVENTION");
  });

  it("prefers a guideline-backed row over a convention row for the same pairing", () => {
    // ORTHOSIS_BRACE has both kinds; a diagnosis matching a guideline-backed
    // concept must cite the guideline.
    expect(indicationFor("burst fracture of the spine", "ORTHOSIS_BRACE").basis).toMatchObject({ sourceId: "odg" });
  });

  it("every cited source is registered in the reference registry", async () => {
    const { SOURCES } = await import("@/lib/references/sources");
    const ids = new Set(SOURCES.map((s) => s.id));
    for (const v of Object.values(INDICATIONS)) {
      if (v === "ANY" || !v) continue;
      for (const r of v) if (r.basis !== "CONVENTION") expect(ids.has(r.basis.sourceId), r.basis.sourceId).toBe(true);
    }
  });

  it("reports honestly that nothing has been verified against a publication yet", async () => {
    const { verificationSummary } = await import("@/lib/engine/diagnosisIndication");
    const v = verificationSummary();
    expect(v.total).toBeGreaterThan(50);
    expect(v.verified).toBe(0);
    expect(v.unverified).toBeGreaterThan(0);
    expect(v.convention).toBeGreaterThan(0);
  });
});
