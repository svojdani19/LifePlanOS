import { describe, it, expect } from "vitest";
import { resolveIntervention, sameIntervention, bundleKey } from "@/lib/engine/serviceOntology";

const svc = (service: string, category?: string) => ({ service, category });

describe("interventions inside one family are distinct concepts", () => {
  // The defect: six coarse families meant an epidural, a medial-branch block,
  // an ablation and a facet injection were one kind of thing and shared each
  // other's evidence.
  it("keeps the interventional-pain procedures apart", () => {
    const ids = ["Lumbar epidural steroid injection", "Lumbar medial branch block", "Lumbar radiofrequency ablation", "Lumbar facet block"]
      .map((s) => resolveIntervention(svc(s)).id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual(["EPIDURAL_STEROID", "MEDIAL_BRANCH_BLOCK", "RADIOFREQUENCY_ABLATION", "FACET_INJECTION"]);
  });

  it("resolves ablation before block, and medial-branch before facet — the words overlap, the meanings do not", () => {
    expect(resolveIntervention(svc("Radiofrequency ablation of lumbar medial branch nerves")).id).toBe("RADIOFREQUENCY_ABLATION");
    expect(resolveIntervention(svc("Diagnostic medial branch block, lumbar facet joints")).id).toBe("MEDIAL_BRANCH_BLOCK");
  });

  it("keeps the spine operations apart", () => {
    expect(resolveIntervention(svc("Lumbar discectomy")).id).toBe("DISCECTOMY");
    expect(resolveIntervention(svc("Lumbar decompression / fusion", "NEUROSURGERY")).id).toBe("SPINAL_FUSION");
    expect(resolveIntervention(svc("Lumbar laminectomy")).id).toBe("LAMINECTOMY_DECOMPRESSION");
    expect(resolveIntervention(svc("Revision total knee arthroplasty")).id).toBe("REVISION_ARTHROPLASTY");
    expect(resolveIntervention(svc("Total knee arthroplasty")).id).toBe("ARTHROPLASTY");
  });
});

describe("identity survives how a human wrote it", () => {
  it("matches abbreviations and spellings of one concept", () => {
    expect(sameIntervention(svc("TKA, right knee"), svc("Right total knee arthroplasty"))).toBe(true);
    expect(sameIntervention(svc("Lumbar ESI"), svc("Lumbar epidural steroid injection"))).toBe(true);
    expect(sameIntervention(svc("EMG/NCV lower extremity"), svc("Electromyography of the lower extremity"))).toBe(true);
  });

  it("does NOT match two regions of the same procedure", () => {
    // Word overlap scored this pair 0.75 and called it a hit.
    expect(sameIntervention(svc("Lumbar epidural steroid injection"), svc("Cervical epidural steroid injection"))).toBe(false);
  });

  it("does not match across laterality when both sides are stated", () => {
    expect(sameIntervention(svc("Left total knee arthroplasty"), svc("Right total knee arthroplasty"))).toBe(false);
    expect(sameIntervention(svc("Total knee arthroplasty"), svc("Right total knee arthroplasty"))).toBe(true);
  });

  it("does not match two different procedures that share words", () => {
    expect(sameIntervention(svc("Lumbar facet block"), svc("Lumbar medial branch block"))).toBe(false);
    // …but surveillance is a STAGE, not a different procedure: an MRI is an
    // MRI whether it answers a new question or monitors a known lesion.
    expect(sameIntervention(svc("Lumbar MRI"), svc("Lumbar MRI surveillance"))).toBe(true);
    expect(resolveIntervention(svc("Lumbar MRI surveillance")).surveillance).toBe(true);
    expect(resolveIntervention(svc("Lumbar MRI w/o contrast")).surveillance).toBe(false);
  });

  it("refuses to match anything it could not classify", () => {
    expect(sameIntervention(svc("Zzz unknown service"), svc("Zzz unknown service"))).toBe(false);
  });
});

describe("split lines collapse onto the concept a planner published", () => {
  it("gives a base line and its add-on the same bundle key", () => {
    expect(bundleKey(svc("Lumbar radiofrequency ablation"))).toBe(bundleKey(svc("Lumbar RFA — each additional level")));
    expect(resolveIntervention(svc("Lumbar RFA — each additional level")).addOn).toBe(true);
    expect(resolveIntervention(svc("Lumbar radiofrequency ablation")).addOn).toBe(false);
  });

  it("does not collapse different regions into one bundle", () => {
    expect(bundleKey(svc("Lumbar facet block"))).not.toBe(bundleKey(svc("Cervical facet block")));
  });
});

describe("every family the plan can contain is reachable", () => {
  it("classifies one representative service from each family", () => {
    const cases: [string, string][] = [
      ["Orthopedist follow-up visits", "EVALUATION"],
      ["Lumbar MRI w/o contrast", "IMAGING"],
      ["EMG upper extremity", "DIAGNOSTIC_PROCEDURE"],
      ["Physical therapy", "THERAPY"],
      ["Gabapentin 300mg", "MEDICATION"],
      ["Lumbar epidural steroid injection", "INJECTION"],
      ["Lumbar discectomy", "SURGERY"],
      ["Lumbosacral orthosis (LSO brace)", "EQUIPMENT"],
      ["Attendant / home care", "ATTENDANT_CARE"],
      ["Home modification — ramp", "HOME_MODIFICATION"],
      ["Transportation and mileage", "TRANSPORT_COORDINATION"],
      ["Comprehensive metabolic profile", "LAB_MONITORING"],
    ];
    for (const [service, family] of cases) {
      expect(resolveIntervention(svc(service)).family, service).toBe(family);
    }
  });
});

describe("no rule loses to its own word endings", () => {
  // The bug class this table was written with twice: a stem inside \b(...)\b
  // cannot match its own suffix, because the closing boundary falls between
  // two word characters. "Electromyography" missed \belectromyograph\b,
  // "laminectomy" missed \blaminectom\b, "crutches" missed \bcrutch\b.
  // Every inflected form a planner actually writes, asserted at once.
  const forms: [string, string][] = [
    ["Electromyography of the lower extremity", "EMG_NCS"],
    ["Lumbar laminectomy", "LAMINECTOMY_DECOMPRESSION"],
    ["Lumbar microdiscectomy", "DISCECTOMY"],
    ["Lumbar rhizotomy", "RADIOFREQUENCY_ABLATION"],
    ["Radiofrequency ablations, lumbar", "RADIOFREQUENCY_ABLATION"],
    ["Knee arthroscopy", "ARTHROSCOPY"],
    ["Crutches", "MOBILITY_AID"],
    ["Knee braces", "ORTHOSIS_BRACE"],
    ["Custom orthotics", "ORTHOSIS_BRACE"],
    ["Grab bars and shower chair", "BATHROOM_SAFETY"],
    ["Caregivers, 8 hours daily", "ATTENDANT_CARE"],
    ["Assistive technology evaluation", "ASSISTIVE_TECH"],
    ["Follow-up radiographs", "RADIOGRAPH"],
    ["Specialist consultations", "SPECIALIST_FOLLOWUP"],
    ["Facet injections, lumbar", "FACET_INJECTION"],
    ["Epidurals, cervical", "EPIDURAL_STEROID"],
    ["Chiropractic manipulation", "CHIROPRACTIC"],
    ["Aquatic therapy", "AQUATIC_THERAPY"],
    ["Prosthetic replacement", "PROSTHESIS"],
    ["Wheelchairs and cushions", "WHEELCHAIR"],
    ["Hyaluronic acid injection", "VISCOSUPPLEMENTATION"],
    ["Ramps and widening", "HOME_MODIFICATION"],
  ];
  it.each(forms)("resolves %s", (service, expected) => {
    expect(resolveIntervention({ service, category: null }).id).toBe(expected);
  });

  it("leaves nothing in the plan unclassified that a planner would write", () => {
    // A canary: if a new rule is added with a trailing-boundary stem, one of
    // the forms above starts returning UNCLASSIFIED and this fails loudly.
    const unresolved = forms.filter(([s]) => resolveIntervention({ service: s, category: null }).id === "UNCLASSIFIED");
    expect(unresolved.map(([s]) => s)).toEqual([]);
  });
});
