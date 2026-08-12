import { describe, expect, it } from "vitest";
import { ATTESTED_FLOOR, dateVerdict, yearAttested, yearProfile } from "@/lib/records/dateSanity";

/** A document that prints `dominant` heavily and each of `others` a few times. */
const document = (dominant: string, dominantTimes: number, ...others: string[]) =>
  [`${dominant} `.repeat(dominantTimes), others.join(" ")].join(" ");

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("what a document attests", () => {
  it("counts the years it prints", () => {
    const profile = yearProfile("visit 03/15/2024, follow-up 04/02/2024, prior surgery 2016");
    expect(profile.counts.get(2024)).toBe(2);
    expect(profile.counts.get(2016)).toBe(1);
    expect(profile.dominant).toBe(2024);
  });

  it("attests a year the document prints often, however far it sits from the rest", () => {
    // A records production genuinely contains old care, and a document that
    // covers 1998 in depth is covering it.
    const profile = yearProfile(document("2024", 500, ...Array(ATTESTED_FLOOR).fill("1998")));
    expect(yearAttested(1998, profile)).toBe(true);
  });

  it("does not attest a year that barely appears beside a dominant one", () => {
    const profile = yearProfile(document("2024", 6_000, ...Array(20).fill("2004")));
    expect(yearAttested(2004, profile)).toBe(false);
    expect(yearAttested(2024, profile)).toBe(true);
  });

  it("contradicts nothing when the document prints no years at all", () => {
    expect(yearAttested(2004, yearProfile("no dates here"))).toBe(true);
  });
});

describe("judging a record's date against its document", () => {
  const misreadYear = yearProfile(document("2024", 6_000, ...Array(20).fill("2004")));

  it("keeps a date the document attests", () => {
    expect(dateVerdict(at("2024-03-15"), "operative note 03/15/2024", misreadYear).verdict).toBe("KEEP");
  });

  it("corrects a misread year when the page prints the same day under an attested one", () => {
    // "2024" scanned as "2004". The page itself carries the real date.
    const v = dateVerdict(at("2004-10-10"), "Follow-up visit 10/10/2024, many months postop L2-S1", misreadYear);
    expect(v).toMatchObject({ verdict: "RETIME", iso: "2024-10-10" });
    if (v.verdict === "RETIME") expect(v.evidence).toContain("10/10/2024");
  });

  it("reads an ISO date as corroboration too", () => {
    const v = dateVerdict(at("2004-10-10"), "collected 2024-10-10 at 06:15", misreadYear);
    expect(v).toMatchObject({ verdict: "RETIME", iso: "2024-10-10" });
  });

  it("refuses the date rather than inventing one when nothing corroborates it", () => {
    // An undated record routes to human review. A misdated one asserts
    // something false with a citation attached, which is worse.
    const v = dateVerdict(at("2004-03-15"), "no dates printed anywhere near this record", misreadYear);
    expect(v.verdict).toBe("UNTRUSTED");
  });

  it("will not correct to a day that two attested years both print", () => {
    const both = yearProfile(document("2024", 3_000, ...Array(ATTESTED_FLOOR).fill("2023"), ...Array(20).fill("2004")));
    const v = dateVerdict(at("2004-05-01"), "seen 05/01/2024 and again 05/01/2023", both);
    expect(v.verdict).toBe("UNTRUSTED");
  });

  it("does not corroborate from a different day", () => {
    const v = dateVerdict(at("2004-10-10"), "operative note 03/15/2024", misreadYear);
    expect(v.verdict).toBe("UNTRUSTED");
  });

  it("leaves genuine prior history alone", () => {
    // A 1998 injury in a document that covers 1998 is not a misread.
    const profile = yearProfile(document("2024", 500, ...Array(ATTESTED_FLOOR).fill("1998")));
    expect(dateVerdict(at("1998-06-04"), "prior back injury 06/04/1998", profile).verdict).toBe("KEEP");
  });
});
