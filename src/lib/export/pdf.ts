// ─────────────────────────────────────────────────────────────────────────────
// PDF export (ATD-7): DOCX remains the canonical report format; PDF is
// produced by converting the canonical DOCX through a local LibreOffice
// (`soffice --headless`) when a customer requires PDF delivery. Same seam
// philosophy as OCR and pricing: when the converter is not installed the
// export fails with a clear setup error — it never silently substitutes a
// different renderer (a re-typeset report is a different document, and a
// medicolegal report must not vary by export path).
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const execFileP = promisify(execFile);

/** The converter binary — LibreOffice by default; override via PDF_CONVERTER. */
export function pdfConverterCommand(): string {
  return process.env.PDF_CONVERTER?.trim() || "soffice";
}

function setupError(detail: string): Error {
  return new Error(
    `PDF conversion is not available: ${detail}. DOCX is the canonical format (ATD-7); ` +
      `PDF is produced by converting it through LibreOffice — install it (or set PDF_CONVERTER ` +
      `to the binary path) on the app host. See docs/12_DEPLOYMENT.md.`,
  );
}

/**
 * Convert a canonical report DOCX to PDF via headless LibreOffice. The DOCX
 * buffer is written to an isolated temp directory, converted, read back, and
 * the directory removed — nothing persists outside object storage.
 */
export async function convertDocxToPdf(docx: Buffer): Promise<Buffer> {
  const bin = pdfConverterCommand();
  const dir = await mkdtemp(path.join(tmpdir(), "lcp-pdf-"));
  try {
    const inPath = path.join(dir, "report.docx");
    await writeFile(inPath, docx);
    try {
      await execFileP(bin, ["--headless", "--convert-to", "pdf", "--outdir", dir, inPath], { timeout: 120_000 });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") throw setupError(`the converter binary "${bin}" is not installed`);
      throw setupError(`"${bin}" failed: ${e.message ?? "unknown error"}`);
    }
    try {
      return await readFile(path.join(dir, "report.pdf"));
    } catch {
      throw setupError(`"${bin}" completed but produced no PDF output`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
