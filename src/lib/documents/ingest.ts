import { prisma } from "@/lib/db";
import { extractText } from "@/lib/documents/extract";
import { classifyDocument } from "@/lib/documents/classify";
import type { Document, DocumentType } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Document ingestion: read the file's actual composition, classify from that
// content, and persist. A file arrives either as raw bytes (real upload) or as
// pre-extracted text (demo sample set). Either way, the TYPE comes from the
// content — the filename is only a fallback for scans with no text layer.
// ─────────────────────────────────────────────────────────────────────────────

export interface IngestInput {
  caseId: string;
  firmId: string;
  uploadedById?: string;
  filename: string;
  mimeType?: string;
  /** Raw file bytes (real uploads). */
  buffer?: Buffer;
  /** Pre-extracted text (demo samples). */
  text?: string;
  storageKey?: string;
  /** Explicit type chosen by the uploader — skips auto-classification. */
  forcedType?: string;
}

export interface IngestResult {
  document: Document;
  method: string;
  pages: number;
}

export async function ingestDocument(input: IngestInput): Promise<IngestResult> {
  // 1. Get the document's text — extracted from the bytes when present.
  let text = input.text ?? "";
  let pageCount: number;
  let hasText: boolean;

  if (input.buffer) {
    const extraction = await extractText(input.buffer, input.mimeType ?? "", input.filename);
    text = extraction.text;
    pageCount = extraction.pageCount || 1;
    hasText = extraction.hasText;
  } else {
    hasText = text.trim().length > 40;
    pageCount = Math.max(1, Math.round((text.length || 1) / 1200));
  }

  // 2. Classify from composition (filename only as a fallback), unless the
  //    uploader explicitly chose a type.
  const c = input.forcedType
    ? { type: input.forcedType, method: "manual" as const, score: 0, confidence: 1, note: "Set by uploader." }
    : classifyDocument({ text, filename: input.filename, hasText });

  // 3. OCR confidence: full when we read real text; low when the body was blank
  //    (scan/image) so the reviewer knows to verify.
  const ocrConfidence = hasText ? 0.96 : 0.5;
  const flags: string[] = [];
  if (!hasText) flags.push("No extractable text (possible scan) — classified from filename; verify and reassign if needed");
  else if (c.method !== "content") flags.push(c.note);
  if (pageCount > 35) flags.push("Large document — confirm no missing pages");

  const document = await prisma.document.create({
    data: {
      caseId: input.caseId,
      firmId: input.firmId,
      uploadedById: input.uploadedById,
      filename: input.filename,
      storageKey: input.storageKey,
      type: c.type as DocumentType,
      status: "PROCESSED",
      pageCount,
      ocrConfidence,
      classifiedBy: c.method,
      classifyScore: c.score,
      provider: c.type === "OPERATIVE_NOTE" ? "Surgical Facility" : "Treating Provider",
      extractedText: text.slice(0, 4000),
      flags: flags.join("; ") || null,
    },
  });

  return { document, method: c.method, pages: pageCount };
}
