import { describe, it, expect } from "vitest";
import { buildProofCard, BASIS_LABEL, PHYSICIAN_DISPOSITION } from "@/lib/engine/proofCard";
import type { LedgerRow } from "@/lib/engine/evidenceLedger";

// The binding property: every line on this card comes from evidence accepted
// FOR THIS ITEM. Nothing is located by searching raw document text, which is
// how a causation card came to quote "Other risks and hazards which may result
// from the use of general anesthetics…" as support for a cervical cord injury.

const row = (over: Partial<LedgerRow> = {}): LedgerRow =>
  ({
    futureCareItemId: "item-1",
    conditionId: "cond-1",
    claim: "NECESSITY",
    stance: "SUPPORTS",
    strength: "OBJECTIVE",
    sourceKind: "RECORD_CLAIM",
    sourceDocumentId: "doc-1",
    encounterId: "enc-1",
    chronologyEventId: null,
    page: 4,
    field: "assessment",
    quote: "MRI positive for HNP - lumbar",
    recordedOn: new Date("2025-03-14T00:00:00Z"),
    sourceFingerprint: "fp",
    verbatim: true,
    producerVersion: "v1",
    ...over,
  }) as LedgerRow;

const item = (over: Record<string, unknown> = {}) => ({ id: "item-1", supportClass: "RECORD_RECOMMENDED", physicianStatus: "PENDING", ...over });

describe("buildProofCard selects only this item's accepted evidence", () => {
  it("ignores ledger rows belonging to another recommendation", () => {
    const card = buildProofCard({
      item: item(),
      ledger: [row({ futureCareItemId: "item-OTHER", quote: "someone else's proof", strength: "DIAGNOSIS" })],
    });
    expect(card.strongestSupport).toBeNull();
    expect(card.missingProof).toContain("No accepted record establishes the need for this service.");
  });

  it("picks the strongest supporting row, by source strength", () => {
    const card = buildProofCard({
      item: item(),
      ledger: [
        row({ strength: "LITERATURE", quote: "a study" }),
        row({ strength: "DIAGNOSIS", quote: "physician documented the need" }),
        row({ strength: "HISTORY", quote: "patient reported" }),
      ],
    });
    expect(card.strongestSupport?.quote).toBe("physician documented the need");
  });

  it("prefers a necessity claim over a frequency claim at equal strength", () => {
    const card = buildProofCard({
      item: item(),
      ledger: [row({ claim: "FREQUENCY", quote: "twice weekly" }), row({ claim: "NECESSITY", quote: "therapy is indicated" })],
    });
    expect(card.strongestSupport?.quote).toBe("therapy is indicated");
  });

  it("breaks ties on the EARLIEST record, not the most recent", () => {
    // The first appearance of a fact is the one a defense expert must account
    // for; a late note standing in for a contemporaneous one is weaker proof.
    const card = buildProofCard({
      item: item(),
      ledger: [
        row({ quote: "later note", recordedOn: new Date("2026-01-01T00:00:00Z") }),
        row({ quote: "contemporaneous note", recordedOn: new Date("2023-11-27T00:00:00Z") }),
      ],
    });
    expect(card.strongestSupport?.quote).toBe("contemporaneous note");
  });

  it("surfaces the strongest OPPOSING row separately", () => {
    const card = buildProofCard({
      item: item(),
      ledger: [
        row({ quote: "supports it" }),
        row({ stance: "OPPOSES", strength: "DIAGNOSIS", quote: "conservative care resolved the deficit" }),
        row({ stance: "OPPOSES", strength: "LITERATURE", quote: "a weaker objection" }),
      ],
    });
    expect(card.strongestSupport?.quote).toBe("supports it");
    expect(card.strongestOpposing?.quote).toBe("conservative care resolved the deficit");
  });

  it("never presents CONTEXT rows as support or opposition", () => {
    const card = buildProofCard({ item: item(), ledger: [row({ stance: "CONTEXT", quote: "background" })] });
    expect(card.strongestSupport).toBeNull();
    expect(card.strongestOpposing).toBeNull();
  });

  it("ignores an empty quote rather than rendering a blank citation", () => {
    const card = buildProofCard({ item: item(), ledger: [row({ quote: "   ", strength: "DIAGNOSIS" }), row({ quote: "real" })] });
    expect(card.strongestSupport?.quote).toBe("real");
  });

  it("carries the citation needed to check the quote", () => {
    const card = buildProofCard({ item: item(), ledger: [row()] });
    expect(card.strongestSupport).toMatchObject({
      sourceDocumentId: "doc-1",
      page: 4,
      field: "assessment",
      verbatim: true,
      recordedOn: "2025-03-14",
    });
  });

  it("marks a non-verbatim quote as derived prose", () => {
    const card = buildProofCard({ item: item(), ledger: [row({ verbatim: false, sourceKind: "CHRONOLOGY_EVENT" })] });
    expect(card.strongestSupport?.verbatim).toBe(false);
  });
});

describe("the card states what is NOT proven", () => {
  it("says so plainly when no accepted record supports the item", () => {
    const card = buildProofCard({ item: item({ supportClass: "CANDIDATE_REVIEW" }), ledger: [] });
    expect(card.missingProof[0]).toBe("No accepted record establishes the need for this service.");
  });

  it("carries the item's own recorded gap and the dossier's unknowns", () => {
    const card = buildProofCard({
      item: item({ missingSupport: "No documented functional dependence." }),
      ledger: [row()],
      unknowns: ["Urodynamics pending in records."],
    });
    expect(card.missingProof).toEqual(["No documented functional dependence.", "Urodynamics pending in records."]);
  });

  it("dedupes and bounds the list — a proof card is not a backlog", () => {
    const card = buildProofCard({
      item: item({ missingSupport: "same" }),
      ledger: [row()],
      unknowns: ["same", "a", "b", "c", "d", "e"],
    });
    expect(card.missingProof).toHaveLength(4);
    expect(card.missingProof.filter((m) => m === "same")).toHaveLength(1);
  });

  it("ignores blank unknowns", () => {
    const card = buildProofCard({ item: item(), ledger: [row()], unknowns: ["", "   "] });
    expect(card.missingProof).toEqual([]);
  });
});

describe("the card reports disposition, support class and basis freshness", () => {
  it.each(["APPROVED", "MODIFIED", "REJECTED", "PENDING"])("states the %s physician disposition", (status) => {
    const card = buildProofCard({ item: item({ physicianStatus: status }), ledger: [row()] });
    expect(card.physicianDisposition).toBe(PHYSICIAN_DISPOSITION[status]);
  });

  it("defaults an unknown disposition to pending rather than inventing one", () => {
    const card = buildProofCard({ item: item({ physicianStatus: "SOMETHING_NEW" }), ledger: [row()] });
    expect(card.physicianDisposition).toBe(PHYSICIAN_DISPOSITION.PENDING);
  });

  it("carries the canonical support class and whether it enters totals", () => {
    const supported = buildProofCard({ item: item({ supportClass: "RECORD_RECOMMENDED" }), ledger: [row()] });
    expect(supported.support.membership).toBe("SUPPORTED");
    const candidate = buildProofCard({ item: item({ supportClass: "CANDIDATE_REVIEW" }), ledger: [row()] });
    expect(candidate.support.membership).toBe("CANDIDATE");
    expect(candidate.support.title).toContain("not included in the supported total");
  });

  it.each(["CURRENT", "STALE", "MISSING", "INCOMPLETE", "UNREADABLE"])("reports the %s basis state", (state) => {
    const card = buildProofCard({ item: item(), ledger: [row()], basisState: { state } });
    expect(card.basis).toEqual({ state, label: BASIS_LABEL[state] });
  });

  it("treats an absent basis state as current rather than alarming", () => {
    expect(buildProofCard({ item: item(), ledger: [row()] }).basis.state).toBe("CURRENT");
    expect(buildProofCard({ item: item(), ledger: [row()], basisState: null }).basis.state).toBe("CURRENT");
  });

  it("uses only fixed phrases, so a signed card is stable and hashable", () => {
    // Nothing here is composed from model output or interpolated from case
    // data; the same inputs must always render the same sentences.
    for (const label of Object.values(BASIS_LABEL)) expect(label).not.toMatch(/\$\{|undefined|null/);
    for (const label of Object.values(PHYSICIAN_DISPOSITION)) expect(label).not.toMatch(/\$\{|undefined|null/);
  });
});
