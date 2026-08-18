import { describe, it, expect } from "vitest";
import { compareEvidenceSets, describeEvidenceSet, evidenceRowKey, evidenceSetFingerprint, type EvidenceRowIdentity } from "@/lib/engine/evidenceSet";

const row = (over: Partial<EvidenceRowIdentity> = {}): EvidenceRowIdentity => ({
  claim: "NECESSITY",
  stance: "SUPPORTS",
  strength: "OBJECTIVE",
  sourceKind: "CHRONOLOGY_EVENT",
  quote: "MRI shows L4-5 disc herniation",
  ...over,
});

describe("an evidence set has a stable identity", () => {
  it("ignores the order the rows arrive in", () => {
    const a = [row(), row({ quote: "Positive straight leg raise" })];
    expect(evidenceSetFingerprint(a)).toBe(evidenceSetFingerprint([...a].reverse()));
  });

  it("ignores whitespace differences inside a quote", () => {
    expect(evidenceRowKey(row({ quote: "MRI  shows\nL4-5 disc herniation " }))).toBe(evidenceRowKey(row()));
  });

  it("changes when the stance changes — direction is part of the evidence", () => {
    expect(evidenceSetFingerprint([row()])).not.toBe(evidenceSetFingerprint([row({ stance: "OPPOSES" })]));
  });

  it("changes when a row is added or removed", () => {
    expect(evidenceSetFingerprint([row()])).not.toBe(evidenceSetFingerprint([row(), row({ quote: "Antalgic gait" })]));
  });

  it("carries the builder version, so re-reading the same records under new rules is a new set", () => {
    expect(evidenceSetFingerprint([row()])).toMatch(/^2026-/);
  });
});

describe("what was recorded is compared against what the record now produces", () => {
  it("is CURRENT when they match", () => {
    const s = compareEvidenceSets([row()], [row()]);
    expect(s.state).toBe("CURRENT");
    expect(describeEvidenceSet(s)).toBeNull();
  });

  it("is MISSING when nothing was ever recorded", () => {
    const s = compareEvidenceSets([], [row()]);
    expect(s.state).toBe("MISSING");
    expect(describeEvidenceSet(s)).toMatch(/No evidence ledger has been recorded/);
  });

  it("is STALE when the record has moved, and says which way", () => {
    const s = compareEvidenceSets([row(), row({ quote: "Antalgic gait" })], [row(), row({ quote: "Effusion on examination" })]);
    expect(s.state).toBe("STALE");
    expect(s.added).toBe(1);
    expect(s.removed).toBe(1);
    expect(describeEvidenceSet(s)).toMatch(/no longer matches the record/);
  });

  it("does not resolve the difference — it reports both counts", () => {
    // Which set is right is a question about the case. A render must not
    // answer it by quietly preferring the newer one.
    const s = compareEvidenceSets([row()], [row(), row({ quote: "Antalgic gait" })]);
    expect(s.persistedCount).toBe(1);
    expect(s.derivedCount).toBe(2);
  });

  it("does not call a set stale for being re-persisted unchanged", () => {
    // Ids and timestamps are deliberately not part of the identity.
    const persisted = [{ ...row(), id: "x", addedAt: new Date() } as unknown as EvidenceRowIdentity];
    expect(compareEvidenceSets(persisted, [row()]).state).toBe("CURRENT");
  });
});
