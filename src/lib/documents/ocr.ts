// ─────────────────────────────────────────────────────────────────────────────
// OCR for scanned/image PDFs (and mixed digital+scan records). Every page is
// read: pages with a digital text layer keep it verbatim; pages without one are
// rendered via pdfjs and read with Tesseract (WASM — fully local, no API keys).
// Output stamps "Page N of M" ahead of each page's text so the existing
// page-citation machinery (chronology, causation evidence, record meta) can
// cite exact pages. Returns the mean OCR confidence for the reviewer.
// ─────────────────────────────────────────────────────────────────────────────

import path from "path";
import { createCanvas } from "@napi-rs/canvas";
import { preprocess, type OcrPrep } from "@/lib/documents/imagePrep";

export interface OcrProgress {
  page: number;
  totalPages: number;
  /** pages actually OCR'd so far (vs. read from the text layer) */
  ocred: number;
}

export interface OcrResult {
  text: string;
  pageCount: number;
  /** pages that went through Tesseract (no digital text layer) */
  ocredPages: number;
  /** mean Tesseract confidence across OCR'd pages, 0..1 (1 for pure digital) */
  confidence: number;
}

// Render at 300 DPI. An A/B over scanned chart pages showed 300 DPI (no
// preprocessing) consistently equals or beats 200 — higher Tesseract
// confidence, less garbage, more text captured — while hard binarization and
// contrast-stretch BOTH regressed (binarization tanked confidence; the stretch
// destroyed faint text). So we raise DPI but leave preprocessing OFF by default;
// it stays available via OCR_PREP for document types where it is proven to help.
// Env-overridable for speed/quality tuning on very large charts.
const RENDER_DPI = Math.max(150, Math.min(400, parseInt(process.env.OCR_DPI ?? "300", 10) || 300));
const RENDER_SCALE = RENDER_DPI / 72;
// Bound the rendered bitmap so a large page can't exhaust memory.
const MAX_EDGE = 4000;
// Optional pre-OCR pixel preprocessing ("none" | "enhance" | "binarize").
// Default "none" — the A/B showed both alternatives hurt this scan; keep the
// hook so a future document type can opt in once measured.
const OCR_PREP = (process.env.OCR_PREP as OcrPrep | undefined) ?? "none";
// A page whose text layer has fewer characters than this is treated as a scan.
const MIN_PAGE_TEXT = 30;
// A page OCR'd below this confidence is retried with a different segmentation.
const RETRY_BELOW = 0.6;
const OCR_WORKERS = Math.max(2, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 4) - 2));

type RecognizeOpts = { rotateAuto?: boolean };
type TesseractWorker = {
  recognize: (img: Buffer, opts?: unknown, out?: unknown) => Promise<{ data: { text: string; confidence: number } }>;
  setParameters: (p: Record<string, string>) => Promise<unknown>;
  terminate: () => Promise<unknown>;
};

async function makeWorkers(n: number): Promise<TesseractWorker[]> {
  const { createWorker } = await import("tesseract.js");
  const cachePath = path.join(process.cwd(), ".ocr-cache");
  const workers = (await Promise.all(
    Array.from({ length: n }, () => createWorker("eng", 1, { cachePath }) as unknown as Promise<TesseractWorker>),
  )) as TesseractWorker[];
  // LSTM engine (default), page-segmentation "auto", and tell Tesseract the DPI
  // so its internal scaling is right; preserve spacing for the line extractors.
  await Promise.all(workers.map((w) => w.setParameters({ tessedit_pageseg_mode: "3", user_defined_dpi: String(RENDER_DPI), preserve_interword_spaces: "1" })));
  return workers;
}


/**
 * Read a PDF end-to-end: digital text where it exists, Tesseract OCR where it
 * doesn't. `onProgress` fires after each page so callers can surface status.
 */
export async function readPdf(buffer: Buffer, onProgress?: (p: OcrProgress) => void | Promise<void>): Promise<OcrResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true });
  const doc = await loadingTask.promise;
  const total = doc.numPages;

  // Pass 1 — page text layers, and which pages need OCR. Line structure is
  // reconstructed from glyph Y positions ("hasEOL") because the downstream
  // extractors (dates, providers, facilities, clinical sections) are line-based.
  const pageText: string[] = new Array(total).fill("");
  const needsOcr: number[] = [];
  for (let i = 1; i <= total; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items
      .map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : ""))
      .join("")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
    if (text.length >= MIN_PAGE_TEXT) pageText[i - 1] = text;
    else needsOcr.push(i);
    page.cleanup();
  }

  // Pass 2 — OCR the scanned pages with a small worker pool.
  let confSum = 0;
  let done = 0;
  if (needsOcr.length > 0) {
    const workers = await makeWorkers(Math.min(OCR_WORKERS, needsOcr.length));
    try {
      let cursor = 0;
      await Promise.all(
        workers.map(async (w) => {
          for (;;) {
            const idx = cursor++;
            if (idx >= needsOcr.length) return;
            const pageNo = needsOcr[idx];
            const page = await doc.getPage(pageNo);
            const base = page.getViewport({ scale: 1 });
            // Scale to ~300 DPI, but cap the longest edge to bound memory.
            const scale = Math.min(RENDER_SCALE, MAX_EDGE / Math.max(base.width, base.height));
            const viewport = page.getViewport({ scale });
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            const ctx = canvas.getContext("2d");
            // Flatten onto white first (transparent scans otherwise render black).
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await page.render({ canvasContext: ctx as any, viewport, canvas: canvas as any, background: "#ffffff" }).promise;
            page.cleanup();
            // Optional in-place pixel preprocessing (off by default).
            if (OCR_PREP !== "none") {
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              preprocess(img.data, OCR_PREP);
              ctx.putImageData(img, 0, 0);
            }
            const png = canvas.toBuffer("image/png");

            const clean = (s: string) => (s ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
            let r = await w.recognize(png);
            let conf = (r.data.confidence ?? 0) / 100;
            let outText = clean(r.data.text);
            // Low-confidence page → retry as a single uniform text block (PSM 6),
            // which often recovers dense chart pages the auto layout mangles.
            if (conf < RETRY_BELOW) {
              await w.setParameters({ tessedit_pageseg_mode: "6" });
              const r2 = await w.recognize(png);
              await w.setParameters({ tessedit_pageseg_mode: "3" });
              if ((r2.data.confidence ?? 0) / 100 > conf) { r = r2; conf = (r2.data.confidence ?? 0) / 100; outText = clean(r2.data.text); }
            }
            pageText[pageNo - 1] = outText;
            confSum += conf;
            done++;
            await onProgress?.({ page: pageNo, totalPages: total, ocred: done });
          }
        }),
      );
    } finally {
      await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
    }
  }
  await loadingTask.destroy().catch(() => {});

  // Stamp page markers so downstream page citations resolve.
  const text = pageText.map((t, i) => `Page ${i + 1} of ${total}\n${t}`).join("\n").trim();
  const confidence = needsOcr.length ? confSum / needsOcr.length : 1;
  return { text, pageCount: total, ocredPages: needsOcr.length, confidence };
}
