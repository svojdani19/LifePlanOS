// Integration: a realistic synthetic multi-page medical record — multiple
// providers and dates, two distinct same-day encounters, imaging, surgery,
// therapy, negative findings, a consent form, administrative pages, OCR noise,
// and conflicting evidence — driven through chunking → (fake) LLM extraction →
// deterministic validation → consolidation → rendering. Accuracy is asserted
// against EXPLICIT expected claims and citations, not "summary is non-empty".
import { describe, it, expect } from "vitest";
import {
  chunkDocumentText,
  extractEncountersFromChunk,
  validateEncounters,
  consolidateEncounters,
  renderFactualSummary,
  type DocumentChunk,
  type LlmEncounter,
  type ValidatedEncounter,
} from "./recordExtraction";
import type { LlmProvider } from "@/lib/llm";

const META = { firmId: "firm-1", caseId: "case-1", sourceDocumentId: "doc-1", filename: "synthetic-chart.pdf", ocrConfidence: 0.88 };

// Six pages of synthetic chart. Page 4 is a consent form; page 5 is
// administrative; OCR noise is sprinkled through page 3.
const PAGES: string[] = [
  // p1 — ER visit
  [
    "--- Page 1 ---",
    "RIVERBEND EMERGENCY DEPARTMENT",
    "Date of Service: 01/05/2025",
    "Provider: Casey Morgan, MD. Facility: Riverbend Medical Center.",
    "Chief complaint: right knee pain after a fall from a ladder.",
    "Exam: Right knee effusion with limited flexion to 70 degrees.",
    "X-ray right knee: no acute fracture identified.",
    "Assessment: Right knee internal derangement, suspected meniscal tear.",
    "Disposition: Discharged with knee immobilizer; orthopedic follow-up advised.",
  ].join("\n"),
  // p2 — MRI
  [
    "--- Page 2 ---",
    "RIVERBEND IMAGING — MRI RIGHT KNEE",
    "Exam date: 01/19/2025. Interpreted by: Sam Patel, MD.",
    "Impression: Complex tear of the medial meniscus posterior horn. Moderate joint effusion. No osteonecrosis.",
  ].join("\n"),
  // p3 — surgery + same-day PT eval (two DISTINCT same-day encounters) + OCR noise
  [
    "--- Page 3 ---",
    "OPERATIVE REPORT — Date of operation: 02/10/2025",
    "Surgeon: Alexis Chen, MD. Facility: Riverbend Surgery Center.",
    "Procedure performed: Right knee arthroscopic partial medial meniscectomy.",
    "The patient tolerated the procedure well with no complications.",
    "q$#& OCR artifact line 0f n0ise th@t means nothing",
    "PHYSICAL THERAPY INITIAL EVALUATION — Date of Service: 02/10/2025",
    "Therapist: Jordan Lee, DPT. Facility: Riverbend Rehabilitation.",
    "Treatment: Post-operative protocol initiated; quad sets and heel slides instructed.",
  ].join("\n"),
  // p4 — consent form (treatment must NOT be inferred from it)
  [
    "--- Page 4 ---",
    "CONSENT FOR SURGICAL PROCEDURE",
    "I authorize Dr. Chen to perform arthroscopy of the right knee.",
    "Risks include infection, bleeding, and anesthesia complications.",
    "Signed: 02/03/2025",
  ].join("\n"),
  // p5 — administrative page
  [
    "--- Page 5 ---",
    "BILLING STATEMENT — Account 44-9921. Statement date: 03/01/2025.",
    "Amount due: $1,250.00. Please remit payment within 30 days.",
  ].join("\n"),
  // p6 — follow-up with conflicting evidence (pre-existing/adverse)
  [
    "--- Page 6 ---",
    "ORTHOPEDIC FOLLOW-UP — Date of Service: 03/12/2025",
    "Provider: Alexis Chen, MD.",
    "Subjective: Knee improving; patient reports prior left knee surgery in 2015.",
    "Note: outside chiropractic record dated 12/02/2024 documents right knee pain PRE-DATING the reported fall.",
    "Work status: Released to modified duty, no ladder climbing.",
  ].join("\n"),
];

const TEXT = PAGES.join("\n");
const marks = PAGES.map((p) => ({ offset: TEXT.indexOf(p), page: PAGES.indexOf(p) + 1 }));

// What a well-behaved model SHOULD return for this chunk — plus deliberate
// violations (fabricated claim, consent-inferred treatment, DOB-style date
// abuse is covered elsewhere) that validation must strike.
const MODEL_OUTPUT: { encounters: LlmEncounter[] } = {
  encounters: [
    {
      dateStatus: "DOCUMENTED",
      date: "2025-01-05",
      dateEnd: null,
      dateExcerpt: "Date of Service: 01/05/2025",
      encounterType: "Emergency visit",
      provider: { value: "Casey Morgan, MD", excerpt: "Provider: Casey Morgan, MD", page: 1 },
      providerCredentials: "MD",
      facility: { value: "Riverbend Medical Center", excerpt: "Facility: Riverbend Medical Center", page: 1 },
      claims: [
        { field: "subjective", value: "Right knee pain after a fall from a ladder", excerpt: "right knee pain after a fall from a ladder", page: 1, confidence: 0.95 },
        { field: "objectiveFindings", value: "Right knee effusion, flexion limited to 70 degrees", excerpt: "Right knee effusion with limited flexion to 70 degrees", page: 1, confidence: 0.92 },
        { field: "diagnosticStudies", value: "X-ray right knee: no acute fracture", excerpt: "X-ray right knee: no acute fracture identified", page: 1, confidence: 0.94 },
        { field: "assessment", value: "Right knee internal derangement, suspected meniscal tear", excerpt: "Assessment: Right knee internal derangement, suspected meniscal tear", page: 1, confidence: 0.95 },
        { field: "disposition", value: "Discharged with knee immobilizer; orthopedic follow-up advised", excerpt: "Discharged with knee immobilizer; orthopedic follow-up advised", page: 1, confidence: 0.93 },
      ],
    },
    {
      dateStatus: "DOCUMENTED",
      date: "2025-01-19",
      dateEnd: null,
      dateExcerpt: "Exam date: 01/19/2025",
      encounterType: "Imaging",
      provider: { value: "Sam Patel, MD", excerpt: "Interpreted by: Sam Patel, MD", page: 2 },
      providerCredentials: "MD",
      facility: null,
      claims: [
        { field: "diagnosticStudies", value: "MRI right knee: complex tear of the medial meniscus posterior horn; moderate joint effusion; no osteonecrosis", excerpt: "Impression: Complex tear of the medial meniscus posterior horn. Moderate joint effusion. No osteonecrosis.", page: 2, confidence: 0.96 },
      ],
    },
    {
      dateStatus: "DOCUMENTED",
      date: "2025-02-10",
      dateEnd: null,
      dateExcerpt: "Date of operation: 02/10/2025",
      encounterType: "Surgery",
      provider: { value: "Alexis Chen, MD", excerpt: "Surgeon: Alexis Chen, MD", page: 3 },
      providerCredentials: "MD",
      facility: { value: "Riverbend Surgery Center", excerpt: "Facility: Riverbend Surgery Center", page: 3 },
      claims: [
        { field: "procedure", value: "Right knee arthroscopic partial medial meniscectomy", excerpt: "Procedure performed: Right knee arthroscopic partial medial meniscectomy", page: 3, confidence: 0.97 },
        { field: "responseToTreatment", value: "Tolerated the procedure well with no complications", excerpt: "tolerated the procedure well with no complications", page: 3, confidence: 0.9 },
      ],
    },
    {
      // Same-day, DIFFERENT encounter: PT evaluation.
      dateStatus: "DOCUMENTED",
      date: "2025-02-10",
      dateEnd: null,
      dateExcerpt: "PHYSICAL THERAPY INITIAL EVALUATION — Date of Service: 02/10/2025",
      encounterType: "Therapy",
      provider: { value: "Jordan Lee, DPT", excerpt: "Therapist: Jordan Lee, DPT", page: 3 },
      providerCredentials: "DPT",
      facility: { value: "Riverbend Rehabilitation", excerpt: "Facility: Riverbend Rehabilitation", page: 3 },
      claims: [
        { field: "treatment", value: "Post-operative protocol initiated; quad sets and heel slides instructed", excerpt: "Post-operative protocol initiated; quad sets and heel slides instructed", page: 3, confidence: 0.93 },
      ],
    },
    {
      // VIOLATION: treatment inferred from the consent form. The claimed
      // excerpt does not exist (consent text says "I authorize", not that
      // surgery happened) — validation must reject it.
      dateStatus: "DOCUMENTED",
      date: "2025-02-03",
      dateEnd: null,
      dateExcerpt: "Signed: 02/03/2025",
      encounterType: "Surgery",
      provider: null,
      providerCredentials: null,
      facility: null,
      claims: [
        { field: "procedure", value: "Arthroscopy of the right knee performed", excerpt: "arthroscopy of the right knee was performed as consented", page: 4, confidence: 0.8 },
      ],
    },
    {
      dateStatus: "DOCUMENTED",
      date: "2025-03-12",
      dateEnd: null,
      dateExcerpt: "Date of Service: 03/12/2025",
      encounterType: "Clinic visit",
      provider: { value: "Alexis Chen, MD", excerpt: "Provider: Alexis Chen, MD", page: 6 },
      providerCredentials: "MD",
      facility: null,
      claims: [
        { field: "subjective", value: "Knee improving; prior left knee surgery in 2015 reported", excerpt: "Knee improving; patient reports prior left knee surgery in 2015", page: 6, confidence: 0.92 },
        // Adverse/conflicting evidence MUST be retained, not filtered.
        { field: "contradictions", value: "Outside chiropractic record dated 12/02/2024 documents right knee pain pre-dating the reported fall", excerpt: "outside chiropractic record dated 12/02/2024 documents right knee pain PRE-DATING the reported fall", page: 6, confidence: 0.9 },
        { field: "workStatus", value: "Released to modified duty, no ladder climbing", excerpt: "Released to modified duty, no ladder climbing", page: 6, confidence: 0.94 },
        // VIOLATION: fabricated claim with no supporting text anywhere.
        { field: "assessment", value: "Full recovery achieved; no further care needed", excerpt: "the patient has achieved full recovery and requires no further care", page: 6, confidence: 0.85 },
      ],
    },
  ],
};

function providerReturning(payload: unknown): LlmProvider {
  return { name: "fake", complete: async () => JSON.stringify(payload) };
}

async function runPipeline(): Promise<{ chunk: DocumentChunk; validated: ValidatedEncounter[]; rejected: string[] }> {
  const { chunks, truncated } = chunkDocumentText(TEXT, marks, META);
  expect(truncated).toBe(false);
  expect(chunks.length).toBe(1); // six short pages fit one chunk
  const chunk = chunks[0];
  const encounters = await extractEncountersFromChunk(chunk, { provider: providerReturning(MODEL_OUTPUT) });
  const { accepted, rejected } = validateEncounters(chunk, encounters);
  return { chunk, validated: consolidateEncounters(accepted), rejected };
}

describe("multi-page synthetic chart — end-to-end accuracy", () => {
  it("accepts exactly the supported encounters, keeping distinct same-day encounters distinct", async () => {
    const { validated } = await runPipeline();
    const keys = validated.map((e) => `${e.encounterDate?.toISOString().slice(0, 10)}|${e.provider}`);
    expect(keys).toEqual([
      "2025-01-05|Casey Morgan, MD",
      "2025-01-19|Sam Patel, MD",
      "2025-02-10|Alexis Chen, MD",
      "2025-02-10|Jordan Lee, DPT", // same day, distinct encounter — NOT merged
      "2025-03-12|Alexis Chen, MD",
    ]);
  });

  it("rejects the consent-inferred surgery and the fabricated recovery claim, with reasons", async () => {
    const { validated, rejected } = await runPipeline();
    const all = validated.flatMap((e) => e.claims.map((c) => c.value));
    expect(all.join(" ")).not.toMatch(/full recovery|as consented/i);
    expect(validated.some((e) => e.encounterDate?.toISOString().startsWith("2025-02-03"))).toBe(false); // consent date never became an encounter
    expect(rejected.join(" ")).toMatch(/not found/);
  });

  it("every accepted claim cites a real page whose text contains its excerpt", async () => {
    const { chunk, validated } = await runPipeline();
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
    for (const enc of validated) {
      for (const claim of enc.claims) {
        expect(claim.page, `claim "${claim.value}" must cite a page`).not.toBeNull();
        const slice = chunk.pageSlices.find((p) => p.page === claim.page)!;
        expect(norm(slice.text)).toContain(norm(claim.excerpt));
      }
    }
  });

  it("negative findings survive as documented facts ('no acute fracture', 'no complications')", async () => {
    const { validated } = await runPipeline();
    const all = validated.flatMap((e) => e.claims.map((c) => c.value)).join(" ");
    expect(all).toMatch(/no acute fracture/i);
    expect(all).toMatch(/no complications/i);
  });

  it("adverse/conflicting evidence is retained and labeled as a contradiction", async () => {
    const { validated } = await runPipeline();
    const followUp = validated.find((e) => e.encounterDate?.toISOString().startsWith("2025-03-12"))!;
    const contradiction = followUp.claims.find((c) => c.field === "contradictions")!;
    expect(contradiction.value).toMatch(/PRE-DATING the reported fall/i);
    expect(contradiction.page).toBe(6);
  });

  it("rendered summaries are deterministic and lead with the encounter's own facts", async () => {
    const { validated } = await runPipeline();
    const surgery = validated.find((e) => e.provider === "Alexis Chen, MD" && e.encounterDate?.toISOString().startsWith("2025-02-10"))!;
    const s1 = renderFactualSummary(surgery);
    const s2 = renderFactualSummary(surgery);
    expect(s1).toBe(s2);
    // One sentence naming the event — the operative procedure itself.
    expect(s1).toBe("Surgery — Right knee arthroscopic partial medial meniscectomy.");
  });
});
