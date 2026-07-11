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

// Render scale ≈ 150 DPI — the OCR sweet spot between accuracy and speed.
const RENDER_SCALE = 150 / 72;
// A page whose text layer has fewer characters than this is treated as a scan.
const MIN_PAGE_TEXT = 30;
const OCR_WORKERS = Math.max(2, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 4) - 2));

type TesseractWorker = { recognize: (img: Buffer) => Promise<{ data: { text: string; confidence: number } }>; terminate: () => Promise<unknown> };

async function makeWorkers(n: number): Promise<TesseractWorker[]> {
  const { createWorker } = await import("tesseract.js");
  const cachePath = path.join(process.cwd(), ".ocr-cache");
  return Promise.all(
    Array.from({ length: n }, () => createWorker("eng", 1, { cachePath }) as unknown as Promise<TesseractWorker>),
  );
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
            const viewport = page.getViewport({ scale: RENDER_SCALE });
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            const ctx = canvas.getContext("2d");
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await page.render({ canvasContext: ctx as any, viewport, canvas: canvas as any }).promise;
            const png = canvas.toBuffer("image/png");
            page.cleanup();
            const r = await w.recognize(png);
            // Keep Tesseract's line breaks — the extractors are line-based.
            pageText[pageNo - 1] = (r.data.text ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
            confSum += (r.data.confidence ?? 0) / 100;
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
