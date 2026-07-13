// ─────────────────────────────────────────────────────────────────────────────
// Image preprocessing for OCR of scanned pages. Operates in place on RGBA pixel
// data (canvas ImageData) so it composes with the existing pdfjs → canvas →
// Tesseract pipeline. Pure and unit-tested — no canvas/DOM dependency here.
//
// A NOTE ON THRESHOLDING: a prior attempt at naive global binarization regressed
// OCR (faint or reverse-video chart text was destroyed). So the default here is
// gentle — grayscale + a contrast stretch that sharpens strokes without hard
// thresholding — and hard Otsu binarization is available but must be proven per
// document type before it is enabled (see imagePrep.test.ts and the A/B harness).
// ─────────────────────────────────────────────────────────────────────────────

/** Otsu's method: the grayscale level [0,255] that best separates fore/background. */
export function otsuThreshold(histogram: number[]): number {
  const total = histogram.reduce((a, b) => a + b, 0);
  if (total === 0) return 127;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * histogram[i];
  let sumB = 0;
  let weightB = 0;
  let maxBetween = -1;
  // Track the range of levels that all achieve the max separation and return its
  // midpoint — for a bimodal histogram the whole valley is optimal, and the
  // middle of it is a far more robust threshold than the first level.
  let firstBest = 127;
  let lastBest = 127;
  for (let t = 0; t < 256; t++) {
    weightB += histogram[t];
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += t * histogram[t];
    const meanB = sumB / weightB;
    const meanF = (sumAll - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (between > maxBetween) {
      maxBetween = between;
      firstBest = lastBest = t;
    } else if (between === maxBetween) {
      lastBest = t;
    }
  }
  return Math.round((firstBest + lastBest) / 2);
}

/** Per-channel luminance → grayscale, returning the gray plane + its histogram. */
export function toGrayscale(data: Uint8ClampedArray): { gray: Uint8Array; histogram: number[] } {
  const gray = new Uint8Array(data.length >> 2);
  const histogram = new Array(256).fill(0);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    gray[j] = g;
    histogram[g]++;
  }
  return { gray, histogram };
}

/**
 * Gentle default: grayscale + a linear contrast stretch between the 2nd and 98th
 * percentiles, which darkens text and brightens paper without discarding faint
 * strokes. Mutates `data` in place; alpha untouched.
 */
export function enhanceForOcr(data: Uint8ClampedArray): void {
  const { gray, histogram } = toGrayscale(data);
  const total = gray.length;
  // 2nd / 98th percentile bounds for the stretch.
  const lowCut = total * 0.02;
  const highCut = total * 0.98;
  let cum = 0;
  let lo = 0;
  let hi = 255;
  for (let i = 0; i < 256; i++) {
    cum += histogram[i];
    if (cum <= lowCut) lo = i;
    if (cum <= highCut) hi = i;
  }
  const span = Math.max(1, hi - lo);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const v = Math.max(0, Math.min(255, Math.round(((gray[j] - lo) / span) * 255)));
    data[i] = data[i + 1] = data[i + 2] = v;
  }
}

/**
 * Hard Otsu binarization (pure black/white). Sharper for clean scans but can
 * destroy faint text — opt-in, not the default. Mutates `data` in place.
 */
export function binarizeForOcr(data: Uint8ClampedArray): void {
  const { gray, histogram } = toGrayscale(data);
  const t = otsuThreshold(histogram);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const v = gray[j] > t ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = v;
  }
}

export type OcrPrep = "none" | "enhance" | "binarize";

/** Apply the selected preprocessing mode in place. */
export function preprocess(data: Uint8ClampedArray, mode: OcrPrep): void {
  if (mode === "enhance") enhanceForOcr(data);
  else if (mode === "binarize") binarizeForOcr(data);
}
