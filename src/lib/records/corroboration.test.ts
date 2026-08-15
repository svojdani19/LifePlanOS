import { describe, expect, it } from "vitest";
import { claimReproduced, corroborateRows, meetsCorroborationBar, spanTextFor, type CorroborationRow } from "@/lib/records/corroboration";
import type { LlmProvider } from "@/lib/llm";

// Synthetic throughout. Corroboration is INDEPENDENT reproduction: a second
// reading of the source, blind to the stored claims, must state the same
// facts. It is evidence about transcription, never attestation — and nothing
// here may promote a row past the human gate.

const PAGE = `Page 1
Progress Note Date of Service: 03/18/2024
Provider: Dana Rivers, MD
Assessment: Lumbar radiculopathy
Plan: Continue physical therapy twice weekly
Page 2
Billing summary follows.`;

const row = (over: Partial<CorroborationRow> = {}): CorroborationRow => ({
  id: "row-1",
  status: "AI_AUDIT_PASSED",
  dateStatus: "DOCUMENTED",
  page: 1,
  pageEnd: 1,
  warnings: [],
  claims: [
    { field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy" },
    { field: "treatment", value: "Continue physical therapy twice weekly", excerpt: "Plan: Continue physical therapy twice weekly" },
  ],
  ...over,
});

describe("only rows already clean on every server-side check are asked about", () => {
  it("accepts an audit-passed, documented-date row whose excerpts are verbatim", () => {
    expect(meetsCorroborationBar(row(), PAGE)).toBe(true);
  });

  it("refuses a row the audit did not pass", () => {
    expect(meetsCorroborationBar(row({ status: "AI_DRAFT" }), PAGE)).toBe(false);
  });

  it("refuses an inferred or unknown date", () => {
    expect(meetsCorroborationBar(row({ dateStatus: "INFERRED" }), PAGE)).toBe(false);
    expect(meetsCorroborationBar(row({ dateStatus: "UNKNOWN" }), PAGE)).toBe(false);
  });

  it("refuses a row carrying warnings", () => {
    expect(meetsCorroborationBar(row({ warnings: ["date inherited from a neighbouring entry"] }), PAGE)).toBe(false);
  });

  it("refuses a row with a demoted or flagged claim", () => {
    const claims = [{ field: "treatment", value: "Therapy", excerpt: "Plan: Continue physical therapy twice weekly", warning: "claim type demoted" }];
    expect(meetsCorroborationBar(row({ claims }), PAGE)).toBe(false);
  });

  it("refuses an excerpt that is not found verbatim in the source", () => {
    // A fuzzy-matched citation is a reviewer's question, not a candidate.
    const claims = [{ field: "assessment", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radikulopathy" }];
    expect(meetsCorroborationBar(row({ claims }), PAGE)).toBe(false);
  });

  it("refuses a row with no claims at all", () => {
    expect(meetsCorroborationBar(row({ claims: [] }), PAGE)).toBe(false);
  });

  it("refuses a claim carrying no excerpt to check", () => {
    expect(meetsCorroborationBar(row({ claims: [{ field: "assessment", value: "Lumbar radiculopathy", excerpt: "   " }] }), PAGE)).toBe(false);
  });

  it("accepts a SHORT excerpt that appears verbatim", () => {
    // The ≥12-character floor belongs to fuzzy matching; this test is exact
    // containment. Carrying the floor over silently excluded every billing
    // row — CPT codes and dollar amounts are short by nature — which is how
    // the first live run produced zero candidates from seventeen eligible rows.
    const bill = "Page 1\nDate of Service: 03/18/2024\n99233 subsequent hospital care $950.00";
    const billRow = row({
      claims: [
        { field: "procedure", value: "99233 subsequent hospital care", excerpt: "99233" },
        { field: "charges", value: "Charge of $950.00", excerpt: "$950.00" },
      ],
    });
    expect(meetsCorroborationBar(billRow, bill)).toBe(true);
  });
});

describe("comparing an independent reading to the stored facts", () => {
  it("counts a fact reproduced when the wording differs but the substance matches", () => {
    expect(claimReproduced("Lumbar radiculopathy", ["The note records an assessment of lumbar radiculopathy."])).toBe(true);
  });

  it("does not count a fact the reading never states", () => {
    expect(claimReproduced("Lumbar radiculopathy", ["The patient was given discharge instructions."])).toBe(false);
  });

  it("does not count a near-miss on the distinctive terms", () => {
    expect(claimReproduced("Continue physical therapy twice weekly", ["Physical therapy was discontinued."])).toBe(false);
  });
});

describe("the span sent to the independent reader", () => {
  it("is the row's own pages, not the whole document", () => {
    const span = spanTextFor(row(), PAGE);
    expect(span).toContain("Lumbar radiculopathy");
    expect(span).not.toContain("Billing summary follows");
  });
});

const reader = (reply: string): LlmProvider => ({ complete: async () => reply, model: "fake-model" }) as unknown as LlmProvider;

describe("recording a verdict", () => {
  it("corroborates when the independent reading reproduces every fact", async () => {
    const out = await corroborateRows([row()], PAGE, {
      provider: reader(
        JSON.stringify({
          facts: [
            { statement: "The assessment is lumbar radiculopathy." },
            { statement: "The plan is to continue physical therapy twice weekly." },
          ],
        }),
      ),
    });
    expect(out.corroborated).toBe(1);
    const verdict = out.verdicts.get("row-1")!;
    expect(verdict.result).toBe("CORROBORATED");
    expect(verdict.reproduced).toBe(2);
    expect(verdict.total).toBe(2);
    expect(verdict.unreproducedFields).toEqual([]);
  });

  it("records NOT_CORROBORATED, by field, when a fact is not reproduced", async () => {
    const out = await corroborateRows([row()], PAGE, {
      provider: reader(JSON.stringify({ facts: [{ statement: "The assessment is lumbar radiculopathy." }] })),
    });
    expect(out.corroborated).toBe(0);
    const verdict = out.verdicts.get("row-1")!;
    expect(verdict.result).toBe("NOT_CORROBORATED");
    expect(verdict.unreproducedFields).toEqual(["treatment"]);
    // Field names only: a verdict never carries record content.
    expect(JSON.stringify(verdict)).not.toContain("physical therapy");
  });

  it("records nothing when the reader is malformed or throws", async () => {
    const bad = await corroborateRows([row()], PAGE, { provider: reader("I read the page and it looks right.") });
    expect(bad.failed).toBe(1);
    expect(bad.verdicts.size).toBe(0);
    const boom = await corroborateRows([row()], PAGE, {
      provider: { complete: async () => { throw new Error("timeout"); } } as unknown as LlmProvider,
    });
    expect(boom.failed).toBe(1);
    expect(boom.verdicts.size).toBe(0);
  });

  it("asks nothing when no row meets the bar", async () => {
    const out = await corroborateRows([row({ status: "AI_DRAFT" })], PAGE, {
      provider: { complete: async () => { throw new Error("must not be called"); } } as unknown as LlmProvider,
    });
    expect(out.asked).toBe(0);
  });

  it("never yields a status: corroboration is evidence, not attestation", async () => {
    // The verdict shape carries no status field at all, so no caller can
    // accidentally promote a row to VERIFIED on the strength of it.
    const out = await corroborateRows([row()], PAGE, {
      provider: reader(
        JSON.stringify({
          facts: [
            { statement: "The assessment is lumbar radiculopathy." },
            { statement: "The plan is to continue physical therapy twice weekly." },
          ],
        }),
      ),
    });
    const verdict = out.verdicts.get("row-1")! as unknown as Record<string, unknown>;
    expect(verdict.status).toBeUndefined();
    expect(Object.values(verdict)).not.toContain("VERIFIED");
  });
});
