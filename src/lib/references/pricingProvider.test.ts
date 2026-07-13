import { describe, it, expect } from "vitest";
import { staticPrice, resolveUnitCost } from "./pricingProvider";

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
    delete process.env.FAIRHEALTH_API_KEY;
    await expect(resolveUnitCost({ category: "IMAGING", cpt: "73721", zip: "92626" })).rejects.toThrow(/missing credentials|FAIRHEALTH_API_KEY/i);
    delete process.env.PRICING_PROVIDER;
  });
});
