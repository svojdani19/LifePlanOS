// ─────────────────────────────────────────────────────────────────────────────
// Background OCR queue. Scanned uploads are ingested immediately (so the upload
// response is fast) with a "OCR in progress" flag, then read here one document
// at a time: every page OCR'd, the text persisted in full, the document
// re-classified from its now-readable content, and the record descriptors
// (dates, providers, locations, pages) re-parsed. Progress is written to the
// document's flags so the Records tab can show it live.
// Singleton on globalThis so dev HMR doesn't spawn parallel queues.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";
import { getObject } from "@/lib/storage";
import { getOcrProvider } from "@/lib/documents/ocrProvider";
import { classifyDocument } from "@/lib/documents/classify";
import { parseRecordMeta } from "@/lib/documents/meta";
import { segmentDocument } from "@/lib/documents/segment";
import { Prisma } from "@/generated/prisma";
import type { DocumentType } from "@/generated/prisma";

export const MAX_TEXT = 4_000_000; // chars persisted per document (~2,000 pages of dense chart text)

interface Job {
  documentId: string;
  /** uploader explicitly chose the type — don't overwrite it after OCR */
  forcedType?: boolean;
}

const g = globalThis as unknown as { __ocrQueue?: { jobs: Job[]; running: boolean } };
const state = (g.__ocrQueue ??= { jobs: [], running: false });

export function enqueueOcr(job: Job): void {
  if (state.jobs.some((j) => j.documentId === job.documentId)) return;
  state.jobs.push(job);
  if (!state.running) void drain();
}

/** Run one document's OCR to completion (for scripts / reprocessing). */
export async function processDocumentNow(documentId: string, forcedType = false): Promise<void> {
  await runJob({ documentId, forcedType });
}

async function drain(): Promise<void> {
  state.running = true;
  try {
    for (;;) {
      const job = state.jobs.shift();
      if (!job) return;
      await runJob(job).catch(async (e) => {
        console.error(`[ocr] ${job.documentId} failed:`, e);
        await prisma.document
          .update({ where: { id: job.documentId }, data: { flags: `OCR failed — ${String((e as Error).message).slice(0, 140)}. Re-upload or retry.`, status: "PROCESSED" } })
          .catch(() => {});
      });
    }
  } finally {
    state.running = false;
  }
}

async function runJob(job: Job): Promise<void> {
  const doc = await prisma.document.findUnique({ where: { id: job.documentId } });
  if (!doc?.storageKey) return;
  const buffer = await getObject(doc.storageKey);
  if (!buffer?.length) throw new Error("stored file not found");

  const provider = getOcrProvider();
  console.log(`[ocr] start ${doc.filename} (${doc.pageCount ?? "?"} pages) via ${provider.name}`);
  const started = Date.now();
  let lastFlagged = 0;
  const r = await provider.readPdf(buffer, async ({ ocred, totalPages }) => {
    // Throttled progress into flags so the UI can show it without a new table.
    if (Date.now() - lastFlagged < 5000) return;
    lastFlagged = Date.now();
    await prisma.document
      .update({ where: { id: doc.id }, data: { flags: `Scanned document — OCR in progress (${ocred} of ~${totalPages} pages read)` } })
      .catch(() => {});
  });

  const text = r.text.slice(0, MAX_TEXT);
  // Re-classify from the now-readable content and re-parse record descriptors.
  const c = job.forcedType
    ? null
    : classifyDocument({ text, filename: doc.filename, hasText: text.length > 40 });
  const type = (c && c.method === "content" ? c.type : doc.type) as DocumentType;
  const meta = parseRecordMeta(text, type);
  const segments = segmentDocument(text);

  const flags: string[] = [];
  if (r.confidence < 0.8) flags.push(`OCR confidence ${(r.confidence * 100).toFixed(0)}% — verify against the source scan`);
  if (r.pageCount > 35) flags.push("Large document — confirm no missing pages");
  if (r.text.length > MAX_TEXT) flags.push("Very large document — text indexed up to the storage cap");

  await prisma.document.update({
    where: { id: doc.id },
    data: {
      extractedText: text,
      pageCount: r.pageCount,
      ocrConfidence: r.confidence,
      status: "PROCESSED",
      type,
      classifiedBy: c && c.method === "content" ? "content" : doc.classifiedBy,
      classifyScore: c?.score ?? doc.classifyScore,
      serviceDate: meta.serviceDate ?? doc.serviceDate,
      serviceDateEnd: meta.serviceDateEnd,
      datePages: meta.serviceDateEnd ? (meta.datePages as unknown as Prisma.InputJsonValue) : undefined,
      authorName: meta.authorName,
      authorCredentials: meta.authorCredentials,
      authorRole: meta.authorRole,
      facility: meta.facility,
      providers: meta.providers.length > 1 ? (meta.providers as unknown as Prisma.InputJsonValue) : undefined,
      locations: meta.locations.length > 1 ? (meta.locations as unknown as Prisma.InputJsonValue) : undefined,
      // Re-OCR replaces the text, so recompute segments; clear stale ones when
      // the fuller text no longer reads as consolidated.
      segments: segments ? (segments as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      provider: meta.facility ?? meta.authorName ?? doc.provider,
      flags: flags.join("; ") || null,
    },
  });
  console.log(`[ocr] done ${doc.filename}: ${r.pageCount} pages (${r.ocredPages} OCR'd) in ${((Date.now() - started) / 1000).toFixed(0)}s, confidence ${(r.confidence * 100).toFixed(0)}%`);
}
