import { describe, it, expect } from "vitest";
import { stateFromJurisdiction, geographicFactorFor } from "./geoFactors";

describe("stateFromJurisdiction", () => {
  it("recognizes full state names inside free-text venues", () => {
    expect(stateFromJurisdiction("Los Angeles County Superior Court, California")).toBe("CA");
    expect(stateFromJurisdiction("Supreme Court of the State of New York")).toBe("NY");
  });

  it("longest name wins so West Virginia is not read as Virginia", () => {
    expect(stateFromJurisdiction("Circuit Court of Kanawha County, West Virginia")).toBe("WV");
  });

  it("recognizes standalone two-letter abbreviations", () => {
    expect(stateFromJurisdiction("Austin, TX")).toBe("TX");
    expect(stateFromJurisdiction("Travis County District Court")).toBeNull();
  });

  it("returns null for empty or unrecognizable venues", () => {
    expect(stateFromJurisdiction("")).toBeNull();
    expect(stateFromJurisdiction(null)).toBeNull();
  });
});

describe("geographicFactorFor", () => {
  it("suggests a state-level factor with a labeled source", () => {
    const g = geographicFactorFor("San Francisco, California");
    expect(g.factor).toBeGreaterThan(1);
    expect(g.label).toContain("CA");
  });

  it("is the neutral national baseline — labeled honestly — when the venue is unknown", () => {
    const g = geographicFactorFor("somewhere");
    expect(g.factor).toBe(1.0);
    expect(g.label).toMatch(/not recognized/i);
  });
});
