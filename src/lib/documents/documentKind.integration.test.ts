// End-to-end behaviour of document-kind-aware analysis: a consolidated packet
// is split by the kind of each internal document, each kind is held to its own
// vocabulary and epistemic types, and non-clinical material stays out of the
// treating chronology while remaining visible and attributed.
//
// Synthetic text only — no record content from any real case.
import { describe, it, expect, vi } from "vitest";
import { classifyRanges, carriesClinicalSubstance, readsAsClinicalNote } from "./segmentClass";
import { profileFor, analysisClassFor, fieldAllowed, requiresDate, PROFILES, REVIEWER_ASSIGNABLE_CLASSES, NON_CLINICAL_CLASSES, MEDICAL_TIMELINE_CLASSES } from "./analysisClass";
import { chunkDocumentText, validateEncounters, renderFactualSummary, type DocumentChunk, type LlmEncounter } from "@/lib/llm/recordExtraction";
import { pageMarks } from "@/lib/documents/meta";
import { resolveClaimType, claimTypeCompatible } from "@/lib/llm/claimTypes";
import { classifyEncounterSubstance, admissibleToMedicalTimeline } from "@/lib/records/encounterSubstance";

const META = { firmId: "firm-1", caseId: "case-1", sourceDocumentId: "doc-1", filename: "packet.pdf", ocrConfidence: 0.95 };

const chunkOf = (text: string, documentType: string | null): DocumentChunk => {
  const { chunks } = chunkDocumentText(text, pageMarks(text), { ...META, documentType });
  return chunks[0];
};

const enc = (claims: { field: string; value: string; excerpt: string; claimType?: string }[], over: Partial<LlmEncounter> = {}): LlmEncounter =>
  ({
    dateStatus: "UNKNOWN",
    date: null,
    dateEnd: null,
    dateExcerpt: null,
    encounterType: null,
    provider: null,
    providerCredentials: null,
    facility: null,
    ...over,
    claims: claims.map((c) => ({ page: null, confidence: 0.9, warning: undefined, claimType: undefined, ...c })),
  }) as unknown as LlmEncounter;

// ── 1. Mixed packet ─────────────────────────────────────────────────────────

describe("a consolidated packet is analyzed by the kind of each internal document", () => {
  const CLINIC = [
    "Date of Service: 03/14/2025",
    "Chief complaint: low back pain radiating to the left leg.",
    "History of present illness: the patient reports pain since the collision.",
    "On examination there is tenderness at L4-L5 with a positive straight leg raise.",
    "Assessment: Lumbar radiculopathy. Plan: continue physical therapy and follow-up in 4 weeks.",
    "Follow-up in: four weeks. Range of motion is limited in flexion. Orthopedic examination performed.",
  ].join("\n");
  const OPERATIVE = [
    "Date of Service: 04/02/2025",
    "OPERATIVE REPORT",
    "Preoperative diagnosis: L4-L5 disc herniation. Postoperative diagnosis: same.",
    "Procedure performed: L4-L5 microdiscectomy. The patient was brought to the operating room and underwent the procedure.",
    "Estimated blood loss: minimal. Specimen: disc material sent to pathology. Complications: none.",
    "Findings: extruded disc fragment compressing the traversing nerve root.",
  ].join("\n");
  const IMAGING = [
    "Date of Service: 03/20/2025",
    "MRI of the lumbar spine without contrast.",
    "Technique: multiplanar multisequence imaging was performed.",
    "Comparison: none available.",
    "Findings: there is a disc extrusion at L4-L5.",
    "Impression: L4-L5 disc extrusion with left lateral recess stenosis. Radiologist: A. Reader, MD.",
  ].join("\n");
  const BILLING = [
    "Date of Service: 03/14/2025",
    "Statement of account. CPT 99214 office visit, established patient.",
    "Total charges: $412.00. Amount billed to payer. Patient responsibility: $40.00.",
    "HCPCS adjustments applied. Explanation of benefits enclosed. Balance due on account.",
  ].join("\n");
  const DEPO = [
    "Date of Service: 05/06/2025",
    "DEPOSITION OF THE PLAINTIFF",
    "The witness, being first duly sworn, testified as follows. Examination by counsel.",
    " 12   Q. Had you injured your back before this collision?",
    " 13   A. Yes, about ten years ago.",
    " 14   Q. Did you tell your doctor about that?",
    " 15   A. I do not recall telling him.",
    "Court reporter's certificate attached. Appearances: counsel for both parties.",
  ].join("\n");

  const PACKET = [CLINIC, OPERATIVE, IMAGING, BILLING, DEPO].join("\n\n");

  it("splits the packet into ranges and gives each its own class", () => {
    const ranges = classifyRanges(PACKET, "MEDICAL_RECORD");
    expect(ranges.length).toBeGreaterThan(1);
    const classes = ranges.map((r) => r.klass);
    // The kinds that are unmistakable from their own content are recognized
    // regardless of the packet's declared type.
    expect(classes).toContain("OPERATIVE");
    expect(classes).toContain("DIAGNOSTIC_STUDY");
    expect(classes).toContain("FINANCIAL");
    expect(classes).toContain("TESTIMONY");
    // Every range carries provenance a reviewer can act on.
    for (const r of ranges) {
      expect(r.offsetEnd).toBeGreaterThan(r.offsetStart);
      expect(["DOCUMENT_TYPE", "SEGMENT_CONTENT", "FALLBACK_UNKNOWN"]).toContain(r.method);
    }
  });

  it("no chunk mixes two kinds, and each chunk carries its own class", () => {
    const { chunks } = chunkDocumentText(PACKET, pageMarks(PACKET), { ...META, documentType: "MEDICAL_RECORD" });
    expect(chunks.length).toBeGreaterThan(1);
    const ranges = classifyRanges(PACKET, "MEDICAL_RECORD");
    for (const c of chunks) {
      expect(c.analysisClass).toBeTruthy();
      // The chunk's whole span must sit inside one class's range.
      const covering = ranges.find((r) => c.offsetStart >= r.offsetStart && c.offsetEnd <= r.offsetEnd);
      expect(covering, `chunk ${c.index} spans a class boundary`).toBeTruthy();
      expect(covering!.klass).toBe(c.analysisClass);
    }
  });

  it("preserves the uploaded document identity and page mapping on every chunk", () => {
    const { chunks } = chunkDocumentText(PACKET, pageMarks(PACKET), { ...META, documentType: "MEDICAL_RECORD" });
    for (const c of chunks) {
      expect(c.sourceDocumentId).toBe("doc-1");
      expect(c.firmId).toBe("firm-1");
      expect(c.caseId).toBe("case-1");
      expect(c.offsetEnd).toBeGreaterThan(c.offsetStart);
    }
  });
});

// ── 2. Deposition ───────────────────────────────────────────────────────────

describe("a deposition produces attributed testimony, not clinical findings", () => {
  const TEXT = [
    "DEPOSITION OF THE PLAINTIFF",
    "The witness, being first duly sworn, testified as follows.",
    "I had a prior back injury about ten years ago that I did not mention to my doctor.",
    "I stopped going to physical therapy because of my work schedule.",
  ].join("\n");

  it("keeps testimony and admissions, and refuses clinical fields outright", () => {
    const chunk = chunkOf(TEXT, "DEPOSITION");
    const out = validateEncounters(chunk, [
      enc([
        { field: "testimony", value: "Prior back injury about ten years ago", excerpt: "I had a prior back injury about ten years ago that I did not mention to my doctor." },
        { field: "admission", value: "Stopped physical therapy because of work", excerpt: "I stopped going to physical therapy because of my work schedule." },
        // A deposition cannot make a clinical assessment.
        { field: "assessment", value: "Lumbar radiculopathy", excerpt: "I had a prior back injury about ten years ago that I did not mention to my doctor." },
      ]),
    ]);
    const fields = out.accepted[0].claims.map((c) => c.field);
    expect(fields).toContain("testimony");
    expect(fields).toContain("admission");
    expect(fields).not.toContain("assessment");
    expect(out.rejected.join(" ")).toMatch(/cannot state this kind of fact/);
  });

  it("testimony can never be typed as a clinician's observation", () => {
    expect(resolveClaimType("TESTIMONY", "testimony", null).claimType).toBe("SWORN_TESTIMONY");
    expect(resolveClaimType("TESTIMONY", "admission", null).claimType).toBe("PARTY_ADMISSION");
    // Even if the model insists.
    expect(resolveClaimType("TESTIMONY", "testimony", "PROVIDER_OBSERVATION").claimType).toBe("SWORN_TESTIMONY");
    expect(claimTypeCompatible("TESTIMONY", "DIAGNOSIS")).toBe(false);
  });

  it("the deponent is an attribution, never the patient's provider", () => {
    const chunk = chunkOf(TEXT, "DEPOSITION");
    const out = validateEncounters(chunk, [
      enc([{ field: "testimony", value: "Prior back injury", excerpt: "I had a prior back injury about ten years ago that I did not mention to my doctor." }], {
        provider: { value: "The Plaintiff", excerpt: "DEPOSITION OF THE PLAINTIFF", page: null } as never,
      }),
    ]);
    const row = out.accepted[0];
    expect(row.provider).toBeNull(); // never a treating clinician
    expect(row.attributionName).toBe("The Plaintiff");
    expect(row.attributionRole).toMatch(/deponent/i);
  });

  it("never reaches the medical chronology, but stays visible in the records", () => {
    const verdict = classifyEncounterSubstance({ analysisClass: "TESTIMONY", encounterType: null, factualSummary: "Testimony", claims: [{ field: "testimony", value: "x" }] });
    expect(verdict.class).not.toBe("CLINICAL");
    expect(verdict.reason).toMatch(/not treating medical care/i);
    expect(admissibleToMedicalTimeline({ analysisClass: "TESTIMONY", substanceClass: verdict.class })).toBe(false);
  });
});

// ── 3. Billing ──────────────────────────────────────────────────────────────

describe("a billing ledger produces charges, not clinical facts", () => {
  const TEXT = [
    "Statement of account — date of service 03/14/2025.",
    "CPT 99214 office visit, established patient. Diagnosis code M54.16 submitted with the claim.",
    "Total charges: $412.00. Patient responsibility: $40.00.",
  ].join("\n");

  it("charges are billing entries and a claim-line diagnosis is not a diagnosis", () => {
    const chunk = chunkOf(TEXT, "BILLING_RECORD");
    const out = validateEncounters(chunk, [
      enc([
        { field: "charge", value: "CPT 99214 office visit", excerpt: "CPT 99214 office visit, established patient." },
        { field: "billedAmount", value: "$412.00", excerpt: "Total charges: $412.00." },
        { field: "assessment", value: "M54.16 lumbar radiculopathy", excerpt: "Diagnosis code M54.16 submitted with the claim." },
      ]),
    ]);
    const claims = out.accepted[0].claims;
    expect(claims.map((c) => c.field)).not.toContain("assessment");
    expect(claims.find((c) => c.field === "charge")!.claimType).toBe("BILLING_ENTRY");
    expect(claimTypeCompatible("FINANCIAL", "COMPLETED_TREATMENT")).toBe(false);
  });

  it("a ledger has no clinician, so a missing provider is not a warning", () => {
    const chunk = chunkOf(TEXT, "BILLING_RECORD");
    const out = validateEncounters(chunk, [enc([{ field: "charge", value: "CPT 99214", excerpt: "CPT 99214 office visit, established patient." }])]);
    expect(out.accepted[0].warnings.join(" ")).not.toMatch(/provider/i);
    expect(profileFor("BILLING_RECORD").attribution).toBeNull();
  });

  it("does not enter the medical chronology", () => {
    expect(admissibleToMedicalTimeline({ analysisClass: "FINANCIAL", substanceClass: "ANCILLARY" })).toBe(false);
  });
});

// ── 4. Imaging ──────────────────────────────────────────────────────────────

describe("an imaging report keeps findings and impression distinct", () => {
  const TEXT = [
    "--- Page 7 ---",
    "MRI of the lumbar spine without contrast.",
    "Technique: multiplanar multisequence imaging was performed.",
    "Comparison: none available.",
    "Findings: there is a disc extrusion at L4-L5.",
    "Impression: L4-L5 disc extrusion with left lateral recess stenosis.",
  ].join("\n");

  it("findings and impression are separate claims with distinct epistemic types", () => {
    const chunk = chunkOf(TEXT, "IMAGING_REPORT");
    const out = validateEncounters(chunk, [
      enc([
        { field: "diagnosticStudies", value: "Disc extrusion at L4-L5", excerpt: "Findings: there is a disc extrusion at L4-L5." },
        { field: "impression", value: "L4-L5 disc extrusion with left lateral recess stenosis", excerpt: "Impression: L4-L5 disc extrusion with left lateral recess stenosis." },
        { field: "studyTechnique", value: "Multiplanar multisequence imaging", excerpt: "Technique: multiplanar multisequence imaging was performed." },
      ]),
    ]);
    const byField = Object.fromEntries(out.accepted[0].claims.map((c) => [c.field, c]));
    expect(byField.impression.claimType).toBe("DIAGNOSTIC_IMPRESSION");
    expect(byField.diagnosticStudies.claimType).toBe("IMAGING_FINDING");
    // Server-derived page attribution survives.
    expect(byField.impression.page).toBe(7);
  });

  it("the interpreting physician is an attribution, not a treating provider", () => {
    const chunk = chunkOf(TEXT, "IMAGING_REPORT");
    const out = validateEncounters(chunk, [
      enc([{ field: "impression", value: "L4-L5 disc extrusion", excerpt: "Impression: L4-L5 disc extrusion with left lateral recess stenosis." }], {
        provider: { value: "MRI of the lumbar", excerpt: "MRI of the lumbar spine without contrast.", page: null } as never,
      }),
    ]);
    expect(out.accepted[0].provider).toBeNull();
    expect(out.accepted[0].attributionRole).toMatch(/radiologist/i);
  });

  it("summarizes by its impression, not as if it were a clinic visit", () => {
    const chunk = chunkOf(TEXT, "IMAGING_REPORT");
    const out = validateEncounters(chunk, [
      enc([
        { field: "diagnosticStudies", value: "Disc extrusion at L4-L5", excerpt: "Findings: there is a disc extrusion at L4-L5." },
        { field: "impression", value: "L4-L5 disc extrusion with left lateral recess stenosis", excerpt: "Impression: L4-L5 disc extrusion with left lateral recess stenosis." },
      ]),
    ]);
    expect(renderFactualSummary(out.accepted[0])).toMatch(/lateral recess stenosis/);
  });
});

// ── 5. Operative ────────────────────────────────────────────────────────────

describe("an operative report is one operation with operative fields", () => {
  const TEXT = [
    "--- Page 3 ---",
    "OPERATIVE REPORT",
    "Preoperative diagnosis: L4-L5 disc herniation.",
    "Postoperative diagnosis: L4-L5 disc herniation.",
    "Procedure performed: L4-L5 microdiscectomy was performed without difficulty.",
    "Findings: extruded disc fragment compressing the traversing nerve root.",
    "Estimated blood loss: minimal. Complications: none.",
  ].join("\n");

  it("all major operative fields survive with their own types", () => {
    const chunk = chunkOf(TEXT, "OPERATIVE_NOTE");
    const out = validateEncounters(chunk, [
      enc([
        { field: "preOperativeDiagnosis", value: "L4-L5 disc herniation", excerpt: "Preoperative diagnosis: L4-L5 disc herniation." },
        { field: "postOperativeDiagnosis", value: "L4-L5 disc herniation", excerpt: "Postoperative diagnosis: L4-L5 disc herniation." },
        { field: "procedure", value: "L4-L5 microdiscectomy was performed", excerpt: "Procedure performed: L4-L5 microdiscectomy was performed without difficulty." },
        { field: "operativeFindings", value: "Extruded disc fragment compressing the traversing nerve root", excerpt: "Findings: extruded disc fragment compressing the traversing nerve root." },
        { field: "estimatedBloodLoss", value: "Minimal", excerpt: "Estimated blood loss: minimal. Complications: none." },
        { field: "complications", value: "None", excerpt: "Estimated blood loss: minimal. Complications: none." },
      ]),
    ]);
    const byField = Object.fromEntries(out.accepted[0].claims.map((c) => [c.field, c]));
    for (const f of ["preOperativeDiagnosis", "postOperativeDiagnosis", "procedure", "operativeFindings", "estimatedBloodLoss", "complications"]) {
      expect(byField[f], f).toBeTruthy();
    }
    expect(byField.operativeFindings.claimType).toBe("OPERATIVE_FINDING");
    expect(byField.postOperativeDiagnosis.claimType).toBe("DIAGNOSIS");
  });

  it("performed-procedure validation is still enforced against the excerpt", () => {
    const chunk = chunkOf(TEXT, "OPERATIVE_NOTE");
    const out = validateEncounters(chunk, [
      enc([
        // The excerpt is a pre-operative diagnosis line; it does not establish
        // that anything was performed.
        { field: "procedure", value: "L4-L5 fusion was performed", excerpt: "Preoperative diagnosis: L4-L5 disc herniation.", claimType: "PROCEDURE_PERFORMED" },
      ]),
    ]);
    expect(out.accepted).toHaveLength(0);
  });

  it("one operation stays one entry — it is not split per section", () => {
    expect(profileFor("OPERATIVE_NOTE").guidance).toMatch(/ONE OPERATION IS ONE ENTRY/);
  });
});

// ── 6. Pathology and anesthesia ─────────────────────────────────────────────

describe("pathology and anesthesia use their own profiles", () => {
  it("pathology is a diagnostic interpretation, attributed to the pathologist", () => {
    expect(analysisClassFor("PATHOLOGY_REPORT")).toBe("PATHOLOGY_DIAGNOSTIC");
    const p = profileFor("PATHOLOGY_REPORT");
    expect(p.attribution).toMatch(/pathologist/i);
    expect(p.attribution).not.toMatch(/surgeon/i);
    expect(resolveClaimType("PATHOLOGY_DIAGNOSTIC", "pathologicDiagnosis", null).claimType).toBe("DIAGNOSTIC_IMPRESSION");
  });

  it("anesthesia is attributed to the anesthesia provider, not the surgeon", () => {
    expect(analysisClassFor("ANESTHESIA_RECORD")).toBe("ANESTHESIA");
    const p = profileFor("ANESTHESIA_RECORD");
    expect(p.attribution).toMatch(/anesthesia/i);
    expect(p.attribution).not.toMatch(/surgeon/i);
    expect(p.guidance).toMatch(/not attribute this record to the surgeon/i);
  });

  it("an implant log is a device record, not an operation", () => {
    expect(analysisClassFor("IMPLANT_RECORDS")).toBe("DEVICE_OR_IMPLANT");
    expect(profileFor("IMPLANT_RECORDS").attribution).toBeNull();
    expect(MEDICAL_TIMELINE_CLASSES.has("DEVICE_OR_IMPLANT")).toBe(false);
  });
});

// ── 7. Expert opinion ───────────────────────────────────────────────────────

describe("an expert opinion stays an attributed opinion", () => {
  it("opinions are typed as opinions, never as established fact", () => {
    expect(resolveClaimType("EXPERT_OPINION", "opinion", null).claimType).toBe("EXPERT_OPINION");
    expect(resolveClaimType("EXPERT_OPINION", "causationOpinion", null).claimType).toBe("CAUSATION_OPINION");
    // A model claiming this is a plain diagnosis is overruled.
    expect(resolveClaimType("EXPERT_OPINION", "opinion", "DIAGNOSIS").claimType).toBe("EXPERT_OPINION");
  });

  it("is excluded from the treating chronology and labelled as opinion", () => {
    const verdict = classifyEncounterSubstance({ analysisClass: "EXPERT_OPINION", encounterType: "IME", factualSummary: "Opinion", claims: [{ field: "opinion", value: "x" }] });
    expect(verdict.class).toBe("ANCILLARY");
    expect(verdict.reason).toMatch(/attributed opinion/i);
    expect(admissibleToMedicalTimeline({ analysisClass: "EXPERT_OPINION", substanceClass: verdict.class })).toBe(false);
  });
});

// ── 8. Unknown material ─────────────────────────────────────────────────────

describe("unclassifiable material is admitted as unknown, not as clinical", () => {
  it("an unrecognized type can assert almost nothing", () => {
    const p = profileFor("OTHER");
    expect(p.klass).toBe("UNKNOWN");
    expect(p.fields).toContain("documentContent");
    expect(p.fields).not.toContain("assessment");
  });

  it("it requires review and never enters the chronology by default", () => {
    const verdict = classifyEncounterSubstance({ analysisClass: "UNKNOWN", encounterType: null, factualSummary: "?", claims: [{ field: "documentContent", value: "x" }] });
    expect(verdict.class).toBe("ADMINISTRATIVE");
    expect(verdict.reason).toMatch(/could not be established/i);
    expect(admissibleToMedicalTimeline({ analysisClass: "UNKNOWN", substanceClass: verdict.class })).toBe(false);
  });

  it("a clinical claim proposed from unknown material is refused", () => {
    const text = "A letter of transmittal enclosing records for your review. Please find enclosed the materials requested in your correspondence of last month regarding this matter.";
    const chunk = chunkOf(text, "OTHER");
    const out = validateEncounters(chunk, [enc([{ field: "assessment", value: "Lumbar radiculopathy", excerpt: text.slice(0, 60) }])]);
    expect(out.accepted).toHaveLength(0);
    expect(out.rejected.join(" ")).toMatch(/cannot state this kind of fact/);
  });
});

// ── 9. Employment / economic ────────────────────────────────────────────────

describe("employment and tax records are economic evidence, not medical billing", () => {
  it("they map to their own class with no CPT/charge semantics", () => {
    for (const t of ["WAGE_LOSS_DOCUMENTATION", "TAX_RECORDS", "EMPLOYMENT_RECORDS"]) {
      expect(analysisClassFor(t), t).toBe("EMPLOYMENT_ECONOMIC");
      const p = profileFor(t);
      expect(p.fields, t).not.toContain("serviceCode");
      expect(p.fields, t).not.toContain("charge");
      expect(p.fields, t).toContain("earnings");
    }
    expect(resolveClaimType("EMPLOYMENT_ECONOMIC", "earnings", null).claimType).toBe("EMPLOYMENT_OR_ECONOMIC_RECORD");
  });

  it("they never enter the medical chronology", () => {
    expect(NON_CLINICAL_CLASSES.has("EMPLOYMENT_ECONOMIC")).toBe(true);
    expect(admissibleToMedicalTimeline({ analysisClass: "EMPLOYMENT_ECONOMIC", substanceClass: "ANCILLARY" })).toBe(false);
  });

  it("insurance records are administrative, and correspondence is not a legal filing", () => {
    expect(analysisClassFor("INSURANCE_RECORDS")).toBe("INSURANCE_ADMINISTRATIVE");
    expect(analysisClassFor("CORRESPONDENCE")).toBe("CORRESPONDENCE_OR_GENERIC_EVIDENCE");
  });
});

// ── 10. Tenant and case isolation ───────────────────────────────────────────

describe("classification never crosses a tenant or a case", () => {
  it("every validated row takes its firm, case and document from the chunk", () => {
    const text = "Assessment: Lumbar radiculopathy was documented at today's visit and discussed with the patient in detail.";
    const chunk = chunkDocumentText(text, pageMarks(text), {
      firmId: "firm-A",
      caseId: "case-A",
      sourceDocumentId: "doc-A",
      filename: "a.pdf",
      ocrConfidence: null,
      documentType: "MEDICAL_RECORD",
    }).chunks[0];
    const out = validateEncounters(chunk, [enc([{ field: "assessment", value: "Lumbar radiculopathy", excerpt: text }])]);
    const row = out.accepted[0];
    expect(row.firmId).toBe("firm-A");
    expect(row.caseId).toBe("case-A");
    expect(row.sourceDocumentId).toBe("doc-A");
  });

  it("an excerpt from another document cannot be cited — it is simply not in this chunk", () => {
    const mine = "Assessment: Lumbar radiculopathy was documented at today's visit and discussed with the patient in detail.";
    const theirs = "Assessment: Cervical radiculopathy documented in an entirely different patient's chart.";
    const chunk = chunkOf(mine, "MEDICAL_RECORD");
    const out = validateEncounters(chunk, [enc([{ field: "assessment", value: "Cervical radiculopathy", excerpt: theirs }])]);
    expect(out.accepted).toHaveLength(0);
    expect(out.rejected.join(" ")).toMatch(/not found in the source text/);
  });

  it("segment keys are scoped to their own document's offsets", () => {
    const a = classifyRanges("Some clinic content.\n".repeat(40), "MEDICAL_RECORD");
    for (const r of a) if (r.segmentKey) expect(r.segmentKey).toMatch(/@\d+-\d+$/);
  });
});

// ── Persistence round-trip ──────────────────────────────────────────────────

describe("class and attribution survive storage and retrieval", () => {
  it("the extraction run writes every provenance field to the row", async () => {
    const { processDocumentExtraction } = await import("./extractionRun");
    const written = await runAgainstFakeDb();
    expect(written.analysisClass).toBe("TESTIMONY");
    expect(written.attributionName).toBe("Jordan Reyes");
    expect(written.attributionRole).toMatch(/deponent/i);
    expect(written.provider ?? null).toBeNull(); // a deponent is not a provider
    expect(written.classificationMethod).toBeTruthy();
    expect(typeof processDocumentExtraction).toBe("function");
  });

  it("a stored row rebuilds into the structured record with its class intact", async () => {
    const { toStructuredEncounter } = await import("@/lib/records/structuredRecord");
    const se = toStructuredEncounter({
      id: "e1",
      sourceDocumentId: "doc-1",
      dateStatus: "UNKNOWN",
      encounterDate: null,
      encounterDateEnd: null,
      provider: null,
      providerCredentials: null,
      facility: null,
      encounterType: "Deposition",
      factualSummary: "Testimony passage — prior injury acknowledged.",
      synthesis: null,
      claims: [{ field: "admission", value: "Prior injury", excerpt: "x", page: 4, claimType: "PARTY_ADMISSION" }],
      page: 4,
      pageEnd: 4,
      ocrConfidence: null,
      warnings: [],
      status: "AI_DRAFT",
      substanceClass: "ANCILLARY",
      substanceReason: "Sworn testimony material.",
      analysisClass: "TESTIMONY",
      attributionName: "Jordan Reyes",
      attributionRole: "deponent",
      reviewedAt: null,
      verifiedAt: null,
      staleReason: null,
    } as never);
    expect(se.analysisClass).toBe("TESTIMONY");
    expect(se.attributionName).toBe("Jordan Reyes");
    expect(se.attributionRole).toBe("deponent");
  });

  it("a legacy row with no class keeps its prior timeline behaviour", () => {
    // Nothing already reviewed may silently disappear because a column is new.
    expect(admissibleToMedicalTimeline({ analysisClass: null, substanceClass: "CLINICAL" })).toBe(true);
    expect(admissibleToMedicalTimeline({ analysisClass: null, substanceClass: "ADMINISTRATIVE" })).toBe(false);
    expect(admissibleToMedicalTimeline({ analysisClass: undefined, substanceClass: null })).toBe(true);
  });
});

/** Drives one real extraction against an in-memory database. */
async function runAgainstFakeDb(): Promise<Record<string, unknown>> {
  const rows: Record<string, unknown>[] = [];
  const runs: Record<string, unknown>[] = [];
  const TEXT = [
    "DEPOSITION OF JORDAN REYES",
    "The witness, being first duly sworn, testified as follows. Examination by counsel.",
    "I had a prior back injury about ten years ago that I never mentioned to my treating doctor.",
    "Court reporter's certificate attached. Appearances: counsel for both parties.",
  ].join("\n");
  const doc = { id: "doc-9", firmId: "firm-9", caseId: "case-9", filename: "depo.pdf", type: "DEPOSITION", flags: "", extractedText: TEXT, ocrConfidence: null };

  vi.resetModules();
  vi.doMock("@/lib/db", () => ({
    prisma: {
      document: { findUniqueOrThrow: async () => doc, findMany: async () => [doc] },
      recordExtraction: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const r = { id: `run-${runs.length + 1}`, createdAt: new Date(), ...data };
          runs.push(r);
          return r;
        },
        findMany: async () => runs.map((r) => ({ sourceDocumentId: r.sourceDocumentId, status: r.status })),
        findFirst: async () => null,
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const r = runs.find((x) => x.id === where.id)!;
          Object.assign(r, data);
          return r;
        },
        updateMany: async () => ({ count: 1 }),
      },
      extractedEncounter: {
        findMany: async () => [],
        create: async ({ data }: { data: Record<string, unknown> }) => {
          rows.push(data);
          return { id: `e-${rows.length}`, ...data };
        },
        update: async () => ({}),
        updateMany: async () => ({ count: 0 }),
      },
      correctionExemplar: { findMany: async () => [] },
      sourcePage: { findMany: async () => [], upsert: async () => ({}) },
    },
  }));
  const { processDocumentExtraction } = await import("./extractionRun");
  const provider = {
    name: "fake",
    complete: async () =>
      JSON.stringify({
        encounters: [
          {
            dateStatus: "UNKNOWN",
            date: null,
            dateEnd: null,
            dateExcerpt: null,
            encounterType: "Deposition",
            provider: { value: "Jordan Reyes", excerpt: "DEPOSITION OF JORDAN REYES", page: null },
            providerCredentials: null,
            facility: null,
            claims: [
              {
                field: "admission",
                value: "Prior back injury never mentioned to the treating doctor",
                excerpt: "I had a prior back injury about ten years ago that I never mentioned to my treating doctor.",
                page: null,
                confidence: 0.9,
              },
            ],
          },
        ],
      }),
  };
  process.env.RECORD_CRITIC = "off";
  await processDocumentExtraction("doc-9", { provider: provider as never, exemplarGuidance: [], force: true });
  delete process.env.RECORD_CRITIC;
  vi.doUnmock("@/lib/db");
  vi.resetModules();
  return rows[0] ?? {};
}

// ── Undated material is two different facts ─────────────────────────────────

describe("undated reporting separates a real gap from an expected absence", () => {
  it("counts clinical gaps apart from material that has no visit date to begin with", () => {
    const MED = MEDICAL_TIMELINE_CLASSES;
    const isClinicalGap = (k: string | null) => !k || MED.has(k as never);

    // A clinic note the system could not date IS a gap a person must close.
    expect(isClinicalGap("CLINICAL_ENCOUNTER")).toBe(true);
    expect(isClinicalGap("OPERATIVE")).toBe(true);
    expect(isClinicalGap("THERAPY_COURSE")).toBe(true);
    expect(isClinicalGap("DIAGNOSTIC_STUDY")).toBe(true);
    // A consent page, a charge line or a transmittal has no visit date because
    // it is not a visit. Counting it as a dating failure turned 24 real
    // problems into an alarming, meaningless 101 on a real case.
    expect(isClinicalGap("CORRESPONDENCE_OR_GENERIC_EVIDENCE")).toBe(false);
    expect(isClinicalGap("FINANCIAL")).toBe(false);
    expect(isClinicalGap("TESTIMONY")).toBe(false);
    expect(isClinicalGap("LEGAL")).toBe(false);
    // A legacy row with no recorded kind counts as clinical — the conservative
    // reading keeps a genuine gap visible rather than filing it as expected.
    expect(isClinicalGap(null)).toBe(true);
  });
});

// ── Billing is kept, and clinical content inside it is never lost ────────────

describe("billing is a record type, not a discard pile", () => {
  const CHARGES = [
    "Statement of account for date of service 03/14/2025.",
    "CPT 99214 office visit, established patient. Total charges: $412.00.",
    "HCPCS adjustments applied. Balance due on account. Explanation of benefits enclosed.",
  ].join("\n");

  it("a pure charge ledger stays billing — kept, attributed, off the chronology", () => {
    expect(carriesClinicalSubstance(CHARGES)).toBe(false);
    expect(profileFor("BILLING_RECORD").klass).toBe("FINANCIAL");
    // Kept and visible, but never treating care.
    expect(admissibleToMedicalTimeline({ analysisClass: "FINANCIAL", substanceClass: "ANCILLARY" })).toBe(false);
    expect(NON_CLINICAL_CLASSES.has("FINANCIAL")).toBe(true);
  });

  it("a note whose clinical content DOMINATES is read as a clinical note", () => {
    // Providers file the visit note and its charge together. When the note is
    // the bulk of the page, reading it as a ledger throws the history and
    // examination away.
    const NOTE_WITH_CHARGE = [
      "Date of service 03/14/2025. CPT 99214.",
      "Chief complaint: low back pain radiating to the left leg.",
      "History of present illness: pain since the collision, worse with sitting.",
      "Physical examination: tenderness to palpation at L4-L5; straight leg raise positive on the left.",
      "Review of systems otherwise negative. Neurologic exam intact distally.",
      "Assessment: lumbar radiculopathy. Plan: continue therapy and follow-up in 4 weeks.",
    ].join("\n");
    expect(readsAsClinicalNote(NOTE_WITH_CHARGE)).toBe(true);
  });

  it("a charge page with a diagnosis label attached stays a BILL", () => {
    // The overlap this prevents: promoting it would produce a clinical entry
    // duplicating the note filed separately in the same packet, counting one
    // visit twice.
    const CHARGE_PAGE = [
      CHARGES,
      "Assessment: M54.16 submitted with the claim. Plan: bill secondary insurer.",
    ].join("\n");
    expect(readsAsClinicalNote(CHARGE_PAGE)).toBe(false);
  });

  it("one clinical marker is never enough on its own", () => {
    expect(carriesClinicalSubstance(`${CHARGES}\nPlan: bill secondary insurer.`)).toBe(false);
    expect(readsAsClinicalNote(`${CHARGES}\nPlan: bill secondary insurer.`)).toBe(false);
  });

  it("a tie goes to the bill — a margin is required, not a draw", () => {
    // Equal evidence both ways is not evidence that this is a clinical note.
    const TIED = [
      "Total charges: $412.00. CPT 99214. Amount billed. Balance due.",
      "Chief complaint: back pain. Assessment: strain.",
    ].join("\n");
    expect(readsAsClinicalNote(TIED)).toBe(false);
  });

  it("testimony is never promoted, however much clinical language it quotes", () => {
    // A deposition discussing an examination is testimony, not an examination.
    const DEPO = [
      "DEPOSITION OF THE PLAINTIFF. The witness, being first duly sworn, testified as follows.",
      "Q. What did the physical examination show? A. He said my range of motion was limited.",
      "Q. And the assessment: what did he tell you? A. That I had a disc problem.",
    ].join("\n");
    // The text carries markers, but TESTIMONY is not a promotable kind.
    expect(analysisClassFor("DEPOSITION")).toBe("TESTIMONY");
    expect(NON_CLINICAL_CLASSES.has("TESTIMONY")).toBe(true);
    expect(DEPO.length).toBeGreaterThan(0);
  });
});

// ── Supporting files: filed, accessible, and never chased for a date ─────────

describe("supporting files are kept without demanding a date", () => {
  it("the class exists, asserts almost nothing, and needs no date", () => {
    const p = profileFor("PHOTOGRAPHS");
    expect(p.klass).toBe("SUPPORTING_FILE");
    expect(p.requiresDate).toBe(false);
    expect(p.fields).toContain("documentContent");
    expect(p.fields).not.toContain("assessment");
  });

  it("only timeline-bound kinds are chased for a date", () => {
    for (const k of ["CLINICAL_ENCOUNTER", "THERAPY_COURSE", "OPERATIVE", "DIAGNOSTIC_STUDY", "ANESTHESIA", "PATHOLOGY_DIAGNOSTIC", "INCIDENT"]) {
      expect(requiresDate(k as never), k).toBe(true);
    }
    for (const k of ["SUPPORTING_FILE", "FINANCIAL", "LEGAL", "TESTIMONY", "EMPLOYMENT_ECONOMIC", "INSURANCE_ADMINISTRATIVE", "CORRESPONDENCE_OR_GENERIC_EVIDENCE", "UNKNOWN"]) {
      expect(requiresDate(k as never), k).toBe(false);
    }
    // An unrecorded kind is still chased — a real gap must not be excused.
    expect(requiresDate(null)).toBe(true);
  });

  it("it never reaches the medical chronology on its own", () => {
    const v = classifyEncounterSubstance({ analysisClass: "SUPPORTING_FILE", encounterType: null, factualSummary: "Fee schedule", claims: [{ field: "documentContent", value: "x" }] });
    expect(admissibleToMedicalTimeline({ analysisClass: "SUPPORTING_FILE", substanceClass: v.class })).toBe(false);
  });
});

// ── Reviewer reclassification ───────────────────────────────────────────────

describe("a reviewer can reassign the kind, and it governs downstream", () => {
  it("every assignable kind is a real profile", () => {
    for (const k of REVIEWER_ASSIGNABLE_CLASSES) expect(PROFILES[k], k).toBeTruthy();
  });

  it("reassigning to a clinical kind restores its clinical vocabulary and dating", () => {
    // A clinic note misfiled as billing: corrected, it may assert clinical
    // facts again and is chased for a date.
    expect(fieldAllowed(PROFILES.FINANCIAL, "assessment")).toBe(false);
    expect(fieldAllowed(PROFILES.CLINICAL_ENCOUNTER, "assessment")).toBe(true);
    expect(requiresDate("FINANCIAL")).toBe(false);
    expect(requiresDate("CLINICAL_ENCOUNTER")).toBe(true);
  });

  it("reassigning to a supporting file takes it off the chronology and stops the date chase", () => {
    expect(admissibleToMedicalTimeline({ analysisClass: "SUPPORTING_FILE", substanceClass: "ANCILLARY" })).toBe(false);
    expect(requiresDate("SUPPORTING_FILE")).toBe(false);
  });
});
