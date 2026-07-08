// ─────────────────────────────────────────────────────────────────────────────
// Real text extraction from an uploaded file buffer. The extracted text is what
// the content classifier reads — the filename is never trusted on its own.
//   • PDF  → pdf-parse (digital text layer)
//   • DOCX → mammoth
//   • TXT / CSV / plain → decoded directly
// A PDF that yields almost no text is almost certainly a scan/image; the caller
// treats that as "no reliable content" and falls back to the filename hint.
// (Configure a real OCR provider to recover text from scans.)
// ─────────────────────────────────────────────────────────────────────────────

export interface Extraction {
  text: string;
  pageCount: number;
  /** true when the file had a usable digital text layer. */
  hasText: boolean;
}

function extFromName(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function looksLike(mimeType: string, filename: string, kind: "pdf" | "docx" | "text"): boolean {
  const ext = extFromName(filename);
  if (kind === "pdf") return mimeType === "application/pdf" || ext === "pdf";
  if (kind === "docx")
    return (
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      mimeType === "application/msword" ||
      ext === "docx" ||
      ext === "doc"
    );
  return mimeType.startsWith("text/") || ["txt", "csv", "tsv", "md"].includes(ext);
}

export async function extractText(buffer: Buffer, mimeType: string, filename: string): Promise<Extraction> {
  try {
    if (looksLike(mimeType, filename, "pdf")) {
      // Import the lib entry directly to avoid pdf-parse's debug-mode file read.
      const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default as (b: Buffer) => Promise<{ text: string; numpages: number }>;
      const r = await pdfParse(buffer);
      const text = (r.text ?? "").trim();
      return { text, pageCount: r.numpages || 1, hasText: text.length > 40 };
    }

    if (looksLike(mimeType, filename, "docx")) {
      const mammoth = await import("mammoth");
      const r = await mammoth.extractRawText({ buffer });
      const text = (r.value ?? "").trim();
      return { text, pageCount: Math.max(1, Math.round(text.length / 1800)), hasText: text.length > 40 };
    }

    if (looksLike(mimeType, filename, "text")) {
      const text = buffer.toString("utf-8").trim();
      return { text, pageCount: Math.max(1, Math.round(text.length / 1800)), hasText: text.length > 20 };
    }
  } catch {
    // fall through to the empty extraction below
  }
  return { text: "", pageCount: 0, hasText: false };
}
