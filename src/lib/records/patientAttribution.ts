// ─────────────────────────────────────────────────────────────────────────────
// Is the "provider" actually the patient?
//
// The failure that drove this: a home-health physical-therapy evaluation for
// Derrick McHenry listed its provider as "Demick MCHENRY" — the patient's own
// name, OCR-mangled, lifted from the chart header into the provider field. It
// then appeared in the chronology as if a clinician named McHenry had treated
// him.
//
// The deterministic patient exclusion tolerates ONE edit, and stretching it to
// two would start swallowing real clinicians ("Dr. Chen" vs "Chan"). So the
// gray zone goes to an adjudicator with the note's own text, the same way
// undecided duplicates do — and with the same discipline:
//
//   - candidacy is deterministic and cheap; the model cannot volunteer names
//   - only a confident "this is the patient" strips the attribution
//   - any failure, timeout, malformed answer or hesitation keeps it, where a
//     reviewer can still see and correct it
//   - a stripped entry keeps everything else; it becomes unattributed, which
//     is honest, rather than attributed to a clinician who does not exist
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import { getProvider, type LlmProvider } from "@/lib/llm";
import type { MergedEntry } from "@/lib/records/entryMerge";

/** Credentials and honorifics that are not name tokens. */
const NOT_A_NAME = new Set(["md", "do", "dc", "pa", "np", "rn", "lpn", "pt", "dpt", "ot", "phd", "facs", "faaos", "mr", "mrs", "ms", "dr", "jr", "sr", "iii"]);

const nameTokens = (s: string | null | undefined): string[] =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !NOT_A_NAME.has(w));

/** Bounded Levenshtein: true when a and b are within `max` edits. */
export function withinEdits(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/**
 * Entries whose provider RESEMBLES the patient closely enough to ask about.
 *
 * A token of the patient's name within two edits of a token of the provider's
 * (one edit for short tokens — two edits in six letters is a different name).
 * "Demick MCHENRY" vs "Derrick McHenry" matches on both tokens; "Paul
 * English, MD" matches on none and is never sent to the model.
 */
export function candidatePatientAttributions(notes: readonly MergedEntry[], patientName: string | null | undefined): MergedEntry[] {
  const patient = nameTokens(patientName);
  if (!patient.length) return [];
  const near = (a: string, b: string) => withinEdits(a, b, Math.min(a.length, b.length) >= 7 ? 2 : 1);
  return notes.filter((note) => {
    const provider = nameTokens(note.provider);
    return provider.length > 0 && provider.some((p) => patient.some((t) => near(p, t)));
  });
}

const verdictSchema = z.object({
  is_patient: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string().min(3).max(400),
});

const SYSTEM = `You review the provider attribution of one medical-record entry.

An extraction system filled the PROVIDER field — the clinician who authored or delivered the encounter — with a name that closely resembles the PATIENT's name. Chart headers print the patient's name beside the author's, and OCR distorts letters, so a patient's own name, possibly misspelled, often lands in the provider field by mistake. A patient is never the clinician author of their own record.

Decide whether the extracted provider name is actually the patient.

It IS the patient when the name reads as the patient's name or an obvious OCR or typo variant of it, and nothing in the entry's text indicates a distinct clinician who happens to share the name — such as a signature with clinical credentials, or text naming that person as the treating clinician.

It is NOT the patient when the entry's text supports a real clinician by that name (family members treat family; colleagues share surnames).

Answer "high" confidence only when a reviewer reading the entry would say without hesitation that the provider field holds the patient's name. Reply with JSON only:
{"is_patient": true|false, "confidence": "high"|"medium"|"low", "reason": "<one sentence>"}`;

const promptFor = (patientName: string, note: MergedEntry): string =>
  [
    `PATIENT: ${patientName}`,
    `EXTRACTED PROVIDER: ${note.provider}`,
    `ENTRY DATE: ${note.encounterDate?.toISOString().slice(0, 10) ?? "undated"}`,
    `FACILITY: ${note.facility ?? "not stated"}`,
    "",
    "ENTRY TEXT (extracted claims with source excerpts):",
    ...note.claims.slice(0, 12).map((c) => `- ${c.field}: ${c.value.slice(0, 160)}${c.excerpt ? ` ["${c.excerpt.slice(0, 120)}"]` : ""}`),
  ].join("\n");

const extractJson = (raw: string): string => {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
};

export interface AttributionOutcome {
  /** How many entries resembled the patient closely enough to ask about. */
  candidates: number;
  asked: number;
  /** Entries whose provider was confidently the patient and was cleared. */
  cleared: { provider: string; date: string | null; reason: string }[];
  failed: number;
}

/**
 * Ask about each candidate and CLEAR the attribution of confident matches.
 *
 * Mutates the notes in place (provider and per-appearance provider copies),
 * before duplicate adjudication runs — a fabricated shared name must not be
 * the "same named clinician" that pairs two records.
 */
export async function adjudicatePatientAttribution(
  notes: readonly MergedEntry[],
  patientName: string | null | undefined,
  options: { provider?: LlmProvider; concurrency?: number } = {},
): Promise<AttributionOutcome> {
  const candidates = candidatePatientAttributions(notes, patientName);
  const outcome: AttributionOutcome = { candidates: candidates.length, asked: 0, cleared: [], failed: 0 };
  if (!candidates.length || !patientName) return outcome;

  let llm: LlmProvider;
  try {
    llm = options.provider ?? getProvider();
  } catch {
    return outcome; // no provider: the attribution stands, visibly, for review
  }

  const concurrency = options.concurrency ?? 4;
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const verdicts = await Promise.all(
      batch.map(async (note) => {
        outcome.asked++;
        try {
          const raw = await llm.complete({
            system: SYSTEM,
            messages: [{ role: "user", content: promptFor(patientName, note) }],
            temperature: 0,
            maxTokens: 400,
          });
          const parsed = verdictSchema.safeParse(JSON.parse(extractJson(raw)));
          if (!parsed.success) {
            outcome.failed++;
            return null;
          }
          return parsed.data;
        } catch {
          outcome.failed++;
          return null;
        }
      }),
    );
    batch.forEach((note, index) => {
      const verdict = verdicts[index];
      if (!verdict || !verdict.is_patient || verdict.confidence !== "high") return;
      outcome.cleared.push({
        provider: note.provider ?? "",
        date: note.encounterDate?.toISOString().slice(0, 10) ?? null,
        reason: verdict.reason,
      });
      const stripped = note.provider;
      note.provider = null;
      for (const appearance of note.appearances ?? []) {
        if (appearance.provider === stripped) appearance.provider = null;
      }
    });
  }
  return outcome;
}
