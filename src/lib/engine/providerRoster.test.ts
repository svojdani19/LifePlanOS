import { describe, it, expect } from "vitest";
import { extractProviders, normalizeProviderName, newSuggestions, type DocForRoster, type ChronoForRoster } from "./providerRoster";

// EPIC-011 — the treating-provider roster is lifted from parsed record fields;
// people are extracted, facilities/metadata are not, and appearances merge.

describe("normalizeProviderName", () => {
  it("drops credentials/punctuation and is order-insensitive", () => {
    expect(normalizeProviderName("Nadia Brandt, MD")).toBe(normalizeProviderName("Brandt Nadia"));
    expect(normalizeProviderName("Omar A. Haddad MD")).toContain("haddad");
  });
});

describe("extractProviders", () => {
  const docs: DocForRoster[] = [
    { id: "d1", filename: "op.pdf", authorName: "Nadia Brandt", authorCredentials: "MD", authorRole: "Orthopedic Spine Surgery", facility: "St. Jude" },
    { id: "d2", filename: "er.pdf", authorName: "Omar Haddad, MD", authorRole: "Emergency Medicine", facility: "Fountain Valley" },
    { id: "d3", filename: "path.pdf", authorName: "Fountain Valley Regional Hospital" }, // facility, not a person
    { id: "d4", filename: "pt.pdf", providers: [{ name: "Priya Nair", credentials: "PT, DPT", role: "Physical Therapy", pages: [3] }] },
  ];
  const chrono: ChronoForRoster[] = [
    { provider: "Nadia Brandt, MD", sourceDocumentId: "d5", sourcePage: 12 }, // same person, new source
    { provider: "Patient" }, // metadata, not a person
  ];
  const providers = extractProviders(docs, chrono);

  it("extracts people, not facilities or metadata", () => {
    const names = providers.map((p) => p.name.toLowerCase());
    expect(names.some((n) => n.includes("brandt"))).toBe(true);
    expect(names.some((n) => n.includes("haddad"))).toBe(true);
    expect(names.some((n) => n.includes("nair"))).toBe(true);
    expect(names.some((n) => n.includes("hospital"))).toBe(false);
    expect(names.some((n) => n.includes("patient"))).toBe(false);
  });

  it("merges multiple appearances of one provider into one entry with all sources", () => {
    const brandt = providers.find((p) => p.nameKey.includes("brandt"))!;
    expect(brandt.sourceDocumentIds.length).toBeGreaterThanOrEqual(2); // d1 + chrono d5
    expect(brandt.credentials).toBe("MD");
  });

  it("captures credentials embedded in the name string", () => {
    const haddad = providers.find((p) => p.nameKey.includes("haddad"))!;
    expect(haddad.credentials).toBe("MD");
  });
});

describe("newSuggestions", () => {
  it("returns only providers not already in the curated roster (regeneration-safe)", () => {
    const extracted = extractProviders([{ id: "d1", filename: "a.pdf", authorName: "Jane Doe", authorCredentials: "MD" }], []);
    expect(newSuggestions(extracted, new Set()).length).toBe(1);
    expect(newSuggestions(extracted, new Set([extracted[0].nameKey])).length).toBe(0);
  });
});
