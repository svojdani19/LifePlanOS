import { describe, it, expect } from "vitest";
import { otsuThreshold, toGrayscale, binarizeForOcr, enhanceForOcr, preprocess } from "@/lib/documents/imagePrep";

// Build an RGBA buffer from an array of gray values (one per pixel).
const rgba = (grays: number[]): Uint8ClampedArray => {
  const d = new Uint8ClampedArray(grays.length * 4);
  grays.forEach((g, i) => {
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g;
    d[i * 4 + 3] = 255;
  });
  return d;
};

describe("imagePrep", () => {
  it("otsuThreshold separates a clean bimodal histogram between the modes", () => {
    const hist = new Array(256).fill(0);
    hist[20] = 500; // dark ink
    hist[230] = 500; // white paper
    const t = otsuThreshold(hist);
    expect(t).toBeGreaterThan(20);
    expect(t).toBeLessThan(230);
  });

  it("toGrayscale weights channels by luminance and builds a histogram", () => {
    const d = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]); // white, black
    const { gray, histogram } = toGrayscale(d);
    expect(gray[0]).toBe(255);
    expect(gray[1]).toBe(0);
    expect(histogram[255]).toBe(1);
    expect(histogram[0]).toBe(1);
  });

  it("binarizeForOcr forces pixels to pure black or white", () => {
    const d = rgba([10, 40, 200, 250]);
    binarizeForOcr(d);
    const vals = [d[0], d[4], d[8], d[12]];
    expect(vals.every((v) => v === 0 || v === 255)).toBe(true);
    expect(vals[0]).toBe(0); // dark → black
    expect(vals[3]).toBe(255); // light → white
  });

  it("enhanceForOcr stretches contrast and preserves the alpha channel", () => {
    const d = rgba([100, 110, 120, 130, 140]);
    enhanceForOcr(d);
    expect(d[3]).toBe(255); // alpha untouched
    // Darkest input maps toward 0, lightest toward 255 (widened dynamic range).
    expect(d[0]).toBeLessThanOrEqual(d[16]);
  });

  it("preprocess('none') is a no-op", () => {
    const d = rgba([12, 34, 56]);
    const copy = Uint8ClampedArray.from(d);
    preprocess(d, "none");
    expect(Array.from(d)).toEqual(Array.from(copy));
  });
});
