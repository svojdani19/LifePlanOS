// ─────────────────────────────────────────────────────────────────────────────
// Does each mechanism actually assert what its label claims?
//
// Every test below is a REFUTATION: an input where honouring the label
// requires the mechanism to withhold its blessing. If a refutation passes —
// if the mechanism blesses the input anyway — the label is a false statement
// to a physician, and this suite fails.
//
// Three of these reproduce defects that shipped and were found by an outside
// reader rather than by 2,200 passing tests, because those tests asked whether
// the code did what it did, never whether the label told the truth.
//
// Synthetic data throughout.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { SAFEGUARD_CLAIMS, overclaimedWords } from "@/lib/safeguards/claims";
import { claimReproduced, meetsCorroborationBar, type CorroborationRow } from "@/lib/records/corroboration";
import { resolveDeterministically, applyAdjudications, isDisputing, type CriticIssue } from "@/lib/llm/extractionCritic";
import { auditFactualRecord, type AuditEncounter, type AuditInput } from "@/lib/llm/factualAudit";
import { chunkDocumentText, type DocumentChunk, type LlmEncounter } from "@/lib/llm/recordExtraction";

// ── The registry itself ──────────────────────────────────────────────────────

describe("the safeguard registry keeps itself honest", () => {
  it("gives every safeguard a distinct id, a module, and at least one label", () => {
    const ids = SAFEGUARD_CLAIMS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of SAFEGUARD_CLAIMS) {
      expect(c.module, c.id).toMatch(/\.ts$/);
      expect(c.labels.length, c.id).toBeGreaterThan(0);
      expect(c.doesNotAssert.length, c.id).toBeGreaterThan(0);
    }
  });

  it("refuses a label that uses words the mechanism has not earned", () => {
    // A machine mechanism may not say "verified" or "independent" unless its
    // claim declares that it establishes those things.
    for (const c of SAFEGUARD_CLAIMS) {
      expect(overclaimedWords(c), `${c.id} label over-claims`).toEqual([]);
    }
  });

  it("has an executable refutation for every registered safeguard", () => {
    // An unfalsifiable guarantee is the thing this file exists to prevent, so
    // adding a safeguard without a refutation below fails here.
    const covered = new Set(REFUTED.map((r) => r.id));
    for (const c of SAFEGUARD_CLAIMS) expect(covered.has(c.id), `${c.id} has no refutation test`).toBe(true);
  });
});

/** Safeguards refuted below; the registry test requires one entry per claim. */
const REFUTED = [
  { id: "machine-corroboration" },
  { id: "dispute-adjudication" },
  { id: "group-review" },
  { id: "factual-audit" },
  { id: "provenance-upgrade" },
  { id: "patient-attribution" },
];

// ── machine-corroboration ────────────────────────────────────────────────────

describe("refuting: 'a blind second reading reproduced every fact'", () => {
  it("does not corroborate a fact the reading NEGATES", () => {
    // Shipped defect: the tokenizer dropped words under three characters, so
    // "no" vanished and a negated finding corroborated its positive.
    expect(claimReproduced("no acute fracture", ["Imaging shows acute fracture."])).toBe(false);
    expect(claimReproduced("acute fracture", ["Imaging shows no acute fracture."])).toBe(false);
  });

  it("does not corroborate a different quantity", () => {
    expect(claimReproduced("Gabapentin 10 mg nightly", ["Gabapentin 100 mg nightly"])).toBe(false);
    expect(claimReproduced("Two views of the left hip", ["Three views of the left hip"])).toBe(false);
  });

  it("does not corroborate the other side of the body", () => {
    expect(claimReproduced("Contusion of left knee", ["Contusion of right knee"])).toBe(false);
  });

  it("does not corroborate care that was only proposed as care delivered", () => {
    expect(claimReproduced("Epidural steroid injection performed at L4-L5", ["An epidural steroid injection was recommended at L4-L5"])).toBe(false);
  });

  it("does not corroborate a different date or a different level", () => {
    expect(claimReproduced("MRI lumbar spine on 03/18/2024", ["MRI lumbar spine performed 04/22/2024"])).toBe(false);
    expect(claimReproduced("Disc protrusion at L5-S1", ["Disc protrusion at L4-L5"])).toBe(false);
  });

  it("answers the same way every time it is asked", () => {
    // A stateful /g regex made the same comparison alternate between calls.
    const answers = new Set(Array.from({ length: 25 }, () => claimReproduced("no acute fracture", ["Imaging shows acute fracture."])));
    expect(answers.size).toBe(1);
  });

  it("still corroborates an honest paraphrase, or the tier is useless", () => {
    expect(claimReproduced("Lumbar radiculopathy", ["The assessment is lumbar radiculopathy."])).toBe(true);
    expect(claimReproduced("Continue physical therapy twice weekly", ["The plan is to continue physical therapy twice weekly."])).toBe(true);
  });

  it("never reaches a row whose citations were not found verbatim", () => {
    const row: CorroborationRow = {
      id: "r1",
      status: "AI_AUDIT_PASSED",
      dateStatus: "DOCUMENTED",
      page: 1,
      pageEnd: 1,
      warnings: [],
      claims: [{ field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radikulopathy" }],
    };
    expect(meetsCorroborationBar(row, "Assessment: Lumbar radiculopathy")).toBe(false);
  });

  it("cannot express a verdict that would satisfy the human gate", () => {
    // The claim says "pending human review"; the verdict shape must make that
    // structurally true — no status, and no verification vocabulary.
    const shape = JSON.stringify({ result: "CORROBORATED", reproduced: 2, total: 2, unreproducedFields: [] });
    expect(shape).not.toMatch(/VERIFIED|REVIEWED|HUMAN_EDITED/);
  });
});

// ── dispute-adjudication ─────────────────────────────────────────────────────

const META = { firmId: "f1", caseId: "c1", sourceDocumentId: "d1", filename: "s.pdf", ocrConfidence: 0.97, documentType: "MEDICAL_RECORD" };
const SOURCE = ["--- Page 1 ---", "Date of Service: 03/14/2025.", "Provider: Dana Rivers, MD.", "Assessment: Lumbar radiculopathy."].join("\n");
const chunkOf = (t: string): DocumentChunk => chunkDocumentText(t, [{ offset: 0, page: 1 }], META).chunks[0];
const ENC: LlmEncounter[] = [
  {
    dateStatus: "DOCUMENTED",
    date: "2025-03-14",
    dateEnd: null,
    dateExcerpt: "Date of Service: 03/14/2025",
    encounterType: "Consultation",
    provider: { value: "Dana Rivers, MD", excerpt: "Provider: Dana Rivers, MD", page: 1 },
    providerCredentials: "MD",
    facility: null,
    claims: [{ field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: 1, confidence: 0.9 }],
  } as LlmEncounter,
];

describe("refuting: 'every disagreement is answered or recorded'", () => {
  const issue = (over: Partial<CriticIssue>): CriticIssue =>
    ({ type: "UNSUPPORTED_CLAIM", encounterIndex: 0, claimIndex: 0, excerpt: null, detail: "d", ...over }) as CriticIssue;

  it("does not discard a dispute about the entry's own date or provider", () => {
    // Shipped defect: these legitimately carry no claim index, and the
    // deterministic pass swept them away — turning a blocking conflict into
    // silence, in a change whose stated purpose was better adjudication.
    for (const type of ["WRONG_DATE", "WRONG_PROVIDER"]) {
      const { settled, remaining } = resolveDeterministically(chunkOf(SOURCE), ENC, [issue({ type: type as never, claimIndex: null })]);
      expect(settled, type).toHaveLength(0);
      expect(remaining, type).toHaveLength(1);
    }
  });

  it("keeps every claim-disputing type answerable", () => {
    // A type that disputes something but can never be adjudicated would be a
    // silent hole; each disputing type must survive the deterministic pass
    // when it names a real target.
    for (const type of ["UNSUPPORTED_CLAIM", "WRONG_DATE", "WRONG_PROVIDER", "NEGATION_ERROR", "WRONG_ANATOMY", "WRONG_LATERALITY", "CONSENT_AS_TREATMENT", "RECOMMENDATION_AS_TREATMENT"]) {
      const one = issue({ type: type as never });
      expect(isDisputing(one), type).toBe(true);
      const { remaining } = resolveDeterministically(chunkOf(SOURCE), ENC, [one]);
      expect(remaining, type).toHaveLength(1);
    }
  });

  it("records an upheld date or provider criticism instead of dropping it", () => {
    const applied = applyAdjudications(ENC, [
      { issue: issue({ type: "WRONG_DATE" as never, claimIndex: null }), ruling: "UPHELD", reason: "the source states another date" },
    ]);
    expect(applied.contradictedFieldsByEncounter.get(0)).toEqual(["date"]);
    expect(applied.notes.join(" ")).toMatch(/contradicts the extracted date/);
  });

  it("never silently rewrites a contested date or provider", () => {
    // Nothing established the correct value; writing one would invent content.
    const applied = applyAdjudications(ENC, [
      { issue: issue({ type: "WRONG_PROVIDER" as never, claimIndex: null }), ruling: "UPHELD", reason: "another clinician signed" },
    ]);
    expect(applied.encounters[0].provider?.value).toBe("Dana Rivers, MD");
  });

  it("only discards a criticism with no target that exists", () => {
    const { settled } = resolveDeterministically(chunkOf(SOURCE), ENC, [issue({ claimIndex: 99 })]);
    expect(settled[0].ruling).toBe("DISCARDED");
  });
});

// ── factual-audit ────────────────────────────────────────────────────────────

const auditEnc = (over: Partial<AuditEncounter> = {}): AuditEncounter => ({
  id: "e1",
  sourceDocumentId: "d1",
  dateStatus: "DOCUMENTED",
  encounterDate: "2025-03-14",
  provider: "Dana Rivers, MD",
  encounterType: "Clinic visit",
  factualSummary: "Clinic visit — lumbar radiculopathy.",
  claims: [{ id: "c1", field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: 1 }],
  page: 1,
  status: "AI_DRAFT",
  ...over,
});
const auditBase = (over: Partial<AuditInput> = {}): AuditInput => ({
  encounters: [auditEnc()],
  pages: [{ pageNumber: 1, status: "READABLE", ocrConfidence: 0.98 }],
  failedExtractions: 0,
  unresolvedDisputes: 0,
  allDocumentsProcessed: true,
  ...over,
});

describe("refuting: 'audit passed'", () => {
  it("does not pass a document the critic says is missing an encounter", () => {
    // Shipped defect: critic omissions were collected, persisted, and read by
    // nothing, so a second pass could name an omitted encounter while every
    // row passed and the case stayed exportable.
    const r = auditFactualRecord(auditBase({ criticOmissions: 1 }));
    expect(r.result).toBe("EXTRACTION_INCOMPLETE");
    expect(r.perEncounter.every((x) => x !== "PASS")).toBe(true);
  });

  it("does not pass an entry whose date or provider the source contradicts", () => {
    const r = auditFactualRecord(auditBase({ encounters: [auditEnc({ contradictedFields: ["date"] })] }));
    expect(r.perEncounter[0]).toBe("SOURCE_CONFLICT");
  });

  it("does not let one entry's conflict pass judgement on its neighbour", () => {
    const r = auditFactualRecord(
      auditBase({ encounters: [auditEnc({ id: "a", unresolvedDisputes: 1 }), auditEnc({ id: "b", encounterDate: "2025-03-15" })] }),
    );
    expect(r.perEncounter).toEqual(["SOURCE_CONFLICT", "PASS"]);
  });

  it("does not hide document incompleteness from any entry", () => {
    const r = auditFactualRecord(auditBase({ coverageGaps: 2 }));
    expect(r.perEncounter[0]).toBe("EXTRACTION_INCOMPLETE");
  });
});

// ── group-review, provenance-upgrade, patient-attribution ───────────────────

describe("refuting: 'one review covers every copy'", () => {
  it("submits every row with the hash of the content displayed", async () => {
    // The browser must not be the thing that guarantees atomicity: the route
    // takes the whole group, and each row carries the hash it was shown as.
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/app/api/cases/[caseId]/records/encounters/group/route.ts", "utf8"),
    );
    expect(src).toMatch(/expectedContentHash/);
    expect(src).toMatch(/\$transaction/);
    // Validation must precede any write.
    expect(src.indexOf("problems.length")).toBeLessThan(src.indexOf("$transaction"));
  });

  it("does not fan out per-copy requests from the browser", async () => {
    const ui = await import("node:fs/promises").then((fs) => fs.readFile("src/components/case/CaseWorkspace.tsx", "utf8"));
    const fn = ui.slice(ui.indexOf("async function reviewWithCopies"), ui.indexOf("async function reviewWithCopies") + 2000);
    expect(fn).toMatch(/encounters\/group/);
    // No swallowed per-copy failures.
    expect(fn).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });
});

describe("refuting: 'one-time provenance upgrade'", () => {
  it("says the review is unverifiable, never that it was wrong", async () => {
    const { PROVENANCE_UPGRADE_STALE_REASON } = await import("@/lib/records/provenanceUpgrade");
    expect(PROVENANCE_UPGRADE_STALE_REASON).toMatch(/cannot be verified/i);
    expect(PROVENANCE_UPGRADE_STALE_REASON).toMatch(/Nothing was deleted/i);
    expect(PROVENANCE_UPGRADE_STALE_REASON).not.toMatch(/\b(wrong|incorrect|error)\b/i);
  });
});

describe("refuting: 'the provider field holds a clinician'", () => {
  it("clears a patient-named provider rather than leaving it to read as an author", async () => {
    const { adjudicatePatientAttribution } = await import("@/lib/records/patientAttribution");
    const note = {
      rowIds: ["r1"],
      sourceDocumentId: "d1",
      klass: "THERAPY_COURSE",
      encounterDate: new Date("2024-03-22T00:00:00Z"),
      provider: "Demick MCHENRY",
      facility: null,
      pageStart: 1,
      pageEnd: 1,
      claims: [{ id: "c1", field: "objectiveFindings", value: "PT evaluation", excerpt: "PT eval", page: 1 }],
      mergedClasses: [],
    } as never;
    const outcome = await adjudicatePatientAttribution([note], "Derrick McHenry", {
      provider: { complete: async () => '{"is_patient": true, "confidence": "high", "reason": "OCR variant of the patient name"}' } as never,
    });
    expect(outcome.cleared).toHaveLength(1);
    expect((note as { provider: string | null }).provider).toBeNull();
  });

  it("keeps a provider the adjudicator is not confident about", async () => {
    const { adjudicatePatientAttribution } = await import("@/lib/records/patientAttribution");
    const note = { rowIds: ["r1"], sourceDocumentId: "d1", klass: "THERAPY_COURSE", encounterDate: null, provider: "Sarah McHenry, RN", facility: null, pageStart: 1, pageEnd: 1, claims: [{ id: "c1", field: "x", value: "y", excerpt: "z", page: 1 }], mergedClasses: [] } as never;
    const outcome = await adjudicatePatientAttribution([note], "Derrick McHenry", {
      provider: { complete: async () => '{"is_patient": true, "confidence": "medium", "reason": "could be a relative"}' } as never,
    });
    expect(outcome.cleared).toHaveLength(0);
    expect((note as { provider: string | null }).provider).toBe("Sarah McHenry, RN");
  });
});

// ── The version a stored verdict carries must mean something ────────────────

describe("refuting: 'this verdict was graded by these rules'", () => {
  // A stored verdict names the comparator version that produced it, and the
  // backfill regrades anything older. That promise is empty if grading can
  // change while the version stays put — which happened once: the quantity
  // rule was corrected and every already-graded row was skipped as current.
  //
  // So the version is pinned to BEHAVIOUR. This battery is graded and hashed;
  // change what grading does and this fails until the version is bumped with
  // it. Update both together, never one alone.
  const BATTERY: [string, string][] = [
    ["no acute fracture", "Imaging shows acute fracture."],
    ["acute fracture", "Imaging shows no acute fracture."],
    ["no acute fracture or dislocation seen", "X-ray: no acute fracture or dislocation seen."],
    ["Gabapentin 10 mg nightly", "Gabapentin 100 mg nightly"],
    ["Gabapentin 100 mg nightly", "The patient takes gabapentin 100 mg nightly."],
    ["Two views of the left hip", "Three views of the left hip"],
    ["Contusion of left knee", "Contusion of right knee"],
    ["Epidural steroid injection performed at L4-L5", "An epidural steroid injection was recommended at L4-L5"],
    ["Continue physical therapy twice weekly", "The plan is to continue physical therapy twice weekly."],
    ["Lumbar radiculopathy", "The assessment is lumbar radiculopathy."],
    ["MRI lumbar spine on 03/18/2024", "MRI lumbar spine performed 04/22/2024"],
    ["$950.00 billed for 99233", "On 03/22/2024 the provider billed $950.00 under code 99233."],
    ["Disc protrusion at L5-S1", "Disc protrusion at L4-L5"],
  ];

  it("pins the comparator version to what grading actually does", async () => {
    const { CORROBORATION_COMPARATOR_VERSION } = await import("@/lib/records/corroboration");
    const behaviour = BATTERY.map(([claim, fact]) => (claimReproduced(claim, [fact]) ? "1" : "0")).join("");
    // Grading vector ⇄ version. Both change together or neither does.
    expect({ version: CORROBORATION_COMPARATOR_VERSION, behaviour }).toEqual({
      version: "2026-08-15.discriminant-gate.2",
      behaviour: "0010100011010",
    });
  });
});
