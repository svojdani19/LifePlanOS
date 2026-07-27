import { describe, it, expect, afterEach, vi } from "vitest";
import { staticPrice, resolveUnitCost, mapFairHealthResponse, geozipOf } from "./pricingProvider";

describe("pricing provider seam", () => {
  it("static pricing returns the reference figure labeled with its real source (not live)", async () => {
    const p = staticPrice({ category: "MEDICATION" });
    expect(p.live).toBe(false);
    expect(p.source).toMatch(/goodrx/i);
    expect(p.unit).toBeGreaterThan(0);
  });

  it("defaults to static when no provider is configured", async () => {
    delete process.env.PRICING_PROVIDER;
    const p = await resolveUnitCost({ category: "ORTHOPEDIC_SURGERY" });
    expect(p.live).toBe(false);
    expect(p.source).toMatch(/fair health/i);
  });

  it("a selected live provider refuses without credentials (no invented figure)", async () => {
    process.env.PRICING_PROVIDER = "fairhealth";
    delete process.env.FAIRHEALTH_API_URL;
    delete process.env.FAIRHEALTH_API_KEY;
    await expect(resolveUnitCost({ category: "IMAGING", cpt: "73721", zip: "92626" })).rejects.toThrow(/missing credentials|FAIRHEALTH_API_KEY/i);
    delete process.env.PRICING_PROVIDER;
  });
});

describe("FAIR Health adapter", () => {
  afterEach(() => {
    delete process.env.PRICING_PROVIDER;
    delete process.env.FAIRHEALTH_API_URL;
    delete process.env.FAIRHEALTH_API_KEY;
    vi.unstubAllGlobals();
  });

  it("geozipOf takes the first three ZIP digits and rejects non-ZIPs", () => {
    expect(geozipOf("92626")).toBe("926");
    expect(geozipOf(" 10011-4402")).toBe("100");
    expect(geozipOf("New York")).toBeNull();
    expect(geozipOf(null)).toBeNull();
  });

  it("maps a flat { amount } and a benchmarks array, preferring the requested percentile", () => {
    expect(mapFairHealthResponse({ amount: 1420 }, 80)).toEqual({ amount: 1420, percentile: 80 });
    const mapped = mapFairHealthResponse({ benchmarks: [{ percentile: 50, amount: 900 }, { percentile: 80, amount: 1400 }] }, 80);
    expect(mapped).toEqual({ amount: 1400, percentile: 80 });
    // Falls back to the closest available percentile and DISCLOSES it.
    const closest = mapFairHealthResponse({ benchmarks: [{ percentile: 75, amount: 1300 }] }, 80);
    expect(closest.percentile).toBe(75);
  });

  it("refuses an unreadable response rather than guessing", () => {
    expect(() => mapFairHealthResponse({ ok: true }, 80)).toThrow(/usable benchmark/i);
    expect(() => mapFairHealthResponse({ amount: -5 }, 80)).toThrow(/usable benchmark/i);
  });

  it("a live lookup returns a venue-specific, dated, source-snapshotted figure", async () => {
    process.env.PRICING_PROVIDER = "fairhealth";
    process.env.FAIRHEALTH_API_URL = "https://feed.example.com/benchmarks";
    process.env.FAIRHEALTH_API_KEY = "test-key";
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("code=73721");
      expect(url).toContain("geozip=926");
      return { ok: true, json: async () => ({ benchmarks: [{ percentile: 80, amount: 1612 }] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const p = await resolveUnitCost({ category: "IMAGING", cpt: "73721", zip: "92626", percentile: 80 });
    expect(p.live).toBe(true);
    expect(p.unit).toBe(1612);
    expect(p.geozip).toBe("926");
    expect(p.percentile).toBe(80);
    expect(p.retrievedAt).toBeTruthy();
    expect(p.source).toMatch(/FAIR Health/);
    expect(p.source).toMatch(/80th percentile/);
    expect(p.detail).toMatchObject({ provider: "fairhealth", code: "73721", amount: 1612 });
  });

  it("an uncoded bundled category stays on the labeled static reference even in live mode", async () => {
    process.env.PRICING_PROVIDER = "fairhealth";
    process.env.FAIRHEALTH_API_URL = "https://feed.example.com/benchmarks";
    process.env.FAIRHEALTH_API_KEY = "test-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const p = await resolveUnitCost({ category: "HOME_MODIFICATION", zip: "92626" });
    expect(p.live).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a failed lookup is a loud error, never a silent static fallback", async () => {
    process.env.PRICING_PROVIDER = "fairhealth";
    process.env.FAIRHEALTH_API_URL = "https://feed.example.com/benchmarks";
    process.env.FAIRHEALTH_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    await expect(resolveUnitCost({ category: "IMAGING", cpt: "73721", zip: "92626" })).rejects.toThrow(/HTTP 503/);
  });
});
