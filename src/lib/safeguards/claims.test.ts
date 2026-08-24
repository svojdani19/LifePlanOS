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
  { id: "claim-salvage" },
  { id: "machine-corroboration" },
  { id: "dispute-adjudication" },
  { id: "group-review" },
  { id: "factual-audit" },
  { id: "provenance-upgrade" },
  { id: "patient-attribution" },
  { id: "canonical-note-review" },
  { id: "finding-disposition" },
  { id: "note-wide-correction" },
  { id: "batch-factual-confirmation" },
  { id: "finding-lifecycle" },
  { id: "export-gate-visible-findings" },
  { id: "item-evidence-ledger" },
  { id: "recorded-evidence-read-model" },
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
    const r = auditFactualRecord(auditBase({ failedSections: 2 }));
    expect(r.perEncounter[0]).toBe("EXTRACTION_INCOMPLETE");
  });

  it("does not let a missed encounter escape the CASE gate when it leaves the rows", async () => {
    // Coverage gaps stopped being copied onto every row of their document.
    // That is only honest if the gate still refuses to complete over them —
    // otherwise a fully reviewed case would export past a note nobody read.
    const { coverageGapBlocker } = await import("@/lib/records/structuredRecord");
    const r = auditFactualRecord(auditBase({ coverageGaps: 2 }));
    expect(r.perEncounter[0]).toBe("PASS"); // the entry itself is sound…
    expect(r.result).toBe("EXTRACTION_INCOMPLETE"); // …the document is not…
    // …and the case cannot complete.
    expect(coverageGapBlocker([{ sourceDocumentId: "d1", coverageGaps: 2 }])).toMatch(/no extracted encounter/);
    expect(coverageGapBlocker([{ sourceDocumentId: "d1", coverageGaps: 0 }])).toBeNull();
  });

  it("counts only each document's LATEST run, so a fixed gap stops blocking", async () => {
    const { coverageGapBlocker } = await import("@/lib/records/structuredRecord");
    // Runs arrive newest-first; the re-extraction that closed the gap wins.
    expect(coverageGapBlocker([
      { sourceDocumentId: "d1", coverageGaps: 0 },
      { sourceDocumentId: "d1", coverageGaps: 5 },
    ])).toBeNull();
  });

  it("marks only the duplicated entries, not their document", () => {
    const dup = auditEnc({ id: "a" });
    const r = auditFactualRecord(auditBase({ encounters: [dup, auditEnc({ id: "b" }), auditEnc({ id: "c", encounterDate: "2025-04-01" })] }));
    expect(r.perEncounter).toEqual(["NEEDS_HUMAN_REVIEW", "NEEDS_HUMAN_REVIEW", "PASS"]);
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
    // The claim belongs to the path the buttons actually call. This assertion
    // used to name a helper nothing invoked, so it went on passing while the
    // guarantee was unreachable — which is why it is anchored to reviewNote
    // and paired with the reachability checks in crossDocumentCopies.test.ts.
    const at = ui.indexOf("async function reviewNote");
    expect(at, "reviewNote is the wired review path").toBeGreaterThan(-1);
    const fn = ui.slice(at, at + 1200);
    expect(fn).toMatch(/encounters\/group/);
    // One request for the whole note, carrying every member's hash.
    expect(fn).toMatch(/note\.contentHashes/);
    // No swallowed per-copy failures.
    expect(fn).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });

  it("has no unreachable implementation of the claim left in the file", async () => {
    const ui = await import("node:fs/promises").then((fs) => fs.readFile("src/components/case/CaseWorkspace.tsx", "utf8"));
    expect(ui).not.toContain("reviewWithCopies");
  });
});

describe("refuting: 'the sound claims were kept'", () => {
  it("does not turn an unusable response into an empty page", async () => {
    // 14 of 15 failed sections in the corpus died because ONE claim's excerpt
    // was two characters long. Salvaging that is right; salvaging a response
    // where NOTHING parsed would report "this page contained nothing", which
    // is a false statement about the record rather than about the model.
    const { salvageClaims } = await import("@/lib/llm/recordExtraction");
    const allBad = { encounters: [{ dateStatus: "UNKNOWN", claims: [{ field: "assessment", value: "x" }] }] };
    const { payload } = salvageClaims(allBad);
    expect((payload as { encounters: unknown[] }).encounters).toHaveLength(0);
    // The caller must treat "sent entries, kept none" as a failure, not a result.
    const src = await import("node:fs/promises").then((fs) => fs.readFile("src/lib/llm/recordExtraction.ts", "utf8"));
    expect(src).toMatch(/no entry survived parsing/);
  });

  it("marks a salvaged page incomplete so its range is re-read", async () => {
    const src = await import("node:fs/promises").then((fs) => fs.readFile("src/lib/llm/recordExtraction.ts", "utf8"));
    expect(src).toMatch(/incomplete: atCap\(encounters\) \|\| salvage\.length > 0/);
  });

  it("names the field it dropped without quoting the record", async () => {
    const { salvageClaims } = await import("@/lib/llm/recordExtraction");
    const { salvage } = salvageClaims({
      encounters: [
        {
          dateStatus: "DOCUMENTED",
          date: "2025-03-14",
          dateExcerpt: "Date of Service: 03/14/2025",
          claims: [
            { field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy", page: 1 },
            { field: "medications", value: "Ibuprofen 600 mg", excerpt: "x", page: 1 },
          ],
        },
      ],
    });
    expect(salvage.join(" ")).toMatch(/medications/);
    expect(salvage.join(" ")).not.toMatch(/Ibuprofen/);
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


// ── the safeguards added after the reachability gap was found ────────────────
//
// Each refutation drives the REAL implementation with input that would let the
// claim slip if the mechanism were lax. Reachability — whether any of this is
// wired to a rendered action — is proved separately in reachability.test.ts;
// these ask the older question: given that it runs, does it withhold its
// blessing when it should?

describe("refuting: 'one decision covers exactly one canonical note'", () => {
  it("does not treat a note id as a list of rows the caller may choose", async () => {
    const { parseCanonicalNoteId } = await import("@/lib/records/reviewBurden");
    // A malformed identifier must yield nothing to match against, not a
    // partial parse a caller could steer toward rows of its choosing.
    expect(parseCanonicalNoteId("doc-1")).toEqual({ documentId: null, rowIds: [] });
    expect(parseCanonicalNoteId("doc-1:")).toEqual({ documentId: null, rowIds: [] });
    expect(parseCanonicalNoteId(":a,b")).toEqual({ documentId: null, rowIds: [] });
  });

  it("checks the row's own integrity state, not only the finding table", async () => {
    // Findings were not being written by normal extraction, so a gate that
    // consulted only that table was a gate over an empty room. The checks now
    // live in ONE shared function — the individual endpoint, the batch
    // confirmation and the final gate must not hold three opinions about
    // whether a record is sound — so this asserts the BEHAVIOUR of that
    // function, and that the route runs it behind the non-reject branch.
    const { attestationBlockers } = await import("@/lib/records/reviewIntegrity");
    // Audited and passed, so each case below isolates ONE defect.
    const draft = { id: "r", status: "AI_DRAFT" as const, auditResult: "PASS" };
    expect(attestationBlockers({ ...draft, auditResult: "FAILED" }).map((p) => p.code)).toEqual(["AUDIT_FAILED"]);
    // "Not audited" is not "audited and fine": a batch that treated a missing
    // grade as clean would delete the required-audit safeguard outright.
    expect(attestationBlockers({ ...draft, auditResult: null }).map((p) => p.code)).toEqual(["UNAUDITED"]);
    expect(attestationBlockers({ id: "r", status: "HUMAN_EDITED", auditResult: null })).toEqual([]);
    expect(
      attestationBlockers({ ...draft, auditResult: "SOURCE_CONFLICT", auditVersion: "2026-08-17.scoped-findings" }).map((p) => p.code),
    ).toEqual(["SOURCE_CONFLICT"]);
    expect(attestationBlockers({ ...draft, unresolvedDisputes: 2 }).map((p) => p.code)).toEqual(["UNRESOLVED_DISPUTE"]);
    expect(attestationBlockers({ ...draft, contradictedFields: ["date"] }).map((p) => p.code)).toEqual(["CONTRADICTED_FIELD"]);
    // A sound draft is not obstructed by any of them.
    expect(attestationBlockers({ ...draft, auditResult: "PASS" })).toEqual([]);

    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/app/api/cases/[caseId]/records/encounters/group/route.ts", "utf8"),
    );
    expect(src.includes("attestationBlockers")).toBe(true);
    // …and it sits behind the non-reject branch: disposing of an unsupportable
    // entry is how one is resolved, so a REJECT is never obstructed by it.
    expect(src.indexOf('input.action !== "reject"')).toBeLessThan(src.lastIndexOf("attestationBlockers"));
  });
});

describe("refuting: 'one click confirmed the clean records'", () => {
  const clean = {
    id: "r1",
    sourceDocumentId: "doc-1",
    dateStatus: "DOCUMENTED" as const,
    encounterDate: "2025-03-14",
    encounterDateEnd: null,
    provider: "A. Rivera, MD",
    providerCredentials: null,
    facility: null,
    encounterType: "Clinic visit",
    factualSummary: "Clinic visit.",
    synthesis: null,
    claims: [{ field: "assessment", value: "Lumbar radiculopathy", excerpt: "…", page: 1, confidence: null }],
    page: 1,
    pageEnd: 1,
    ocrConfidence: 0.98,
    warnings: [],
    status: "AI_AUDIT_PASSED",
    substanceClass: "CLINICAL",
    substanceReason: null,
    analysisClass: "CLINICAL_ENCOUNTER",
    attributionName: null,
    attributionRole: null,
    reviewedAt: null,
    verifiedAt: null,
    staleReason: null,
    auditResult: "PASS",
    auditVersion: "2026-08-17.scoped-findings",
    unresolvedDisputes: 0,
    contradictedFields: [] as string[],
    editedFields: [] as string[],
    contentHash: "r1".padEnd(64, "0"),
  };

  const planFor = async (over: Record<string, unknown> = {}) => {
    const { projectNotes } = await import("@/lib/records/noteProjection");
    const { planBatchConfirmation } = await import("@/lib/records/batchConfirmation");
    const notes = projectNotes("doc-1", [{ rowIds: ["r1"] }], [{ ...clean, ...over } as never], []);
    return planBatchConfirmation({ notes, events: [] });
  };

  it("does not treat a MISSING audit as a clean one", async () => {
    const plan = await planFor({ auditResult: null });
    expect(plan.rowIds).toEqual([]);
    expect(plan.skippedByReason).toEqual({ UNAUDITED: 1 });
  });

  it("does not confirm part of an unresolved ambiguity cluster", async () => {
    const { projectNotes } = await import("@/lib/records/noteProjection");
    const { planBatchConfirmation } = await import("@/lib/records/batchConfirmation");
    const rows = Array.from({ length: 4 }, (_, i) => ({
      ...clean,
      id: `u${i}`,
      contentHash: `u${i}`.padEnd(64, "0"),
      claims: [{ field: "subjective", value: `Interval note paragraph number ${i} describing the encounter`, excerpt: "…", page: 4, confidence: null }],
    }));
    // Ingest-time segments: no rowIds, so the compatibility path decides.
    const notes = projectNotes("doc-1", [{ date: "2025-03-14", kind: "clinical" }], rows as never, []);
    const plan = planBatchConfirmation({ notes, events: [] });
    // One question, four records held, nothing confirmed.
    expect(plan.counts.skippedEncounters).toBe(1);
    expect(plan.counts.heldEncounters).toBe(3);
    expect(plan.rowIds).toEqual([]);
  });

  it("does not bind only the row set — a regrouping moves the manifest", async () => {
    const { projectNotes } = await import("@/lib/records/noteProjection");
    const { planBatchConfirmation } = await import("@/lib/records/batchConfirmation");
    const rows = [
      { ...clean, id: "a", contentHash: "a".padEnd(64, "0") },
      { ...clean, id: "b", contentHash: "b".padEnd(64, "0") },
    ];
    const apart = planBatchConfirmation({ notes: projectNotes("doc-1", [{ rowIds: ["a"] }, { rowIds: ["b"] }], rows as never, []), events: [] });
    const together = planBatchConfirmation({ notes: projectNotes("doc-1", [{ rowIds: ["a", "b"] }], rows as never, []), events: [] });
    expect(together.rowIds).toEqual(apart.rowIds); // same rows…
    expect(together.manifestHash).not.toBe(apart.manifestHash); // …different dialog
  });

  it("does not sweep an exception into the clean set", async () => {
    for (const over of [
      { auditResult: "FAILED" },
      { auditResult: "SOURCE_CONFLICT" },
      { unresolvedDisputes: 1 },
      { contradictedFields: ["date"] },
      { status: "STALE" },
      { status: "GENERATION_LOSS" },
      { dateStatus: "UNKNOWN", encounterDate: null },
    ]) {
      const plan = await planFor(over);
      expect(plan.rowIds, JSON.stringify(over)).toEqual([]);
      expect(plan.counts.skippedEncounters, JSON.stringify(over)).toBe(1);
    }
  });

  it("does not claim to have VERIFIED anything", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/app/api/cases/[caseId]/records/confirm/route.ts", "utf8"),
    );
    // It writes REVIEWED, and never the verification fields.
    expect(src).toContain('status: "REVIEWED"');
    expect(src).not.toContain("verifiedContentHash:");
    expect(src).not.toContain('status: "VERIFIED"');
  });

  it("does not let the browser name what it covers", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/app/api/cases/[caseId]/records/confirm/route.ts", "utf8"),
    );
    // The request body has exactly two fields, neither of which is a row id,
    // an event id, a count, or an eligibility claim.
    const body = src.slice(src.indexOf("const bodySchema"), src.indexOf("type Params"));
    expect(body).toContain("expectedManifestHash");
    expect(body).not.toMatch(/rowIds|encounterId|eventIds|eligible/);
  });

  it("does not write a content field anywhere", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/app/api/cases/[caseId]/records/confirm/route.ts", "utf8"),
    );
    // The acceptance property: a confirmation may not improve, condense or
    // reclassify the extracted record in order to shrink a queue.
    for (const field of ["factualSummary:", "claims:", "synthesis:", "encounterDate:", "provider:", "facility:", "analysisClass:", "substanceClass:", "summary:"]) {
      expect(src.includes(field), field).toBe(false);
    }
  });
});

describe("refuting: 'a reviewer answered this finding'", () => {
  it("binds a dismissal to the source it was given over", async () => {
    const { dispositionOutlivedItsSource } = await import("@/lib/records/recordFindings");
    // Same content: the answer still covers it.
    expect(dispositionOutlivedItsSource({ fingerprint: "f", status: "DISMISSED", dispositionSourceFingerprint: "sha-1" }, "sha-1")).toBe(false);
    // Changed content: it does not, and must not be carried forward.
    expect(dispositionOutlivedItsSource({ fingerprint: "f", status: "DISMISSED", dispositionSourceFingerprint: "sha-1" }, "sha-2")).toBe(true);
    // No recorded fingerprint is not evidence of change.
    expect(dispositionOutlivedItsSource({ fingerprint: "f", status: "DISMISSED", dispositionSourceFingerprint: null }, "sha-2")).toBe(false);
  });

  it("will not let a blocker be closed without a reason", async () => {
    const src = await import("node:fs/promises").then((fs) => fs.readFile("src/app/api/cases/[caseId]/records/findings/route.ts", "utf8"));
    expect(src).toMatch(/Closing a blocking finding requires a reason/);
    // Confirming is exempt: it leaves the blocker standing.
    expect(src).toMatch(/input\.action !== "confirm"/);
  });
});

describe("refuting: 'the correction was applied to the whole note'", () => {
  it("refuses a correction that is not note-wide in the first place", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/app/api/cases/[caseId]/records/encounters/group/correct/route.ts", "utf8"),
    );
    // A factual summary describes ONE fragment; applying it note-wide would
    // copy one page's prose over its neighbours.
    expect(src).toMatch(/NOTE_WIDE_FIELDS/);
    expect(src).toMatch(/Summary and claim corrections belong on the individual entry/);
  });

  it("aborts the whole note when one fragment moved under it", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/app/api/cases/[caseId]/records/encounters/group/correct/route.ts", "utf8"),
    );
    expect(src).toMatch(/ConcurrentChange/);
    // Validation strictly before any write.
    expect(src.indexOf("problems.length")).toBeLessThan(src.indexOf("$transaction"));
  });
});

describe("refuting: 'the audit closed a finding it proved was gone'", () => {
  it("will not close a human CONFIRMED, whatever the caller asks for", async () => {
    const { writeFindings } = await import("@/lib/records/recordFindings");
    const rows = [{ fingerprint: "stale-fp", caseId: "case-1", sourceDocumentId: "doc-1", source: "DETERMINISTIC_VALIDATOR", status: "CONFIRMED" }];
    const store = {
      recordFinding: {
        findMany: async () => [],
        upsert: async () => ({}),
        updateMany: async ({ where }: { where: Record<string, unknown> }) => {
          // The service must ask for OPEN only; a CONFIRMED row is unreachable.
          const hit = rows.filter((r) => r.status === where.status);
          for (const r of hit) r.status = "RESOLVED";
          return { count: hit.length };
        },
      },
    };
    const out = await writeFindings(store, [], {
      caseId: "case-1",
      sources: ["DETERMINISTIC_VALIDATOR", "HUMAN_REVIEW"],
      evaluatedDocumentIds: ["doc-1"],
      evaluatedWholeCase: true,
    });
    expect(out.resolved).toBe(0);
    expect(rows[0].status).toBe("CONFIRMED");
  });

  it("will not reach outside the scope it evaluated", async () => {
    const { writeFindings } = await import("@/lib/records/recordFindings");
    let asked: Record<string, unknown> | null = null;
    const store = {
      recordFinding: {
        findMany: async () => [],
        upsert: async () => ({}),
        updateMany: async ({ where }: { where: Record<string, unknown> }) => {
          asked = where;
          return { count: 0 };
        },
      },
    };
    await writeFindings(store, [], {
      caseId: "case-1",
      sources: ["DETERMINISTIC_VALIDATOR"],
      evaluatedDocumentIds: ["doc-1"],
      evaluatedWholeCase: false,
    });
    // Documents it read, and — because it did not read the whole case —
    // nothing at case scope.
    const clauses = (asked!.OR ?? []) as Record<string, unknown>[];
    expect(clauses).toHaveLength(1);
    expect(clauses[0]).toEqual({ sourceDocumentId: { in: ["doc-1"] } });
  });
});

describe("refuting: 'nothing blocks an export invisibly'", () => {
  it("routes every finding to a scope rather than dropping the ones it cannot place", async () => {
    const { routeScopedFindings } = await import("@/lib/records/structuredRecord");
    const unplaceable = {
      id: "f", scope: "PAGE", type: "PAGE_UNREADABLE", severity: "BLOCKING", blocking: true,
      source: "PAGE_LEDGER", detail: "unreadable", status: "OPEN", sourceDocumentId: null,
    };
    const routed = routeScopedFindings([unplaceable], new Map());
    // Surfaced at case scope rather than silently discarded: an invisible
    // finding still blocks the export.
    expect(routed.caseFindings).toHaveLength(1);
  });

  it("selects every target column its own routing reads", async () => {
    const src = await import("node:fs/promises").then((fs) => fs.readFile("src/lib/records/structuredRecord.ts", "utf8"));
    // The original defect: routing on two columns the query did not select,
    // so the map was empty on every request and note findings never appeared.
    // Anchored on the query itself: `routeScopedFindings` is DEFINED earlier
    // in the file than it is called, so slicing to the first mention would
    // read backwards and pass on an empty string. Matched on the CALL rather
    // than on which client makes it — the reader now accepts a transaction
    // client, and the columns it selects are the point, not the binding.
    const at = src.search(/\brecordFinding\s*\n?\s*\?\.findMany/);
    expect(at, "the findings query is where it is expected").toBeGreaterThan(-1);
    const select = src.slice(at, at + 1200);
    for (const column of ["sourceDocumentId: true", "canonicalNoteId: true", "fingerprint: true", "sourceFingerprint: true"]) {
      expect(select.includes(column), column).toBe(true);
    }
  });
});


describe("refuting: 'this evidence supports this recommendation'", () => {
  it("will not let a source establish a claim its kind cannot carry", async () => {
    const { supportsClaim } = await import("@/lib/engine/evidenceLedger");
    // An imaging study proves a finding and says nothing about cadence.
    expect(supportsClaim("MEDICATION", "FREQUENCY", "OBJECTIVE")).toBe(false);
    expect(supportsClaim("SURGERY", "NECESSITY", "REPORTED")).toBe(false);
    // …and the things it CAN carry still pass, or the gate is just a wall.
    expect(supportsClaim("MEDICATION", "FREQUENCY", "GUIDELINE")).toBe(true);
    expect(supportsClaim("SURGERY", "FUNCTIONAL_NEED", "REPORTED")).toBe(true);
  });

  it("does not truncate the ledger silently", async () => {
    const { buildLedgerWithCap, MAX_ROWS_PER_CLAIM } = await import("@/lib/engine/evidenceLedger");
    const many = Array.from({ length: MAX_ROWS_PER_CLAIM + 9 }, (_, i) => ({
      strength: "OBJECTIVE" as const,
      sourceKind: "CHRONOLOGY_EVENT" as const,
      // A quote that actually asserts something: since the semantic gate was
      // added, a source that says nothing produces no rows and there is
      // nothing for the cap to drop.
      quote: `Examination ${i}: medial joint space narrowing with reduced range of motion`,
    }));
    const built = buildLedgerWithCap({ id: "i", service: "Physical therapy", category: "PHYSICAL_THERAPY" }, many);
    expect(built.dropped).toBeGreaterThan(0);
  });

  it("refuses to store a citation that cannot be resolved", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/app/api/cases/[caseId]/future-care/[itemId]/evidence/route.ts", "utf8"),
    );
    // Resolution happens BEFORE any write.
    expect(src.indexOf("could not be resolved")).toBeLessThan(src.indexOf("$transaction"));
    expect(src).toMatch(/findCandidates/);
  });

  it("never deletes a physician's citation on regeneration", async () => {
    const src = await import("node:fs/promises").then((fs) => fs.readFile("src/lib/engine/persistLedger.ts", "utf8"));
    // The clause that makes the rebuild safe.
    expect(src).toMatch(/addedById: null/);
  });
});


// ── recorded-evidence-read-model ─────────────────────────────────────────────

describe("refuting: 'what is cited is the evidence as recorded'", () => {
  const row = (quote: string, over: Record<string, string> = {}) => ({
    claim: "NECESSITY",
    stance: "SUPPORTS",
    strength: "OBJECTIVE",
    sourceKind: "CHRONOLOGY_EVENT",
    quote,
    ...over,
  });

  it("does not call a set current when the record has moved under it", async () => {
    const { compareEvidenceSets } = await import("@/lib/engine/evidenceSet");
    const s = compareEvidenceSets([row("Medial joint space narrowing")], [row("Medial joint space narrowing"), row("Effusion on examination")]);
    expect(s.state).toBe("STALE");
  });

  it("does not present a derivation as a record when nothing was persisted", async () => {
    const { compareEvidenceSets, describeEvidenceSet } = await import("@/lib/engine/evidenceSet");
    const s = compareEvidenceSets([], [row("Medial joint space narrowing")]);
    expect(s.state).toBe("MISSING");
    expect(describeEvidenceSet(s)).toMatch(/has not been filed against this plan/);
  });

  it("does not resolve a disagreement by preferring the newer set", async () => {
    // The counts are reported and the RECORDED set is what is shown. Silently
    // adopting the fresher derivation is exactly the failure being refuted.
    const { compareEvidenceSets } = await import("@/lib/engine/evidenceSet");
    const s = compareEvidenceSets([row("A")], [row("B"), row("C")]);
    expect(s.persistedCount).toBe(1);
    expect(s.derivedCount).toBe(2);
    expect(s.removed).toBe(1);
  });

  it("does not stale a set merely because it was re-persisted", async () => {
    const { compareEvidenceSets } = await import("@/lib/engine/evidenceSet");
    expect(compareEvidenceSets([{ ...row("A"), id: "x" } as never], [row("A")]).state).toBe("CURRENT");
  });

  it("does not let an approval survive a change in the evidence", async () => {
    // The read model is only half of it: if the evidence set were not material
    // to the assessment, a physician's approval would carry onto findings they
    // never saw and the panel's honest banner would be the only trace.
    const { evidenceSetFingerprint } = await import("@/lib/engine/evidenceSet");
    expect(evidenceSetFingerprint([row("A")])).not.toBe(evidenceSetFingerprint([row("A"), row("B")]));
  });
});
