import { describe, it, expect } from "vitest";
import type { FdeInput } from "./damagesEvaluation";
import { computeInputsHash, type FdeRowIds } from "./damagesFingerprint";

// The fingerprint is the staleness oracle for persisted damages evaluations:
// stored hash !== current hash ⇔ the engine's inputs changed since evaluation.
// These tests pin down determinism (same facts → same hash, always) and
// sensitivity (any observable input change → different hash).

function baseInput(): FdeInput {
  return {
    conditions: [
      { name: "Lumbar disc herniation", relatedness: "RELATED", evidenceSourceCount: 3 },
      { name: "Cervical strain", relatedness: "UNCLEAR", evidenceSourceCount: 0 },
    ],
    items: [
      {
        service: "Revision surgery",
        category: "ORTHOPEDIC_SURGERY",
        probability: "PROBABLE",
        physicianStatus: "APPROVED",
        isLifetime: false,
        durationYears: 1,
        presentValue: 85000,
        contingencyOnly: false,
        origin: "AI_EXTRACTED",
      },
      {
        service: "Attendant care",
        category: "ATTENDANT_CARE",
        probability: "PROBABLE",
        physicianStatus: "PENDING",
        isLifetime: true,
        durationYears: null,
        presentValue: 400000,
        contingencyOnly: false,
        origin: "PLANNER_ADDED",
      },
    ],
    findings: [{ result: "Work restriction documented", severity: "INFO", exportBlocking: false }],
    documentsCount: 12,
    chronologyCount: 34,
    vocationalEntryCount: 1,
    econAssumptionCount: 2,
    interviews: true,
    missingRecordSignals: ["Missing PT records 2025", "Missing imaging report"],
  };
}

const baseRows: FdeRowIds = {
  conditionIds: ["cond-1", "cond-2"],
  itemIds: ["item-1", "item-2"],
  findingIds: ["find-1"],
};

describe("computeInputsHash — determinism", () => {
  it("returns an identical sha256 hex hash for identical inputs across calls", () => {
    const a = computeInputsHash(baseInput(), baseRows);
    const b = computeInputsHash(baseInput(), { ...baseRows });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is insensitive to array order — DB row order can never flag stale", () => {
    const reordered = baseInput();
    reordered.conditions.reverse();
    reordered.items.reverse();
    reordered.missingRecordSignals.reverse();
    const rowsReordered: FdeRowIds = {
      conditionIds: ["cond-2", "cond-1"],
      itemIds: ["item-2", "item-1"],
      findingIds: ["find-1"],
    };
    expect(computeInputsHash(reordered, rowsReordered)).toBe(computeInputsHash(baseInput(), baseRows));
  });

  it("is insensitive to object key order", () => {
    const shuffled = baseInput();
    // Rebuild an item with keys in a different insertion order.
    const [first, ...rest] = shuffled.items;
    shuffled.items = [
      {
        origin: first.origin,
        contingencyOnly: first.contingencyOnly,
        presentValue: first.presentValue,
        durationYears: first.durationYears,
        isLifetime: first.isLifetime,
        physicianStatus: first.physicianStatus,
        probability: first.probability,
        category: first.category,
        service: first.service,
      },
      ...rest,
    ];
    expect(computeInputsHash(shuffled, baseRows)).toBe(computeInputsHash(baseInput(), baseRows));
  });
});

describe("computeInputsHash — stale detection", () => {
  const fresh = computeInputsHash(baseInput(), baseRows);

  it("changes when a substantive item field changes (physician decision)", () => {
    const input = baseInput();
    input.items[1].physicianStatus = "APPROVED";
    expect(computeInputsHash(input, baseRows)).not.toBe(fresh);
  });

  it("changes when a condition's relatedness is resolved", () => {
    const input = baseInput();
    input.conditions[1].relatedness = "RELATED";
    expect(computeInputsHash(input, baseRows)).not.toBe(fresh);
  });

  it("changes when a child row is added or removed, even if counts elsewhere match", () => {
    const input = baseInput();
    input.findings.push({ result: "New blocking finding", severity: "ERROR", exportBlocking: true });
    const rows: FdeRowIds = { ...baseRows, findingIds: ["find-1", "find-2"] };
    expect(computeInputsHash(input, rows)).not.toBe(fresh);

    // Row replaced by an identical-looking row: payload identical, id differs.
    const swapped: FdeRowIds = { ...baseRows, itemIds: ["item-1", "item-3"] };
    expect(computeInputsHash(baseInput(), swapped)).not.toBe(fresh);
  });

  it("changes when counts, interview presence, or missing-record signals change", () => {
    const docs = baseInput();
    docs.documentsCount += 1;
    expect(computeInputsHash(docs, baseRows)).not.toBe(fresh);

    const interviews = baseInput();
    interviews.interviews = false;
    expect(computeInputsHash(interviews, baseRows)).not.toBe(fresh);

    const signals = baseInput();
    signals.missingRecordSignals = ["Missing PT records 2025"];
    expect(computeInputsHash(signals, baseRows)).not.toBe(fresh);
  });
});
