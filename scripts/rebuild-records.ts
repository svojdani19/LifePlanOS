// ─────────────────────────────────────────────────────────────────────────────
// Rebuild a case's records list and medical chronology from its extracted rows.
//
// Extraction produces claims; this turns them into what a reviewer reads. It
// runs entirely off rows already in the database, so it re-runs cheaply after a
// change to merging, dating or entry-writing without re-reading a single PDF.
//
//   npm run records:rebuild -- <caseId|caseNumber>
//   npm run records:rebuild -- REF-2026-0005 --dry-run
//
// Human work is never destroyed: only chronology events still marked AI_DRAFT
// are replaced, and anything a reviewer has touched is counted and left alone.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma, PrismaClient } from "@/generated/prisma";
import { MEDICAL_TIMELINE_CLASSES } from "@/lib/documents/analysisClass";
import { classifySegment } from "@/lib/engine/chronology";
import { dateFromClaims } from "@/lib/records/dateRecovery";
import {
  chronologyMateriality,
  consolidateIntoNotes,
  dedupeAcrossDocuments,
  entrySubstance,
  mergeRows,
  pageAttributionUsable,
  type MergeableRow,
  type MergedEntry,
} from "@/lib/records/entryMerge";
import { renderEntry, writeEntry } from "@/lib/records/entryWriter";
import { prepareDocument } from "@/lib/records/rowSpans";

/** Which chronology column a written section belongs in. */
const FIELD_FOR: Record<string, string> = {
  subjective: "subjective",
  exam: "objectiveFindings",
  assessment: "diagnosis",
  plan: "treatment",
  procedure: "procedure",
  medications: "medications",
  functional: "functionalStatus",
  studies: "imagingFindings",
  findings: "imagingFindings",
  impression: "diagnosis",
  response: "treatment",
  technique: "imagingFindings",
  preopDx: "diagnosis",
  postopDx: "diagnosis",
  operativeFindings: "procedure",
};

/** Entries written at once. Each is an independent model call. */
const CONCURRENCY = 4;

const ROW_SELECT = {
  id: true,
  sourceDocumentId: true,
  analysisClass: true,
  encounterDate: true,
  dateStatus: true,
  segmentKey: true,
  provider: true,
  facility: true,
  page: true,
  pageEnd: true,
  substanceClass: true,
  claims: true,
} as const;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error("usage: npm run records:rebuild -- <caseId|caseNumber> [--dry-run]");
    process.exit(1);
  }

  const db = new PrismaClient();
  const theCase = await db.case.findFirst({
    where: { OR: [{ id: target }, { caseNumber: target }] },
    select: { id: true, caseNumber: true, clientName: true },
  });
  if (!theCase) {
    console.error(`no case matching ${target}`);
    process.exit(1);
  }
  const caseId = theCase.id;
  console.log(`case ${theCase.caseNumber ?? caseId}${dryRun ? "  (dry run)" : ""}`);

  // ── Rows into the notes they were signed as ────────────────────────────────
  const documents = await db.document.findMany({
    where: { caseId },
    select: { id: true, pageCount: true, extractedText: true },
  });

  const perDocument: MergedEntry[] = [];
  const citable = new Map<string, boolean>();
  let rowCount = 0;

  for (const doc of documents) {
    const rows = (await db.extractedEncounter.findMany({
      where: { caseId, sourceDocumentId: doc.id },
      select: ROW_SELECT,
    })) as unknown as MergeableRow[];
    if (!rows.length) continue;
    rowCount += rows.length;

    const entries = consolidateIntoNotes(mergeRows(rows, prepareDocument(doc.extractedText ?? "")), {
      // A patient is never the author of their own note, and the extractor
      // sometimes reads their name off the chart header instead of the
      // clinician's.
      patientName: theCase.clientName,
    });
    // Offsets resolve real pages, so a citation no longer depends on the
    // recorded page number, which one packet reported as "page 1" throughout.
    citable.set(doc.id, entries.some((e) => e.pageStart) || pageAttributionUsable(rows, doc.pageCount));
    perDocument.push(...entries);
  }

  const notes = dedupeAcrossDocuments(perDocument);
  console.log(`${rowCount} rows -> ${perDocument.length} notes -> ${notes.length} after cross-document dedupe`);

  // ── Notes into prose ──────────────────────────────────────────────────────
  const segmentsFor = new Map<string, unknown[]>();
  const chronology: Record<string, unknown>[] = [];
  const heldOff = new Map<string, number>();
  let written = 0;
  let fallbacks = 0;

  async function compose(note: MergedEntry) {
    // A record with no date gets one read from its own claims — service dates
    // the extractor declined to propose on a billing-shaped line.
    const recovered = note.encounterDate ? null : dateFromClaims(note.claims);
    const iso = note.encounterDate?.toISOString().slice(0, 10) ?? recovered?.iso ?? null;
    const label = iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : "Undated";
    const substance = entrySubstance(note);
    const cite = citable.get(note.sourceDocumentId) ?? false;

    const entry = await writeEntry({
      klass: note.klass,
      date: iso ? label : null,
      provider: note.provider,
      facility: note.facility,
      pageStart: cite ? note.pageStart : null,
      pageEnd: cite ? note.pageEnd : null,
      claims: note.claims,
    });
    if (entry.fallback) fallbacks++;

    const segment = {
      date: iso,
      label,
      pageStart: cite ? note.pageStart : null,
      pageEnd: cite ? note.pageEnd : null,
      // Record furniture leaves the clinical list; a bill stays reachable as
      // ancillary rather than being discarded.
      kind: substance === "CLINICAL" ? "clinical" : "administrative",
      type: note.klass,
      category: substance === "CLINICAL" ? null : substance,
      bearsOnCare: substance !== "ADMINISTRATIVE",
      provider: note.provider,
      facility: note.facility,
      summary: entry.brief,
      full: renderEntry(entry, { includeGaps: false }),
    };
    for (const id of [note.sourceDocumentId, ...(note.alsoInDocumentIds ?? [])]) {
      segmentsFor.set(id, [...(segmentsFor.get(id) ?? []), segment]);
    }

    // The timeline carries the course of care. Everything else stays in the
    // records list, where a reviewer can still open it.
    const material = chronologyMateriality(note);
    if (!material.material) heldOff.set(material.reason, (heldOff.get(material.reason) ?? 0) + 1);

    if (iso && substance === "CLINICAL" && MEDICAL_TIMELINE_CLASSES.has(note.klass) && material.material) {
      // Event type from the record's OWN content, not from its analysis class:
      // mapping CLINICAL_ENCOUNTER to CLINIC_VISIT labelled a PACU note, a lab
      // panel and a medication administration record as clinic visits.
      const kind = classifySegment(note.claims.map((c) => `${c.value} ${c.excerpt}`).join("\n"));
      const event: Record<string, unknown> = {
        caseId,
        eventDate: new Date(`${iso}T00:00:00Z`),
        eventType: kind.eventType,
        specialty: kind.specialty,
        recordType: kind.recordType,
        provider: note.provider,
        facility: note.facility,
        summary: entry.brief,
        sourceDocumentId: note.sourceDocumentId,
        sourcePage: cite ? note.pageStart : null,
        reviewStatus: "AI_DRAFT",
        dateInferred: !!recovered,
        relevanceScore: 50,
      };
      for (const section of entry.sections) {
        const field = FIELD_FOR[section.key];
        if (!field || !section.text) continue;
        event[field] = event[field] ? `${event[field]} ${section.text}` : section.text;
      }
      chronology.push(event);
    }

    written++;
    if (written % 25 === 0) process.stdout.write(`\r  ${written}/${notes.length} written (fallbacks ${fallbacks})   `);
  }

  for (let i = 0; i < notes.length; i += CONCURRENCY) {
    await Promise.all(
      notes.slice(i, i + CONCURRENCY).map((note) =>
        compose(note).catch((error) => {
          // One unwritable note must not cost the rest of the case.
          console.error(`\nnote failed: ${String(error).slice(0, 160)}`);
        }),
      ),
    );
  }

  console.log(`\n\n${notes.length} notes | fallbacks ${fallbacks} (${pct(fallbacks, notes.length)})`);
  console.log(`chronology: ${chronology.length} events`);
  for (const [reason, n] of [...heldOff.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  held off the timeline: ${String(n).padStart(4)} ${reason}`);
  }

  if (dryRun) {
    console.log("\ndry run — nothing written");
    await db.$disconnect();
    return;
  }

  for (const [documentId, segments] of segmentsFor) {
    await db.document.update({
      where: { id: documentId },
      data: { segments: segments as unknown as Prisma.InputJsonValue },
    });
  }

  // Replace drafts only. A regeneration that overwrote a physician's correction
  // would be worse than the defect it was fixing, because the defect was
  // visible and the overwrite is not.
  const reviewed = await db.chronologyEvent.count({
    where: { caseId, reviewStatus: { not: "AI_DRAFT" } },
  });
  const removed = await db.chronologyEvent.deleteMany({ where: { caseId, reviewStatus: "AI_DRAFT" } });
  for (let i = 0; i < chronology.length; i += 200) {
    await db.chronologyEvent.createMany({ data: chronology.slice(i, i + 200) as never });
  }

  console.log(`\nremoved ${removed.count} AI drafts, kept ${reviewed} reviewed, inserted ${chronology.length}`);
  await db.$disconnect();
}

function pct(n: number, total: number): string {
  return `${((100 * n) / Math.max(1, total)).toFixed(1)}%`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
