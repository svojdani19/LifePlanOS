import { describe, expect, it } from "vitest";
import { dateFromClaims, type DatedClaim } from "@/lib/records/dateRecovery";

const claim = (field: string, value: string, excerpt = value): DatedClaim => ({ field, value, excerpt });
const TODAY = new Date("2026-08-10T00:00:00Z");

describe("a date the record states about its own service", () => {
  it("reads a service date off a billing line", () => {
    // 134 clinically-substantive records came out undated while carrying
    // exactly this: the date stated, in the record's own words, in a claim
    // whose excerpt was already verified against the page.
    expect(dateFromClaims([claim("procedure", "HCPCS 3641 performed on 03/13/24")], TODAY)?.iso).toBe("2024-03-13");
    expect(dateFromClaims([claim("procedure", "CPT 99213 performed on 04/02/24")], TODAY)?.iso).toBe("2024-04-02");
  });

  it("reads a labelled date of service", () => {
    expect(dateFromClaims([claim("charge", "Date of service: 02/20/2024, office visit")], TODAY)?.iso).toBe("2024-02-20");
  });

  it("reads an ISO date", () => {
    expect(dateFromClaims([claim("procedure", "Procedure performed on 2024-03-15")], TODAY)?.iso).toBe("2024-03-15");
  });

  it("keeps the text it read the date from, for review", () => {
    const got = dateFromClaims([claim("procedure", "HCPCS 3641 performed on 03/13/24")], TODAY);
    expect(got?.sourceText).toContain("HCPCS 3641");
  });

  it("dates a multi-service record by its earliest service", () => {
    // A statement covering a course of care begins when the care began; the
    // later dates belong to the entries that document them.
    const got = dateFromClaims(
      [claim("procedure", "CPT 99213 performed on 04/02/24"), claim("procedure", "HCPCS 3641 performed on 03/13/24")],
      TODAY,
    );
    expect(got?.iso).toBe("2024-03-13");
  });
});

describe("dates that are not the record's date", () => {
  it("ignores a medication currency date", () => {
    // "Metformin 500 mg tablet (as of 03/23/2024)" says when a list was
    // current, not when the record happened.
    expect(dateFromClaims([claim("medications", "Metformin 500 mg tablet (as of 03/23/2024)")], TODAY)).toBeNull();
  });

  it("ignores print, signature and statement dates", () => {
    // The same artifact contexts the extractor's own validator rejects.
    expect(dateFromClaims([claim("charge", "Statement date: 05/01/2024")], TODAY)).toBeNull();
    expect(dateFromClaims([claim("procedure", "Printed on 05/01/2024")], TODAY)).toBeNull();
    expect(dateFromClaims([claim("procedure", "Electronically signed on 05/01/2024")], TODAY)).toBeNull();
    expect(dateFromClaims([claim("charge", "Received 05/01/2024")], TODAY)).toBeNull();
  });

  it("ignores a date of birth", () => {
    expect(dateFromClaims([claim("subjective", "DOB 10/19/1976")], TODAY)).toBeNull();
  });

  it("ignores a date with no service context at all", () => {
    // A date merely appearing in prose is not the record's date.
    expect(dateFromClaims([claim("subjective", "He recalled the fall happening sometime around 05/29/2023")], TODAY)).toBeNull();
  });

  it("returns null when nothing states a date", () => {
    expect(dateFromClaims([claim("subjective", "Patient reports low back pain")], TODAY)).toBeNull();
    expect(dateFromClaims([], TODAY)).toBeNull();
  });
});

describe("dates that cannot be real", () => {
  it("rejects a future date", () => {
    expect(dateFromClaims([claim("procedure", "Procedure performed on 03/13/2099")], TODAY)).toBeNull();
  });

  it("rejects an impossible calendar date", () => {
    expect(dateFromClaims([claim("procedure", "Procedure performed on 02/31/2024")], TODAY)).toBeNull();
    expect(dateFromClaims([claim("procedure", "Procedure performed on 13/01/2024")], TODAY)).toBeNull();
  });

  it("reads a two-digit year as this century, not the future", () => {
    expect(dateFromClaims([claim("procedure", "Procedure performed on 03/13/24")], TODAY)?.iso).toBe("2024-03-13");
    // 99 would be 2099 — in the future — so it is 1999.
    expect(dateFromClaims([claim("procedure", "Procedure performed on 03/13/99")], TODAY)?.iso).toBe("1999-03-13");
  });
});
