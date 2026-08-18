// ─────────────────────────────────────────────────────────────────────────────
// The leakage test.
//
// One lumbar diagnosis, five recommended services, and evidence that supports
// exactly one claim each. Before the ledger, `eventPertains()` matched by body
// region or by any word of the diagnosis name, so all five drew the same pool:
// an MRI finding appeared under the medication, the physical-therapy note
// appeared under the fusion, and every panel implied it was supported by
// findings that established only the condition.
//
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import {
  buildLedgerForItem,
  buildLedgerWithCap,
  claimsSupportedBy,
  MAX_ROWS_PER_CLAIM,
  rankForDisplay,
  serviceKindOf,
  supportsClaim,
  type CandidateSource,
} from "@/lib/engine/evidenceLedger";

// ── The five services of one lumbar diagnosis ───────────────────────────────
const PT = { id: "i-pt", service: "Physical therapy", category: "PHYSICAL_THERAPY", conditionId: "c-1" };
const MRI = { id: "i-mri", service: "MRI lumbar spine", category: "IMAGING", conditionId: "c-1" };
const INJ = { id: "i-inj", service: "Lumbar epidural steroid injection", category: "INJECTION", conditionId: "c-1" };
const MED = { id: "i-med", service: "Gabapentin", category: "MEDICATION", conditionId: "c-1" };
const SURG = { id: "i-surg", service: "Lumbar fusion", category: "ORTHOPEDIC_SURGERY", conditionId: "c-1" };
const ALL = [PT, MRI, INJ, MED, SURG];

const src = (over: Partial<CandidateSource> & { strength: CandidateSource["strength"]; quote: string }): CandidateSource => ({
  sourceKind: "CHRONOLOGY_EVENT",
  ...over,
});

describe("a service is only offered evidence that bears on it", () => {
  it("classifies each service by kind, from its category", () => {
    expect(ALL.map(serviceKindOf)).toEqual(["THERAPY", "IMAGING", "INJECTION", "MEDICATION", "SURGERY"]);
  });

  it("falls back to the service name when the category says nothing", () => {
    expect(serviceKindOf({ service: "MRI of the lumbar spine", category: null })).toBe("IMAGING");
    expect(serviceKindOf({ service: "Wheelchair and cushion", category: "MISC" })).toBe("EQUIPMENT");
  });

  it("does not let a patient's reported symptom establish that surgery is INDICATED", () => {
    // The quote states a DEFICIT, not just a symptom. Since the semantic gate
    // was added, "ongoing low back pain" alone establishes nothing: pain is a
    // symptom, and FUNCTIONAL_NEED asks what the patient cannot do.
    const reported = src({ strength: "REPORTED", quote: "Reports ongoing low back pain and difficulty standing for more than ten minutes" });
    expect(buildLedgerForItem(SURG, [reported]).some((r) => r.claim === "NECESSITY")).toBe(false);
    // …while the same report IS evidence of a functional need — for therapy,
    // and for surgery too. Impaired function is a primary indication for an
    // operation; what a patient's account cannot do is establish the
    // pathology. Those are two claims, and only the first is refused above.
    expect(buildLedgerForItem(PT, [reported]).some((r) => r.claim === "FUNCTIONAL_NEED")).toBe(true);
    expect(buildLedgerForItem(SURG, [reported]).some((r) => r.claim === "FUNCTIONAL_NEED")).toBe(true);
  });

  it("does not let an imaging finding establish a medication's frequency", () => {
    const imaging = src({ strength: "OBJECTIVE", quote: "MRI shows L5-S1 disc protrusion" });
    const claims = buildLedgerForItem(MED, [imaging]).map((r) => r.claim);
    expect(claims).toContain("NECESSITY");
    expect(claims).not.toContain("FREQUENCY");
    expect(claims).not.toContain("DURATION");
  });

  it("lets nothing but guidance or literature establish frequency or duration, for any service", () => {
    for (const item of ALL) {
      for (const strength of ["DIAGNOSIS", "OBJECTIVE", "HISTORY", "REPORTED"] as const) {
        expect(supportsClaim(serviceKindOf(item), "FREQUENCY", strength), `${item.service}/${strength}`).toBe(false);
        expect(supportsClaim(serviceKindOf(item), "DURATION", strength), `${item.service}/${strength}`).toBe(false);
      }
      expect(supportsClaim(serviceKindOf(item), "FREQUENCY", "GUIDELINE"), item.service).toBe(true);
    }
  });

  it("keeps a past-medical-history mention out of necessity for every service", () => {
    const history = src({ strength: "HISTORY", quote: "PMH: chronic low back pain" });
    for (const item of ALL) {
      expect(buildLedgerForItem(item, [history]).some((r) => r.claim === "NECESSITY"), item.service).toBe(false);
    }
  });
});

describe("evidence does not leak between the five services", () => {
  // Each source supports exactly one claim for exactly one service.
  const sources: Record<string, CandidateSource> = {
    ptNote: src({ strength: "REPORTED", quote: "Difficulty standing more than ten minutes" }),
    mriFinding: src({ strength: "OBJECTIVE", quote: "MRI shows L5-S1 disc protrusion with nerve root contact" }),
    guidelineCadence: src({ strength: "GUIDELINE", sourceKind: "GUIDELINE", quote: "Injections may be repeated up to three times per year" }),
    dx: src({ strength: "DIAGNOSIS", quote: "Assessment: lumbar radiculopathy" }),
  };

  it("gives the surgery a FUNCTIONAL claim from a patient report, but never a necessity one", () => {
    const rows = buildLedgerForItem(SURG, [sources.ptNote]);
    expect(rows.map((r) => r.claim)).toEqual(["FUNCTIONAL_NEED"]);
  });

  it("gives the medication no frequency from the injection's guideline cadence — only what its kind allows", () => {
    // The guideline is compatible in KIND with a medication frequency; the
    // caller is responsible for not offering another service's guideline as a
    // candidate. What the gate guarantees is that a non-cadence source never
    // becomes one.
    const fromObjective = buildLedgerForItem(MED, [sources.mriFinding]).filter((r) => r.claim === "FREQUENCY");
    expect(fromObjective).toHaveLength(0);
  });

  it("records the diagnosis as necessity evidence for every service, which is correct", () => {
    // The condition IS established for all five; that was never the defect.
    for (const item of ALL) {
      expect(buildLedgerForItem(item, [sources.dx]).some((r) => r.claim === "NECESSITY"), item.service).toBe(true);
    }
  });

  it("does not fabricate a row for a source that establishes nothing for this service", () => {
    // COST has no compatible strength at all — no source type can assert it.
    const rows = buildLedgerForItem(MRI, [sources.ptNote]);
    expect(rows.every((r) => r.claim !== "COST")).toBe(true);
  });

  it("drops a source that failed the anatomy gate, however apt its kind", () => {
    const wrongBodyPart = src({ strength: "OBJECTIVE", quote: "MRI of the left shoulder shows a rotator cuff tear", anatomyOk: false });
    expect(buildLedgerForItem(SURG, [wrongBodyPart])).toHaveLength(0);
  });
});

describe("direction is recorded, and absence is not opposition", () => {
  it("marks opposing evidence as opposing", () => {
    const against = src({ strength: "OBJECTIVE", quote: "Imaging shows no structural abnormality", opposes: true });
    expect(buildLedgerForItem(SURG, [against]).every((r) => r.stance === "OPPOSES")).toBe(true);
  });

  it("produces no row at all when there is simply nothing — silence is not opposition", () => {
    expect(buildLedgerForItem(SURG, [])).toHaveLength(0);
  });

  it("does not count one quote twice for the same claim", () => {
    const dup = src({ strength: "DIAGNOSIS", quote: "Assessment: lumbar radiculopathy" });
    const rows = buildLedgerForItem(PT, [dup, { ...dup }]);
    expect(rows.filter((r) => r.claim === "NECESSITY")).toHaveLength(1);
  });

  it("stamps every row with the builder version, so a stale ledger is visible", () => {
    const rows = buildLedgerForItem(PT, [src({ strength: "DIAGNOSIS", quote: "Assessment: lumbar radiculopathy" })]);
    expect(rows.every((r) => r.producerVersion.startsWith("2026-"))).toBe(true);
  });
});

describe("what a reviewer is shown first", () => {
  const row = (stance: "SUPPORTS" | "OPPOSES", strength: Parameters<typeof claimsSupportedBy>[1], daysAgo = 0) => ({
    stance,
    strength,
    recordedOn: new Date(Date.now() - daysAgo * 86_400_000),
  });

  it("puts opposing evidence first — a reviewer must not have to scroll for it", () => {
    const ranked = rankForDisplay([row("SUPPORTS", "DIAGNOSIS"), row("OPPOSES", "REPORTED")]);
    expect(ranked[0].stance).toBe("OPPOSES");
  });

  it("ranks a diagnosis above an objective finding, and both above a patient report", () => {
    const ranked = rankForDisplay([row("SUPPORTS", "REPORTED"), row("SUPPORTS", "OBJECTIVE"), row("SUPPORTS", "DIAGNOSIS")]);
    expect(ranked.map((r) => r.strength)).toEqual(["DIAGNOSIS", "OBJECTIVE", "REPORTED"]);
  });

  it("puts the more recent of two equals first", () => {
    const ranked = rankForDisplay([row("SUPPORTS", "OBJECTIVE", 400), row("SUPPORTS", "OBJECTIVE", 5)]);
    expect(ranked[0].recordedOn.getTime()).toBeGreaterThan(ranked[1].recordedOn.getTime());
  });

  it("does not mutate what it was given", () => {
    const input = [row("SUPPORTS", "REPORTED"), row("OPPOSES", "DIAGNOSIS")];
    const before = input.map((r) => r.stance);
    rankForDisplay(input);
    expect(input.map((r) => r.stance)).toEqual(before);
  });
});

describe("the ledger is capped, and says what it dropped", () => {
  const many = (n: number): CandidateSource[] =>
    // Each quote must actually ASSERT something, or the semantic gate correctly
    // produces no rows and there is nothing for the cap to act on.
    Array.from({ length: n }, (_, i) => src({ strength: "OBJECTIVE", quote: `Examination ${i}: medial joint space narrowing with reduced range of motion` }));

  it("keeps at most twelve rows per claim", () => {
    // Persisting every candidate produced 17,208 rows on the reference case,
    // up to 384 for one item. Nobody reads 384 rows, and storing them implies
    // a precision the selection does not have.
    const built = buildLedgerWithCap(PT, many(60));
    const perClaim = built.rows.reduce((m: Record<string, number>, r) => ((m[r.claim] = (m[r.claim] ?? 0) + 1), m), {});
    expect(Object.values(perClaim).every((n) => n <= MAX_ROWS_PER_CLAIM)).toBe(true);
  });

  it("reports the count it excluded rather than truncating silently", () => {
    const built = buildLedgerWithCap(PT, many(60));
    expect(built.dropped).toBeGreaterThan(0);
  });

  it("drops nothing when there is nothing to drop", () => {
    expect(buildLedgerWithCap(PT, many(3)).dropped).toBe(0);
  });

  it("keeps the STRONGEST rows, not the first ones it happened to see", () => {
    const weak = many(MAX_ROWS_PER_CLAIM + 5);
    const strong = src({ strength: "DIAGNOSIS", quote: "Assessment: lumbar radiculopathy" });
    // The strong one arrives last and must still survive the cap.
    const built = buildLedgerWithCap(PT, [...weak, strong]);
    const necessity = built.rows.filter((r) => r.claim === "NECESSITY");
    expect(necessity.some((r) => r.strength === "DIAGNOSIS")).toBe(true);
  });

  it("keeps opposing evidence over supporting evidence when the cap bites", () => {
    const supporting = many(MAX_ROWS_PER_CLAIM + 5);
    const against = src({ strength: "OBJECTIVE", quote: "Imaging shows no structural abnormality", opposes: true });
    const built = buildLedgerWithCap(PT, [...supporting, against]);
    expect(built.rows.some((r) => r.stance === "OPPOSES")).toBe(true);
  });
});

describe("display ranking survives the wire", () => {
  it("orders rows whose dates arrived as JSON strings", () => {
    // The persisted ledger reaches the panel as JSON, where a DateTime is a
    // string. Calling `.getTime()` on it threw and took the case page down.
    const rows = [
      { stance: "SUPPORTS" as const, strength: "OBJECTIVE" as const, recordedOn: "2024-01-05T00:00:00.000Z", tag: "old" },
      { stance: "SUPPORTS" as const, strength: "OBJECTIVE" as const, recordedOn: "2025-06-01T00:00:00.000Z", tag: "new" },
    ];
    expect(rankForDisplay(rows).map((r) => r.tag)).toEqual(["new", "old"]);
  });

  it("does not throw on a null or unparseable date", () => {
    const rows = [
      { stance: "SUPPORTS" as const, strength: "OBJECTIVE" as const, recordedOn: null },
      { stance: "SUPPORTS" as const, strength: "OBJECTIVE" as const, recordedOn: "not a date" },
    ];
    expect(() => rankForDisplay(rows)).not.toThrow();
  });
});

describe("the ledger a case produces does not depend on row order", () => {
  // 56 of 59 recommendations on the reference case reported as drifted after a
  // regeneration that changed nothing: undated findings of one strength tie on
  // every ranking key, `sort` is stable, and the cap therefore kept whichever
  // twelve the database happened to return first.
  const tied = (n: number): CandidateSource[] =>
    Array.from({ length: n }, (_, i) => ({
      strength: "OBJECTIVE" as const,
      sourceKind: "CHRONOLOGY_EVENT" as const,
      quote: `Examination ${i}: medial joint space narrowing with reduced range of motion`,
    }));

  it("keeps the same rows whichever order the candidates arrive in", () => {
    const forwards = buildLedgerWithCap(PT, tied(40));
    const backwards = buildLedgerWithCap(PT, [...tied(40)].reverse());
    expect(backwards.rows.map((r) => r.quote).sort()).toEqual(forwards.rows.map((r) => r.quote).sort());
  });

  it("ranks identically-graded undated rows in a stable, total order", () => {
    const rows = [
      { stance: "SUPPORTS" as const, strength: "OBJECTIVE" as const, recordedOn: null, quote: "b" },
      { stance: "SUPPORTS" as const, strength: "OBJECTIVE" as const, recordedOn: null, quote: "a" },
    ];
    expect(rankForDisplay(rows).map((r) => r.quote)).toEqual(["a", "b"]);
    expect(rankForDisplay([...rows].reverse()).map((r) => r.quote)).toEqual(["a", "b"]);
  });
});
