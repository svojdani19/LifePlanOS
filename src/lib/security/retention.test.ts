import { describe, it, expect } from "vitest";
import { retentionCandidates, normalizeRetentionDays, MIN_RETENTION_DAYS } from "./retention";

const now = new Date("2026-07-27T00:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 3600 * 1000);

describe("normalizeRetentionDays", () => {
  it("null means retain forever", () => {
    expect(normalizeRetentionDays(null)).toBeNull();
    expect(normalizeRetentionDays(undefined)).toBeNull();
  });

  it("clamps to the floor so a typo cannot mass-purge", () => {
    expect(normalizeRetentionDays(1)).toBe(MIN_RETENTION_DAYS);
    expect(normalizeRetentionDays(365)).toBe(365);
  });
});

describe("retentionCandidates", () => {
  const cases = [
    { id: "closed-old", status: "CLOSED", updatedAt: daysAgo(400) },
    { id: "archived-old", status: "ARCHIVED", updatedAt: daysAgo(500) },
    { id: "closed-recent", status: "CLOSED", updatedAt: daysAgo(10) },
    { id: "active-ancient", status: "FINAL", updatedAt: daysAgo(2000) },
    { id: "intake-ancient", status: "INTAKE", updatedAt: daysAgo(2000) },
  ];

  it("selects only CLOSED/ARCHIVED cases past the window — never active ones, however old", () => {
    const out = retentionCandidates(now, 365, cases);
    expect(out.map((c) => c.id).sort()).toEqual(["archived-old", "closed-old"]);
  });

  it("no policy = nothing purged", () => {
    expect(retentionCandidates(now, null, cases)).toHaveLength(0);
  });

  it("boundary: a case exactly at the cutoff is retained", () => {
    const edge = [{ id: "edge", status: "CLOSED", updatedAt: daysAgo(365) }];
    expect(retentionCandidates(now, 365, edge)).toHaveLength(0);
    expect(retentionCandidates(now, 364, edge)).toHaveLength(1);
  });
});
