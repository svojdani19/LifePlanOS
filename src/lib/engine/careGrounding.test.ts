// Record grounding for future-care generation. Every fixture is synthetic;
// every expectation mirrors an inflation mode measured on a real draft
// (wheelchairs for ambulatory patients, $211k medication bundles, cervical
// fusion with no cervical recommendation).
import { describe, it, expect } from "vitest";
import {
  severitySupportsCatastrophic,
  surgicalSupport,
  gateTemplateItem,
  documentedMedications,
  mineRecommendedItems,
  citedRationale,
  type CitedText,
  type TimedCitation,
  type RecordCareSupport,
} from "./careGrounding";
import { resolveTemporal, type StatementKind } from "./temporalResolution";

/**
 * A citation as the loader produces it: cited AND placed in time. Fixtures go
 * through the same resolution the real path uses, so a fixture can never claim
 * support the pipeline would refuse.
 */
const cite = (text: string, over: Partial<CitedText> = {}, kind: StatementKind = "RECOMMENDATION"): TimedCitation => {
  const base: CitedText = { text, excerpt: text, filename: "Synthetic MR.pdf", page: 7, date: "2026-03-02", provider: "Dana Rivers, MD", ...over };
  return { ...base, temporal: resolveTemporal({ text: base.text, date: base.date, kind }) };
};
const observed = (text: string, over: Partial<CitedText> = {}) => cite(text, over, "OBSERVATION");

const support = (over: Partial<RecordCareSupport> = {}): RecordCareSupport => ({
  recommendations: [],
  medications: [],
  functionalMarkers: [],
  corpus: "",
  temporallyExcluded: [],
  ...over,
});

describe("severity gate — catastrophic care requires documented dependence", () => {
  it("pain and restrictions alone never support wheelchair-tier items", () => {
    const s = severitySupportsCatastrophic([observed("Chronic low back pain 8/10"), observed("No lifting over 20 pounds"), observed("Modified duty")]);
    expect(s.supported).toBe(false);
  });

  it("documented dependence supports it", () => {
    for (const marker of ["Patient is non-ambulatory", "bed confined, unable to sit", "dependent for ADLs", "maximum assist for transfers"]) {
      expect(severitySupportsCatastrophic([observed(marker)]).supported, marker).toBe(true);
    }
  });

  it("gates the catastrophic categories and passes ordinary care", () => {
    const noSeverity = support({ functionalMarkers: [observed("Chronic pain")] });
    expect(gateTemplateItem({ category: "MOBILITY_AID", service: "Wheelchair & mobility equipment" }, noSeverity).allowed).toBe(false);
    expect(gateTemplateItem({ category: "HOME_MODIFICATION", service: "Home accessibility modifications" }, noSeverity).allowed).toBe(false);
    expect(gateTemplateItem({ category: "CASE_MANAGEMENT", service: "RN medical case management" }, noSeverity).allowed).toBe(false);
    expect(gateTemplateItem({ category: "PHYSICAL_THERAPY", service: "Ongoing physical therapy" }, noSeverity).allowed).toBe(true);
    expect(gateTemplateItem({ category: "PAIN_MANAGEMENT", service: "Pain management visits" }, noSeverity).allowed).toBe(true);
    const withSeverity = support({ functionalMarkers: [observed("Patient is wheelchair dependent for mobility")] });
    expect(gateTemplateItem({ category: "MOBILITY_AID", service: "Wheelchair & mobility equipment" }, withSeverity).allowed).toBe(true);
  });

  it("every suppression carries a reviewable reason", () => {
    const g = gateTemplateItem({ category: "ATTENDANT_CARE", service: "Attendant / home care" }, support());
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/no functional dependence/i);
  });
});

describe("surgical gate — projections never invent operations", () => {
  const lumbarRec = cite("Recommend lumbar decompression surgery at L4-L5.");

  it("a lumbar recommendation grounds lumbar surgery and nothing cervical", () => {
    expect(surgicalSupport("Lumbar decompression / fusion", [lumbarRec]).supported).toBe(true);
    expect(surgicalSupport("Anterior cervical discectomy & fusion (ACDF)", [lumbarRec]).supported).toBe(false);
  });

  it("no recommendation, no surgery — with the reason stated", () => {
    const g = gateTemplateItem({ category: "FUTURE_SURGERY", service: "Lumbar decompression / fusion" }, support());
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/surgical projection requires/);
  });

  it("a grounded surgical item carries its citation", () => {
    const g = gateTemplateItem({ category: "FUTURE_SURGERY", service: "Lumbar decompression / fusion" }, support({ recommendations: [lumbarRec] }));
    expect(g.allowed).toBe(true);
    expect(g.citation?.text).toMatch(/lumbar decompression/i);
  });

  it("revision surgery is held to the same standard", () => {
    expect(gateTemplateItem({ category: "REVISION_SURGERY", service: "Revision lumbar fusion" }, support()).allowed).toBe(false);
    expect(gateTemplateItem({ category: "REVISION_SURGERY", service: "Revision lumbar fusion" }, support({ recommendations: [lumbarRec] })).allowed).toBe(true);
  });
});

describe("documented medications replace the bundle", () => {
  it("extracts distinct maintenance drugs (documented more than once)", () => {
    const meds = documentedMedications([
      observed("Gabapentin 300mg PO TID", { date: "2026-01-15" }),
      observed("Gabapentin (Neurontin) 300 mg three times daily", { date: "2026-03-02" }),
      observed("Ibuprofen 800mg PRN; Methocarbamol 500mg", { date: "2026-01-15" }),
      observed("Ibuprofen 800 mg twice daily", { date: "2026-04-10" }),
      observed("Ondansetron 4mg once (post-op nausea)", { date: "2026-02-01" }), // one date → not maintenance
      observed("Tramadol 50mg", { date: "2026-02-01" }),
      observed("Tramadol 50 mg PRN", { date: "2026-02-01" }), // SAME date twice → one episode, not a regimen
    ]);
    const names = meds.map((m) => m.drug);
    expect(names).toContain("Gabapentin");
    expect(names).toContain("Ibuprofen");
    expect(names).not.toContain("Ondansetron"); // outside injury classes AND single-dated
    expect(names).not.toContain("Tramadol"); // charted twice on ONE date — an episode, not a regimen
    expect(meds.find((m) => m.drug === "Gabapentin")!.occurrences).toBe(2);
    // Methocarbamol appears on one date only → not maintenance.
    expect(names).not.toContain("Methocarbamol");
  });

  it("ignores list-header noise", () => {
    expect(documentedMedications([observed("Medications reviewed with patient"), observed("Current medication list attached")])).toEqual([]);
  });
});

describe("mined recommendations become cited draft items", () => {
  it("maps surgery, injections, and FRP with conservative defaults", () => {
    const mined = mineRecommendedItems(
      [
        cite("Recommend L4-L5 transforaminal epidural steroid injection."),
        cite("Patient is a candidate for functional restoration program."),
      ],
      [],
    );
    const cats = mined.map((m) => m.category);
    expect(cats).toContain("INJECTION");
    expect(cats).toContain("PAIN_MANAGEMENT");
    for (const m of mined) expect(m.citation.filename).toBe("Synthetic MR.pdf");
  });

  it("does not duplicate a surviving template that already covers the ground", () => {
    const mined = mineRecommendedItems([cite("Recommend lumbar epidural steroid injection.")], ["Lumbar transforaminal epidural steroid injection series"]);
    expect(mined).toEqual([]);
  });

  it("an unmappable recommendation is not invented into a costed line", () => {
    expect(mineRecommendedItems([cite("Recommend follow-up with treating counsel regarding forms.")], [])).toEqual([]);
  });

  it("citations render exemplar-style", () => {
    const r = citedRationale("Documented treating-provider recommendation", cite("Recommend lumbar surgery."));
    expect(r).toMatch(/Dana Rivers, MD/);
    expect(r).toMatch(/\(Synthetic MR\.pdf: p\. 7\)/);
    expect(r).toMatch(/"Recommend lumbar surgery\."/);
  });
});

describe("apportionment: non-injury drugs are not costed", () => {
  it("statins and diabetes agents never become plan items, however well documented", () => {
    const meds = documentedMedications([
      observed("Atorvastatin 40mg daily", { date: "2026-01-01" }),
      observed("Atorvastatin 40mg daily", { date: "2026-03-01" }),
      observed("Metformin 1000mg BID", { date: "2026-01-01" }),
      observed("Metformin 1000mg BID", { date: "2026-03-01" }),
      observed("Insulin glargine 20 units", { date: "2026-01-01" }),
      observed("Insulin glargine 20 units", { date: "2026-02-01" }),
    ]);
    expect(meds).toEqual([]);
  });
});

describe("contingencies are not costed", () => {
  it("conditional and hypothetical recommendations are skipped by mining", () => {
    const mined = mineRecommendedItems(
      [
        cite("If surgery occurs sooner, patient will return for post-surgical therapy."),
        cite("Caudal injection noted as a possible option."),
        cite("MRI may be considered if symptoms persist."),
      ],
      [],
    );
    expect(mined).toEqual([]);
  });
});

describe("catastrophic CONTENT is severity-gated regardless of category", () => {
  it("an SCI complication package needs documented dependence even under a benign category", () => {
    const g = gateTemplateItem(
      { category: "COMPLICATION_MANAGEMENT", service: "Management of pressure injury / UTI episodes", rationale: "Recurrent complications common to SCI." },
      support({ functionalMarkers: [observed("Chronic low back pain")], recommendations: [cite("Recommend lumbar surgery.")] }),
    );
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/presupposes major neurological injury/);
  });

  it("mining requires prescriptive language, not mere mention", () => {
    expect(mineRecommendedItems([cite("Patient instructed to stop taking all OTC medications prior to surgery.")], [])).toEqual([]);
    expect(mineRecommendedItems([cite("Recommend lumbar epidural steroid injection.")], []).length).toBe(1);
  });
});

describe("paperwork recommendations are never care items", () => {
  it("requesting missing records is case administration, not imaging", () => {
    expect(mineRecommendedItems([cite("Recommend requesting any missing records to clarify prior imaging and treatment.")], [])).toEqual([]);
    expect(mineRecommendedItems([cite("Recommend records be obtained from the prior chiropractor.")], [])).toEqual([]);
  });
});

describe("temporal resolution gates the record support", () => {
  it("a surgery the patient already had grounds no future surgery", () => {
    const s = support({ recommendations: [cite("Status post L4-L5 lumbar fusion.")] });
    expect(gateTemplateItem({ category: "FUTURE_SURGERY", service: "Lumbar decompression / fusion" }, s).allowed).toBe(false);
  });

  it("a surgery the patient declined grounds no future surgery", () => {
    const s = support({ recommendations: [cite("Patient declined the recommended lumbar fusion.")] });
    expect(gateTemplateItem({ category: "FUTURE_SURGERY", service: "Lumbar decompression / fusion" }, s).allowed).toBe(false);
  });

  it("an UNDATED recommendation never satisfies a gate, however emphatic", () => {
    const s = support({ recommendations: [cite("Recommend lumbar decompression surgery at L4-L5.", { date: null })] });
    expect(gateTemplateItem({ category: "FUTURE_SURGERY", service: "Lumbar decompression / fusion" }, s).allowed).toBe(false);
  });

  it("an undated dependence marker never grounds catastrophic care", () => {
    const s = support({ functionalMarkers: [observed("Patient is wheelchair dependent for mobility", { date: null })] });
    expect(gateTemplateItem({ category: "MOBILITY_AID", service: "Wheelchair & mobility equipment" }, s).allowed).toBe(false);
  });

  it("a deficit a later note records as resolved stops grounding catastrophic care", () => {
    const s = support({
      functionalMarkers: [
        { ...observed("Wheelchair dependent for all mobility.", { date: "2025-08-01" }), temporal: { status: "CONTRADICTED", reason: "Resolved in a later record.", supportsFutureCare: false } },
      ],
    });
    expect(gateTemplateItem({ category: "MOBILITY_AID", service: "Wheelchair & mobility equipment" }, s).allowed).toBe(false);
  });

  it("a contingent recommendation is not mined into a costed line", () => {
    expect(mineRecommendedItems([cite("If symptoms persist, recommend lumbar epidural steroid injection.")], [])).toEqual([]);
  });

  it("an undated recommendation is not mined into a costed line", () => {
    expect(mineRecommendedItems([cite("Recommend lumbar epidural steroid injection.", { date: null })], [])).toEqual([]);
  });

  it("a discontinued drug is not projected as a regimen", () => {
    const meds = documentedMedications([
      observed("Gabapentin 300mg PO TID", { date: "2026-01-15" }),
      observed("Gabapentin discontinued.", { date: "2026-03-02" }),
    ]);
    expect(meds).toEqual([]);
  });

  it("an undated medication mention never completes the two-date maintenance pair", () => {
    const meds = documentedMedications([
      observed("Gabapentin 300mg PO TID", { date: "2026-01-15" }),
      observed("Gabapentin 300mg PO TID", { date: null }),
    ]);
    expect(meds).toEqual([]);
  });
});

describe("mined items record which quantities the note stated", () => {
  it("a stated frequency and duration are adopted and marked record-stated", () => {
    const [item] = mineRecommendedItems([cite("Recommend physical therapy twice weekly for 12 weeks.")], []);
    expect(item.frequencyPerYear).toBe(104);
    expect(item.durationYears).toBeCloseTo(12 / 52, 5);
    expect(item.stated).toEqual({ frequency: true, duration: true });
  });

  it("an unstated quantity falls back to the planning default and is marked as one", () => {
    const [item] = mineRecommendedItems([cite("Recommend lumbar epidural steroid injection.")], []);
    expect(item.stated).toEqual({ frequency: false, duration: false });
    expect(item.frequencyPerYear).toBe(2); // planning default, not a record figure
  });
});

describe("therapy is prescribed under many names", () => {
  // Matching only "physical therapy" discarded the real recommendations that
  // carried explicit frequencies. Paraphrased from a real record set.
  it("mines active therapy, chiropractic, traction and home health as therapy", () => {
    for (const text of [
      "Referral to active therapy for the lumbar spine twice a week for 4 weeks.",
      "Continue chiropractic care including adjustments and modalities once a week.",
      "Continue lumbar traction twice a week for the next 3 weeks.",
      "Patient would benefit from home health services for PT/OT.",
    ]) {
      const mined = mineRecommendedItems([cite(text)], []);
      expect(mined.map((m) => m.category), text).toContain("PHYSICAL_THERAPY");
    }
  });

  it("the best-evidenced note wins its subject, not whichever came first", () => {
    const mined = mineRecommendedItems(
      [
        cite("Recommend continue lumbar therapy.", { date: "2026-01-01" }),
        cite("Referral to active therapy for the lumbar spine twice a week for 4 weeks.", { date: "2026-01-02" }),
      ],
      [],
    );
    expect(mined).toHaveLength(1);
    expect(mined[0].frequencyPerYear).toBe(104);
    expect(mined[0].stated.frequency).toBe(true);
  });

  it("among equally-evidenced notes the most recent statement governs", () => {
    const mined = mineRecommendedItems(
      [
        cite("Recommend lumbar epidural steroid injection.", { date: "2025-01-01" }),
        cite("Recommend lumbar epidural steroid injection.", { date: "2026-01-01" }),
      ],
      [],
    );
    expect(mined).toHaveLength(1);
    expect(mined[0].citation.date).toBe("2026-01-01");
  });
});
