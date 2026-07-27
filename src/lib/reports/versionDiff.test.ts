import { describe, it, expect } from "vitest";
import { changesSection, isMaterialDiff } from "./versionDiff";
import type { SnapshotDiff } from "@/lib/engine/snapshot";

const empty: SnapshotDiff = {
  recordsAdded: [], recordsRemoved: [], chronologyAdded: 0, chronologyRemoved: 0,
  diagnosesAdded: [], diagnosesRemoved: [], relatednessChanged: [], itemsAdded: [],
  itemsRemoved: [], fieldChanges: [], reviewChanges: [], literatureChanges: [],
  assumptionChanges: [], totalChange: { lifetimeFrom: 100, lifetimeTo: 100, pvFrom: 50, pvTo: 50 },
};

describe("report version changes", () => {
  it("an unchanged case is not material and says so honestly", () => {
    expect(isMaterialDiff(empty)).toBe(false);
    const text = JSON.stringify(changesSection(empty, "v1 (final), exported 2026-01-05"));
    expect(text).toContain("No material changes from the prior version");
    expect(text).toContain("v1 (final)");
  });

  it("new records and added recommendations render with names and counts", () => {
    const d: SnapshotDiff = { ...empty, recordsAdded: ["MRI-2026.pdf"], itemsAdded: ["Revision arthroplasty"] };
    expect(isMaterialDiff(d)).toBe(true);
    const text = JSON.stringify(changesSection(d, "v2"));
    expect(text).toContain("MRI-2026.pdf");
    expect(text).toContain("Revision arthroplasty");
    expect(text).not.toContain("No material changes");
  });

  it("parameter and review changes render as before→after tables", () => {
    const d: SnapshotDiff = {
      ...empty,
      fieldChanges: [{ service: "Physical therapy", field: "frequencyPerYear", from: 24, to: 12 } as never],
      reviewChanges: [{ service: "Physical therapy", from: "PENDING", to: "MODIFIED" }],
    };
    const blocks = changesSection(d, "v3");
    const tables = blocks.filter((b) => b.kind === "table");
    expect(tables).toHaveLength(2);
    expect(JSON.stringify(tables[0])).toContain("24");
    expect(JSON.stringify(tables[0])).toContain("12");
    expect(JSON.stringify(tables[1])).toContain("MODIFIED");
  });

  it("totals movement shows direction and magnitude; sub-dollar noise is not material", () => {
    const moved: SnapshotDiff = { ...empty, totalChange: { lifetimeFrom: 100, lifetimeTo: 100, pvFrom: 50_000, pvTo: 62_500 } };
    expect(isMaterialDiff(moved)).toBe(true);
    const text = JSON.stringify(changesSection(moved, "v1"));
    expect(text).toContain("$50,000");
    expect(text).toContain("$62,500");
    expect(text).toContain("+$12,500");
    const noise: SnapshotDiff = { ...empty, totalChange: { lifetimeFrom: 100, lifetimeTo: 100.4, pvFrom: 50, pvTo: 49.6 } };
    expect(isMaterialDiff(noise)).toBe(false);
  });

  it("never invents changes — section content maps 1:1 to the diff", () => {
    const d: SnapshotDiff = { ...empty, diagnosesAdded: ["Lumbar radiculopathy"] };
    const text = JSON.stringify(changesSection(d, "v1"));
    expect(text).toContain("Lumbar radiculopathy");
    expect(text).not.toContain("Recommendations added");
    expect(text).not.toContain("New records reviewed");
  });
});
