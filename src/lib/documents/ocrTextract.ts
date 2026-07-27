// ─────────────────────────────────────────────────────────────────────────────
// AWS Textract adapter for the OCR provider seam. Medical-grade cloud OCR for
// scanned charts — page-by-page DetectDocumentText over locally rendered
// bitmaps, mapped to the same page-marked text + mean-confidence contract as
// the local Tesseract pipeline, so everything downstream (segmentation,
// chronology, page citations) works unchanged.
//
// This module is ONLY reached through documents/ocrProvider.ts, which enforces
// the gates: OCR_PROVIDER=textract, OCR_BAA_ACK=true (a signed BAA — AWS
// Textract is HIPAA-eligible under a BAA), and AWS credentials. Pages with a
// digital text layer are kept verbatim and never leave the machine; only
// rendered scans are transmitted.
// ─────────────────────────────────────────────────────────────────────────────

import { createCanvas } from "@napi-rs/canvas";
import type { OcrResult, OcrProgress } from "@/lib/documents/ocr";

const RENDER_DPI = Math.max(150, Math.min(400, parseInt(process.env.OCR_DPI ?? "300", 10) || 300));
const RENDER_SCALE = RENDER_DPI / 72;
const MAX_EDGE = 4000;
const MIN_PAGE_TEXT = 30;

export async function textractReadPdf(buffer: Buffer, onProgress?: (p: OcrProgress) => void | Promise<void>): Promise<OcrResult> {
  const { TextractClient, DetectDocumentTextCommand } = await import("@aws-sdk/client-textract");
  const client = new TextractClient({ region: process.env.AWS_REGION });

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true });
  const doc = await loadingTask.promise;
  const total = doc.numPages;

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

  let confSum = 0;
  let done = 0;
  try {
    for (const pageNo of needsOcr) {
      const page = await doc.getPage(pageNo);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(RENDER_SCALE, MAX_EDGE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.render({ canvasContext: ctx as any, viewport, canvas: canvas as any, background: "#ffffff" }).promise;
      page.cleanup();
      const png = canvas.toBuffer("image/png");

      const out = await client.send(new DetectDocumentTextCommand({ Document: { Bytes: png } }));
      const lines = (out.Blocks ?? []).filter((b) => b.BlockType === "LINE" && b.Text);
      pageText[pageNo - 1] = lines.map((l) => l.Text!.trim()).join("\n").trim();
      const confs = lines.map((l) => l.Confidence ?? 0);
      confSum += confs.length ? confs.reduce((s, x) => s + x, 0) / confs.length / 100 : 0;
      done++;
      await onProgress?.({ page: pageNo, totalPages: total, ocred: done });
    }
  } finally {
    await loadingTask.destroy().catch(() => {});
  }

  const text = pageText.map((t, i) => `Page ${i + 1} of ${total}\n${t}`).join("\n").trim();
  const confidence = needsOcr.length ? confSum / needsOcr.length : 1;
  return { text, pageCount: total, ocredPages: needsOcr.length, confidence };
}
