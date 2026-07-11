import { describe, it, expect } from "vitest";
import { parseRecordMeta, pageRange } from "./meta";

describe("pageRange", () => {
  it("collapses consecutive pages into ranges", () => {
    expect(pageRange([1, 2, 3, 5])).toBe("1–3, 5");
    expect(pageRange([3, 1, 2])).toBe("1–3");
    expect(pageRange([1, 3])).toBe("1, 3");
    expect(pageRange([2])).toBe("2");
    expect(pageRange([])).toBe("");
  });
});

describe("parseRecordMeta — single source", () => {
  const m = parseRecordMeta(
    `OPERATIVE REPORT
FACILITY: St. Jude Medical Center, Fullerton, CA.
DATE OF PROCEDURE: 06/12/2024
SURGEON: Jason Ortho, MD — Orthopedic Trauma Surgery.`,
    "OPERATIVE_NOTE",
  );
  it("extracts a single date, provider, and location", () => {
    expect(m.serviceDate).toBeInstanceOf(Date);
    expect(m.serviceDateEnd).toBeNull();
    expect(m.authorName).toBe("Jason Ortho");
    expect(m.authorCredentials).toBe("MD");
    expect(m.authorRole).toContain("Orthopedic");
    expect(m.facility).toContain("St. Jude");
    expect(m.providers.length).toBe(1);
    expect(m.locations.length).toBe(1);
  });
});

describe("parseRecordMeta — consolidated multi-page record", () => {
  const m = parseRecordMeta(
    `CONSOLIDATED HOSPITAL RECORDS
Page 1 of 4
DATE OF SERVICE: 06/08/2024
FACILITY: Fountain Valley Regional Hospital, CA.
Attending Physician: Omar Haddad, MD — Emergency Medicine.
Page 2 of 4
DATE OF SERVICE: 06/12/2024
FACILITY: St. Jude Medical Center, CA.
Surgeon: Nadia Brandt, MD — Orthopedic Spine Surgery.`,
  );
  it("returns a date range spanning earliest to latest", () => {
    expect(m.serviceDate).toBeInstanceOf(Date);
    expect(m.serviceDateEnd).toBeInstanceOf(Date);
    expect(m.serviceDate!.getTime()).toBeLessThan(m.serviceDateEnd!.getTime());
  });
  it("lists every provider and location with page references", () => {
    expect(m.providers.length).toBe(2);
    expect(m.locations.length).toBe(2);
    expect(m.providers[0].name).toBe("Omar Haddad");
    expect(m.providers[0].pages).toEqual([1]);
    expect(m.providers[1].name).toBe("Nadia Brandt");
    expect(m.providers[1].pages).toEqual([2]);
    expect(m.locations[0].pages).toEqual([1]);
    expect(m.locations[1].pages).toEqual([2]);
  });
});
