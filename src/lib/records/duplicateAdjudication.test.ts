import { describe, expect, it } from "vitest";
import { adjudicateDuplicates, candidatePairs, type DuplicatePair } from "@/lib/records/duplicateAdjudication";
import {
  classesCompatible,
  foldAdjudicatedPairs,
  identityFactsOfMergedEntry,
  isSameRecordAcrossDocuments,
  mergeRows,
  providerKey,
  sameNamedAuthor,
  type MergeableRow,
  type MergedEntry,
} from "@/lib/records/entryMerge";
import type { LlmProvider } from "@/lib/llm";

const DAY = new Date("2023-05-29T00:00:00Z");

const entry = (over: Partial<MergeableRow>, ...values: string[]): MergedEntry =>
  mergeRows([
    {
      id: `${over.sourceDocumentId}-row`,
      sourceDocumentId: "doc",
      analysisClass: "CLINICAL_ENCOUNTER",
      encounterDate: DAY,
      provider: null,
      facility: null,
      page: null,
      pageEnd: null,
      substanceClass: "CLINICAL",
      dateStatus: "DOCUMENTED",
      claims: values.map((value, i) => ({ field: "assessment", value, excerpt: `e${i}` })),
      ...over,
    } as MergeableRow,
  ])[0];

const deps = {
  sameNamedAuthor,
  namesSomeone: (entry: MergedEntry) => providerKey(entry.provider) !== null,
  settledByRules: isSameRecordAcrossDocuments,
  factsOf: identityFactsOfMergedEntry,
  compatibleClass: classesCompatible,
};

/** A provider that answers exactly what a test tells it to. */
const provider = (reply: string | (() => never)): LlmProvider =>
  ({
    complete: async () => {
      if (typeof reply === "function") reply();
      return reply as string;
    },
  }) as unknown as LlmProvider;

const yes = provider('{"same_encounter": true, "confidence": "high", "reason": "one visit described twice"}');
const hedged = provider('{"same_encounter": true, "confidence": "medium", "reason": "consistent but not certain"}');
const no = provider('{"same_encounter": false, "confidence": "high", "reason": "an operation and the discharge after it"}');

const HOSPITAL = { sourceDocumentId: "hospital", provider: "ENGLISH, PAUL W" };
const THERAPY = { sourceDocumentId: "therapy", provider: "Paul English, MD" };

const edPair = (): [MergedEntry, MergedEntry] => [
  entry(HOSPITAL, "Emergency department visit for fall with left knee and hip pain", "Toradol administered, discharged home"),
  entry(THERAPY, "Emergency department visit for fall with knee and lip contusions", "X-rays showed no fractures, discharged with ibuprofen"),
];

describe("choosing which pairs to ask about", () => {
  it("offers the pair the rules could not settle", () => {
    const [a, b] = edPair();
    const pairs = candidatePairs([a, b], deps);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reason).toMatch(/same clinician and date/);
  });

  it("does not offer a pair the rules already settled", () => {
    // Whatever the rules decide, they decide. This only sees the residue.
    const same = entry(HOSPITAL, "Emergency department visit for fall with left knee and hip pain", "Toradol administered, discharged home");
    const copy = entry(THERAPY, "Emergency department visit for fall with left knee and hip pain", "Toradol administered, discharged home");
    const pairs = candidatePairs([same, copy], deps);
    for (const pair of pairs) expect(isSameRecordAcrossDocuments(pair.a, pair.b)).toBe(false);
  });

  it("never offers two records from one document", () => {
    const a = entry({ sourceDocumentId: "d1", provider: "Paul English, MD" }, "Emergency department visit for fall");
    const b = entry({ sourceDocumentId: "d1", provider: "ENGLISH, PAUL W" }, "Emergency department visit for a fall with knee pain");
    expect(candidatePairs([a, b], deps)).toHaveLength(0);
  });

  it("never offers records on different days", () => {
    const [a] = edPair();
    const b = { ...edPair()[1], encounterDate: new Date("2023-06-02T00:00:00Z") };
    expect(candidatePairs([a, b], deps)).toHaveLength(0);
  });

  it("never offers records that do not name the same clinician", () => {
    const a = entry(HOSPITAL, "Emergency department visit for fall with left knee and hip pain");
    const b = entry({ sourceDocumentId: "therapy", provider: "Michael Crone, DC" }, "Emergency department visit for fall with knee pain");
    expect(candidatePairs([a, b], deps)).toHaveLength(0);
  });

  it("never routes two differently-named clinicians through any path, however alike they read", () => {
    // Word-for-word identical, and still two records: two clinicians did not
    // write one note.
    const same = "MRI lumbar spine without contrast showed multilevel disc herniations with moderate stenosis at L4-5";
    const a = entry({ sourceDocumentId: "d1", provider: "Paul English, MD" }, same);
    const b = entry({ sourceDocumentId: "d2", provider: "Michael Crone, DC" }, same);
    expect(candidatePairs([a, b], deps)).toHaveLength(0);
  });

  it("labels each pair with what is actually known about its authorship", () => {
    // The prompt asserted "both entries name the same clinician" for every
    // pair, which was false for the unattributed ones — the model answered on
    // evidence it had been told incorrectly.
    const [a, b] = edPair();
    expect(candidatePairs([a, b], deps)[0].attribution).toBe("SAME_CLINICIAN");

    const un1 = entry({ sourceDocumentId: "hospital" }, "MRI lumbar spine without contrast showed multilevel disc herniations with moderate stenosis at L4-5");
    const un2 = entry({ sourceDocumentId: "imaging" }, "MRI of the lumbar spine demonstrated multilevel disc herniations with moderate stenosis at L4-5");
    expect(candidatePairs([un1, un2], deps)[0].attribution).toBe("BOTH_UNATTRIBUTED");
  });

  it("treats a half-attributed pair as its own case, at a higher bar", () => {
    // "One names Dr A, the other names nobody" carries a live possibility that
    // the unnamed record belongs to somebody else.
    // Worded differently enough that the deterministic rules cannot settle it,
    // but far past the higher bar a half-attributed pair must clear.
    const named = entry(
      { sourceDocumentId: "hospital", provider: "Paul English, MD" },
      "MRI lumbar spine without contrast showed multilevel disc herniations with moderate stenosis at L4-5",
    );
    const unnamed = entry(
      { sourceDocumentId: "imaging" },
      "MRI lumbar spine without contrast showed multilevel disc herniations with moderate stenosis at L4-5 noted",
    );
    const pairs = candidatePairs([named, unnamed], deps);
    expect(pairs[0]?.attribution).toBe("ONE_ATTRIBUTED");
    expect(pairs[0]?.reason).toMatch(/names a clinician and the other does not/);
  });

  it("holds a half-attributed pair to a higher bar than an unattributed one", () => {
    const named = entry({ sourceDocumentId: "d1", provider: "Paul English, MD" }, "Emergency visit for a fall with left knee pain and swelling noted");
    const unnamed = entry({ sourceDocumentId: "d2" }, "Emergency visit for a fall with left knee pain and bruising documented");
    // Same texts with neither attributed would qualify; half-attributed does not.
    const bothUnnamed = [
      entry({ sourceDocumentId: "d1" }, "Emergency visit for a fall with left knee pain and swelling noted"),
      entry({ sourceDocumentId: "d2" }, "Emergency visit for a fall with left knee pain and bruising documented"),
    ];
    expect(candidatePairs(bothUnnamed, deps).length).toBeGreaterThanOrEqual(
      candidatePairs([named, unnamed], deps).length,
    );
  });

  it("offers two unattributed records that read alike", () => {
    // Four duplicate pairs survived with no clinician named on either side, so
    // a shared name could not be the reason to ask. Resemblance is.
    const a = entry({ sourceDocumentId: "hospital" }, "MRI lumbar spine without contrast showed multilevel disc herniations with moderate stenosis at L4-5");
    const b = entry({ sourceDocumentId: "imaging" }, "MRI of the lumbar spine demonstrated multilevel disc herniations with moderate stenosis at L4-5");
    const pairs = candidatePairs([a, b], deps);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reason).toMatch(/neither record names a clinician/);
  });

  it("does not offer two unattributed records that merely share a date", () => {
    // Without this every pair of records on a busy admission date would be a
    // question, and almost none of them a duplicate.
    const a = entry({ sourceDocumentId: "d1" }, "Physical therapy session with electrical stimulation to the lumbar region");
    const b = entry({ sourceDocumentId: "d2" }, "Anesthesia consent signed for planned epidural steroid injection");
    expect(candidatePairs([a, b], deps)).toHaveLength(0);
  });

  it("does not treat a record naming a different clinician as unattributed", () => {
    const a = entry(HOSPITAL, "MRI lumbar spine showed multilevel disc herniations with moderate stenosis");
    const b = entry({ sourceDocumentId: "imaging", provider: "Michael Crone, DC" }, "MRI lumbar spine showed multilevel disc herniations with moderate stenosis");
    expect(candidatePairs([a, b], deps)).toHaveLength(0);
  });

  it("never offers an undated record", () => {
    const [a, b] = edPair();
    expect(candidatePairs([a, { ...b, encounterDate: null }], deps)).toHaveLength(0);
  });
});

describe("the verdict", () => {
  it("merges only on a confident yes", async () => {
    const [a, b] = edPair();
    const pairs = candidatePairs([a, b], deps);
    const result = await adjudicateDuplicates(pairs, { provider: yes });
    expect(result.merged).toHaveLength(1);
    expect(foldAdjudicatedPairs([a, b], result.merged)).toHaveLength(1);
  });

  it("keeps a hedged answer separate", async () => {
    // "Medium" on a question this consequential is a no.
    const pairs = candidatePairs(edPair(), deps);
    const result = await adjudicateDuplicates(pairs, { provider: hedged });
    expect(result.merged).toHaveLength(0);
  });

  it("keeps two records apart when told they are different", async () => {
    const pairs = candidatePairs(edPair(), deps);
    const result = await adjudicateDuplicates(pairs, { provider: no });
    expect(result.merged).toHaveLength(0);
    expect(result.verdicts[0].verdict.reason).toMatch(/discharge/);
  });

  it("keeps records apart when the adjudicator fails", async () => {
    const pairs = candidatePairs(edPair(), deps);
    const result = await adjudicateDuplicates(pairs, {
      provider: provider(() => {
        throw new Error("upstream timeout");
      }),
    });
    expect(result.merged).toHaveLength(0);
    expect(result.failed).toBe(1);
  });

  it("keeps records apart when the answer is malformed", async () => {
    const pairs = candidatePairs(edPair(), deps);
    const result = await adjudicateDuplicates(pairs, { provider: provider("not json at all") });
    expect(result.merged).toHaveLength(0);
    expect(result.failed).toBe(1);
  });

  it("asks nothing when there is nothing undecided", async () => {
    const result = await adjudicateDuplicates([], { provider: yes });
    expect(result.asked).toBe(0);
  });
});

describe("folding what the adjudicator joined", () => {
  it("keeps every claim and records both documents", async () => {
    const [a, b] = edPair();
    const folded = foldAdjudicatedPairs([a, b], [{ a, b } as DuplicatePair]);
    expect(folded).toHaveLength(1);
    // Merging must never lose a fact, and the provenance of both copies stays.
    expect(folded[0].claims.length).toBeGreaterThanOrEqual(a.claims.length);
    expect(folded[0].alsoInDocumentIds).toContain("therapy");
  });

  it("folds a record recognised in three productions into one", () => {
    const a = entry(HOSPITAL, "Emergency department visit for fall");
    const b = entry(THERAPY, "Emergency department visit for a fall");
    const c = entry({ sourceDocumentId: "third", provider: "English Paul W" }, "Emergency visit after a fall");
    const folded = foldAdjudicatedPairs([a, b, c], [{ a, b }, { a: b, b: c }] as DuplicatePair[]);
    expect(folded).toHaveLength(1);
  });

  it("leaves everything alone when nothing was joined", () => {
    const [a, b] = edPair();
    expect(foldAdjudicatedPairs([a, b], [])).toHaveLength(2);
  });
});
