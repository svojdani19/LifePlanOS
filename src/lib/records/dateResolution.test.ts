import { describe, expect, it } from "vitest";
import { yearProfile } from "@/lib/records/dateSanity";
import { resolveDate, type DateSources } from "@/lib/records/dateResolution";

const TODAY = new Date("2026-08-10T00:00:00Z");

/** A document that prints 2024 throughout and 2004 a handful of times. */
const MISREAD = yearProfile(`${"2024 ".repeat(6_000)} ${"2004 ".repeat(20)}`);

const sources = (over: Partial<DateSources> = {}): DateSources => ({
  header: null,
  claims: [],
  nearbyText: "",
  profile: MISREAD,
  today: TODAY,
  ...over,
});

const claim = (value: string) => ({ field: "procedure", value, excerpt: value });
const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("the strongest available source dates a record", () => {
  it("takes a header whose year the document attests, and calls it documented", () => {
    const r = resolveDate(sources({ header: at("2024-03-15") }));
    expect(r).toMatchObject({ iso: "2024-03-15", basis: "DOCUMENTED", inferred: false });
  });

  it("re-years a header from a date the page prints, over anything weaker", () => {
    const r = resolveDate(
      sources({
        header: at("2004-03-15"),
        nearbyText: "DOs:03/15/2024",
        claims: [claim("Office visit on 10/01/2024")],
      }),
    );
    expect(r).toMatchObject({ iso: "2024-03-15", basis: "RETIMED_FROM_PAGE", inferred: true });
  });

  it("falls through a refused header to the date the record states itself", () => {
    // This is the gap that sent records to "undated" while their own text read
    // "billed on 10/01/2024": recovery only ran when the header was missing,
    // and a refused header is not a missing one.
    const r = resolveDate(
      sources({
        header: at("2004-03-15"),
        nearbyText: "nothing corroborating here",
        claims: [claim("HCPCS 99214 billed on 10/01/2024, 1 unit")],
      }),
    );
    expect(r).toMatchObject({ iso: "2024-10-01", basis: "STATED_IN_CLAIMS", inferred: true });
  });

  it("prefers what the record states over where it was filed", () => {
    const r = resolveDate(
      sources({
        claims: [claim("Radiology diagnostic CPT 77003, service date 10/10/24")],
        before: "2024-11-06",
        after: "2024-11-06",
      }),
    );
    expect(r).toMatchObject({ iso: "2024-10-10", basis: "STATED_IN_CLAIMS" });
  });
});

describe("dating a record by the records around it", () => {
  it("places a record between two neighbours carrying the same date", () => {
    const r = resolveDate(sources({ before: "2024-11-06", after: "2024-11-06" }));
    expect(r).toMatchObject({ iso: "2024-11-06", basis: "NEIGHBOURS_AGREE", inferred: true });
    expect(r.evidence).toContain("2024-11-06");
  });

  it("places a record inside a short window, on the day it follows", () => {
    const r = resolveDate(sources({ before: "2024-03-16", after: "2024-03-22" }));
    expect(r).toMatchObject({ iso: "2024-03-16", basis: "BRACKETED_BY_NEIGHBOURS" });
  });

  it("refuses a window too wide to mean anything", () => {
    const r = resolveDate(sources({ before: "2024-03-16", after: "2024-08-01" }));
    expect(r).toMatchObject({ iso: null, basis: "NONE" });
  });

  it("refuses when the neighbours run backwards", () => {
    // The chart that prompted this has a gap sitting between a record dated
    // 03/21 and one dated 03/18. Where the filing is out of order, position is
    // not evidence.
    const r = resolveDate(sources({ before: "2024-03-21", after: "2024-03-18" }));
    expect(r).toMatchObject({ iso: null, basis: "NONE" });
  });

  it("refuses with only one dated neighbour", () => {
    expect(resolveDate(sources({ before: "2024-03-16" })).basis).toBe("NONE");
    expect(resolveDate(sources({ after: "2024-03-16" })).basis).toBe("NONE");
  });
});

describe("when nothing can date a record", () => {
  it("says so rather than inventing a date", () => {
    const r = resolveDate(sources({ header: at("1973-05-24"), nearbyText: "no dates here" }));
    expect(r).toMatchObject({ iso: null, basis: "NONE", inferred: false });
  });

  it("never reports an inferred date as documented", () => {
    for (const s of [
      sources({ header: at("2004-03-15"), nearbyText: "DOs:03/15/2024" }),
      sources({ claims: [claim("billed on 10/01/2024")] }),
      sources({ before: "2024-11-06", after: "2024-11-06" }),
    ]) {
      const r = resolveDate(s);
      expect(r.iso).toBeTruthy();
      expect(r.inferred).toBe(true);
      expect(r.basis).not.toBe("DOCUMENTED");
    }
  });
});
