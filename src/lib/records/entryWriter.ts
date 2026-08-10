// ─────────────────────────────────────────────────────────────────────────────
// Writing a chronology entry the way a life care planner writes one.
//
// The program had two summary paths and neither produced a summary. One picked
// a single sentence out of the raw page with a regex — that is where "Was made
// of motor function" and "Keep the injured part elevated to reduce pain and
// swelling" came from. The other selected up to three validated claims and
// joined them with semicolons. Both SELECT text. Neither WRITES anything, and
// no amount of better selection turns a quotation lifted out of a therapy note
// into a sentence a physician would sign.
//
// What a published plan actually contains, for one chiropractic visit:
//
//   Subjective: The patient reported increased numbness and tingling in the
//     left 3rd, 4th, and 5th digits upon waking… He stated that lumbar traction
//     therapy provided some improvement in his symptoms.
//   Exam: Musculoskeletal: Limitation of motion and stiffness were present.
//   Assessment: Internal derangement of the left knee; lumbar facet syndrome…
//   Plan: Lumbar mechanical traction was performed at 62 lbs from 10:53 am to
//     11:08 am… Short-term goals remained to decrease pain and increase range
//     of motion. (Pdf 16: p. 11-13)
//
// Authored third-person clinical prose, grouped into the section set that this
// KIND of record uses, roughly two hundred words, cited once at the end. Not a
// quotation, and not one line.
//
// GROUNDING. Every sentence is checked against the claims it cites before it is
// shown: no new figure, no new date, no new proper name, no invented laterality
// or certainty, no contemplated care narrated as delivered. That is claim-level
// grounding rather than sentence-level quotation, which is the trade the
// published plans themselves make — "There was tenderness around the lateral
// inferior aspect of the left patella" is the planner writing, not quoting. The
// verbatim excerpt stays attached to each claim, so a reviewer can still land
// on the exact words behind any statement.
//
// And when the writer cannot be verified, the entry falls back to the
// deterministic rendering rather than showing prose nobody checked.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import { getProvider, type LlmProvider } from "@/lib/llm";
import { profileFor, type AnalysisClass } from "@/lib/documents/analysisClass";
import { checkSentence, type SynthClaim } from "@/lib/llm/groundedSynthesis";
import { SECTION_CONTRACT, type SectionSpec, type SectionVerdict } from "@/lib/records/sectionLedger";

export const WRITER_PROMPT_VERSION = "rex-write-1.0";

export interface WrittenSection {
  key: string;
  label: string;
  /** Authored prose, or null when the section has nothing behind it. */
  text: string | null;
  /** Why it is empty, when it is. */
  gap: string | null;
}

export interface WrittenEntry {
  /** "07/12/2023 — Michael Crone, DC / The Houston Spine and Rehabilitation Centers" */
  heading: string;
  /** One sentence for the records list. */
  brief: string;
  /** The full entry, section by section, for the chronology. */
  sections: WrittenSection[];
  /** "pp. 11–13", or null when page attribution is not trustworthy. */
  citation: string | null;
  /** Sentence -> supporting claim ids, for audit. */
  sentenceClaimMap: Record<string, string[]>;
  /** True when the deterministic renderer produced this rather than the writer. */
  fallback: boolean;
  /** Verification failures, kept for review rather than hidden. */
  rejections: string[];
}

export interface EntryInput {
  klass: AnalysisClass;
  /** Display date, e.g. "07/12/2023". Null for records that carry no date. */
  date: string | null;
  provider: string | null;
  facility: string | null;
  /** Page range across every row merged into this entry. */
  pageStart: number | null;
  pageEnd: number | null;
  claims: readonly SynthClaim[];
  /** Ledger verdicts, so an empty section can say WHY it is empty. */
  ledger?: readonly SectionVerdict[];
}

// ── Heading and citation ─────────────────────────────────────────────────────

export function headingFor(input: EntryInput): string {
  const who = [input.provider, input.facility].filter(Boolean).join(" / ");
  if (input.date && who) return `${input.date} — ${who}`;
  if (input.date) return input.date;
  return who || profileFor(input.klass).unit.replace(/^./, (c) => c.toUpperCase());
}

/**
 * Page attribution is only cited when it is worth citing.
 *
 * A real 56-page packet recorded every row on "page 1". Printing "p. 1" against
 * a 200-word entry drawn from page 12 is worse than printing nothing: it sends
 * a reviewer to the wrong page and it looks authoritative doing it.
 */
export function citationFor(pageStart: number | null, pageEnd: number | null): string | null {
  if (!pageStart) return null;
  if (pageEnd && pageEnd > pageStart) return `pp. ${pageStart}–${pageEnd}`;
  return `p. ${pageStart}`;
}

// ── What sections this entry can fill ────────────────────────────────────────

/**
 * Sections whose fields this entry has claims for, in the order a plan reads
 * them.
 *
 * Falls back to a single catch-all section when the contract matches nothing.
 * Two kinds of record hit that: UNKNOWN, which deliberately has no contract at
 * all, and a classified record whose claims happen to sit in fields its class
 * does not list. Bailing out left both of them with no entry to write — a
 * measured 8 of 44 sampled records produced the unwritten "Unclassified
 * record — see the cited source page", which is exactly the useless line this
 * writer exists to stop printing. A record we can state facts about deserves
 * an entry even when we cannot name its parts.
 */
export function sectionsFor(klass: AnalysisClass, claims: readonly SynthClaim[]): SectionSpec[] {
  const have = new Set(claims.map((c) => c.field));
  const matched = (SECTION_CONTRACT[klass] ?? []).filter((s) => s.fields.some((f) => have.has(f)));
  if (matched.length) return matched;
  if (!have.size) return [];
  return [
    {
      key: "record",
      concept: "other",
      label: "Record",
      fields: [...have] as SectionSpec["fields"],
      header: /(?!)/,
    },
  ];
}

/**
 * The heading facts, as citable support.
 *
 * The prompt tells the writer who authored the record and where, so prose that
 * names them is correct — but grounding checked only the claims and rejected
 * "The patient presented to the Emergency Department" as introducing a name
 * the claims did not contain. These are support like any other, with ids so a
 * sentence can cite them and the audit trail still shows what it rests on.
 */
function contextClaims(input: EntryInput): SynthClaim[] {
  const out: SynthClaim[] = [];
  if (input.provider) out.push({ id: "ctx-provider", field: "provider", value: input.provider, excerpt: input.provider, page: null });
  if (input.facility) out.push({ id: "ctx-facility", field: "facility", value: input.facility, excerpt: input.facility, page: null });
  if (input.date) out.push({ id: "ctx-date", field: "encounterDate", value: input.date, excerpt: input.date, page: null });
  return out;
}

function claimsForSection(spec: SectionSpec, claims: readonly SynthClaim[]): SynthClaim[] {
  const fields = new Set<string>(spec.fields);
  return claims.filter((c) => fields.has(c.field));
}

// ── The writer ───────────────────────────────────────────────────────────────

const writerSchema = z
  .object({
    brief: z.string().min(10).max(300),
    sections: z
      .array(
        z
          .object({
            key: z.string().max(64),
            sentences: z
              .array(z.object({ text: z.string().min(3).max(600), claimIds: z.array(z.string().max(64)).min(1).max(16) }).strict())
              .min(1)
              // A busy admission's plan legitimately runs long; 14 was an
              // invented ceiling that discarded an otherwise valid entry.
              .max(30),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    briefClaimIds: z.array(z.string().max(64)).min(1).max(16),
  })
  .strict();

function buildPrompt(input: EntryInput, specs: SectionSpec[]): { system: string; user: string } {
  const profile = profileFor(input.klass);
  const system = [
    `You write ONE entry of a physician-authored Life Care Plan medical chronology. Writer version ${WRITER_PROMPT_VERSION}.`,

    `You are given the validated claims extracted from a single ${profile.unit}. Write the entry the way a qualified life care planner writes it: third-person, past tense, neutral clinical prose. "There was tenderness at the lateral joint line." "Lumbar traction was performed at 62 lbs." Never first person, never "the record states", never a bulleted list of fields.`,

    `Group your sentences into the SECTIONS listed below, using each section's key. A section normally runs one to five sentences; a busy visit's plan can run longer. Do not pad, and do not compress a documented fact out of existence — if the claims record a dose, a measurement, a laterality, an anatomic level or a duration, it belongs in the prose exactly as recorded.`,

    `You may use ONLY the supplied claims. You may not add any fact, name, date, figure, diagnosis, procedure, medication or measurement that is not in them, and you may not draw on outside medical knowledge. Preserve what the claims say: keep hedging ("possible", "suggestive of") as hedging, keep negatives as negatives, keep recommended care as recommended and delivered care as delivered.`,

    `Repetition is not a reason to omit. A therapy note restates its standing diagnosis at every visit and the planner publishes it every time, because each entry has to stand on its own as evidence a reader can cite without scrolling back.`,

    `Also write "brief": ONE sentence, under 220 characters, naming what kind of contact this was and the single most consequential thing about it — what a reviewer scanning a list of records needs in order to decide whether to open this one. Not a label, not a restatement of the date.`,

    `Return ONLY: {"brief":"…","briefClaimIds":["id",…],"sections":[{"key":"…","sentences":[{"text":"…","claimIds":["id",…]}]}]}. Every sentence lists the claim ids supporting it. A sentence you cannot attribute must not be written.`,
  ].join("\n\n");

  const sectionList = specs.map((s) => `  ${s.key} — ${s.label}`).join("\n");
  const claimList = [...input.claims, ...contextClaims(input)]
    .map((c) => `[${c.id}] (${c.field}${c.claimType ? `/${c.claimType}` : ""}) ${c.value}  ⟵ "${c.excerpt.slice(0, 220)}"`)
    .join("\n");

  const user = [
    `RECORD KIND: ${profile.unit}${input.provider ? `, authored by ${input.provider}` : ""}${input.facility ? ` at ${input.facility}` : ""}${input.date ? `, dated ${input.date}` : ""}.`,
    `SECTIONS TO FILL (use these keys, omit any you have no claims for):\n${sectionList}`,
    `VALIDATED CLAIMS (the only permitted content):\n${claimList}`,
  ].join("\n\n");

  return { system, user };
}

function parseJson(raw: string): unknown {
  return JSON.parse(
    raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, ""),
  );
}

/**
 * Deterministic entry, used when the writer cannot be verified.
 *
 * Not prose — it states the claims plainly, grouped by section. A reviewer sees
 * the facts and can tell from the absence of narrative that this entry was not
 * composed. That is the point: the system is never under pressure to accept
 * prose it could not check.
 */
export function deterministicEntry(input: EntryInput, specs: SectionSpec[]): WrittenSection[] {
  return specs.map((spec) => {
    const mine = claimsForSection(spec, input.claims);
    const text = mine.length
      ? mine.map((c) => c.value.replace(/\s+$/, "").replace(/\.$/, "")).join(". ") + "."
      : null;
    return { key: spec.key, label: spec.label, text, gap: text ? null : gapFor(spec.key, input) };
  });
}

/** Why a section is empty — a stated gap, never a silent blank. */
function gapFor(key: string, input: EntryInput): string {
  const verdict = input.ledger?.find((v) => v.key === key);
  const where = citationFor(input.pageStart, input.pageEnd);
  if (verdict?.state === "RECOVERABLE_MISS") {
    return `Not captured from this record${where ? ` — review ${where}` : ""}.`;
  }
  return "Not documented in this record.";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * How long one writing attempt may take before it is abandoned.
 *
 * A request that never returns is worse than one that fails: a whole case
 * rebuild sat at 100 of 766 entries for three quarters of an hour because a
 * single call hung and the batch waiting on it could not proceed. A timeout
 * turns that into an ordinary retryable error.
 */
const ATTEMPT_TIMEOUT_MS = 120_000;

async function withTimeout<T>(work: Promise<T>, ms = ATTEMPT_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("writer attempt timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface WriteOptions {
  provider?: LlmProvider;
}

/**
 * Compose one chronology entry. One corrective retry against the specific
 * verification failures, then the deterministic fallback.
 */
/**
 * How many claims the writer is given at once.
 *
 * Not a limit on the record — a limit on the prompt. At eighty claims a fifth
 * of entries came back malformed and each took twenty-five seconds; at
 * thirty-five they succeed and take five. Splitting the RECORD to satisfy that
 * was the wrong fix: it turned 1,111 entries into 1,684 and fragmented visits
 * a reviewer reads as one. A large record is written in passes and reassembled
 * into the single entry it always was.
 */
export const CLAIMS_PER_PASS = 35;

export async function writeEntry(input: EntryInput, opts: WriteOptions = {}): Promise<WrittenEntry> {
  if (input.claims.length > CLAIMS_PER_PASS) return writeInPasses(input, opts);
  return writeOnePass(input, opts);
}

/**
 * Write a large record in passes and reassemble it.
 *
 * Each pass sees a slice of the claims in document order and writes the
 * sections that slice supports; the parts are then joined section by section,
 * in the order a plan reads them. The brief comes from the first pass, which
 * holds the record's opening — what a reviewer scanning a list needs.
 */
async function writeInPasses(input: EntryInput, opts: WriteOptions): Promise<WrittenEntry> {
  const passes: WrittenEntry[] = [];
  for (let at = 0; at < input.claims.length; at += CLAIMS_PER_PASS) {
    passes.push(await writeOnePass({ ...input, claims: input.claims.slice(at, at + CLAIMS_PER_PASS) }, opts));
  }
  const order = sectionsFor(input.klass, input.claims).map((s) => s.key);
  const merged: WrittenSection[] = [];
  for (const key of order) {
    const parts = passes.flatMap((p) => p.sections.filter((s) => s.key === key && s.text));
    if (!parts.length) continue;
    merged.push({ key, label: parts[0].label, text: parts.map((p) => p.text).join(" "), gap: null });
  }
  const written = passes.filter((p) => !p.fallback);
  return {
    heading: passes[0].heading,
    brief: (written[0] ?? passes[0]).brief,
    sections: merged.length ? merged : passes[0].sections,
    citation: passes[0].citation,
    sentenceClaimMap: Object.assign({}, ...passes.map((p) => p.sentenceClaimMap)),
    // The record is unwritten only when no pass could be written.
    fallback: !written.length,
    rejections: passes.flatMap((p) => p.rejections),
  };
}

async function writeOnePass(input: EntryInput, opts: WriteOptions = {}): Promise<WrittenEntry> {
  const specs = sectionsFor(input.klass, input.claims);
  const heading = headingFor(input);
  const citation = citationFor(input.pageStart, input.pageEnd);

  const bail = (rejections: string[]): WrittenEntry => ({
    heading,
    brief: deterministicBrief(input),
    sections: deterministicEntry(input, specs),
    citation,
    sentenceClaimMap: {},
    fallback: true,
    rejections,
  });

  if (!input.claims.length || !specs.length) return bail(["no validated claims to write from"]);

  const llm = opts.provider ?? getProvider();
  if (llm.name === "mock") return bail(["writer unavailable: provider not configured"]);

  // The prompt tells the writer who authored the record and where, so prose
  // that names them is correct — but grounding checked only the claims, and
  // rejected "The patient presented to the Emergency Department" as
  // introducing a name the claims did not contain. The heading facts are
  // support like any other; they are given an id so a sentence can cite them
  // and the audit trail still shows what every statement rests on.
  const byId = new Map([...input.claims, ...contextClaims(input)].map((c) => [c.id, c]));
  const { system, user } = buildPrompt(input, specs);

  const attempt = async (extra?: string) => {
    const raw = await llm.complete({
      system,
      messages: [{ role: "user", content: extra ? `${user}\n\n${extra}` : user }],
      temperature: 0,
      maxTokens: 8_000,
    });
    let parsed;
    try {
      parsed = writerSchema.safeParse(parseJson(raw));
    } catch {
      return { ok: false as const, reasons: [`output was not valid JSON: ${raw.trim().slice(0, 120)}`] };
    }
    if (!parsed.success) {
      return { ok: false as const, reasons: [`output did not match the required schema: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`] };
    }

    const reasons: string[] = [];
    const map: Record<string, string[]> = {};

    // Heading facts support every sentence without being cited: the writer is
    // TOLD the provider, facility and date, so naming them is correct whether
    // or not it thought to list them as support. Requiring the citation
    // rejected "The patient presented to the Emergency Department" for
    // introducing a name that was in the prompt's own header.
    const ambient = contextClaims(input).map((c) => c.id);
    const withAmbient = (ids: string[]) => [...new Set([...ids, ...ambient])];

    const briefProblem = checkSentence(parsed.data.brief, withAmbient(parsed.data.briefClaimIds), byId);
    if (briefProblem) reasons.push(`the one-line summary ${briefProblem}`);

    const written = new Map<string, string>();
    for (const section of parsed.data.sections) {
      if (!specs.some((s) => s.key === section.key)) {
        reasons.push(`wrote a section "${section.key}" that this record does not have`);
        continue;
      }
      for (const s of section.sentences) {
        const problem = checkSentence(s.text, withAmbient(s.claimIds), byId);
        if (problem) reasons.push(`"${s.text.slice(0, 60)}…" ${problem}`);
        else map[s.text.trim()] = s.claimIds;
      }
      written.set(section.key, section.sentences.map((s) => s.text.trim()).join(" "));
    }
    if (reasons.length) return { ok: false as const, reasons };

    // No re-split check. Displayed text is exactly the sentences verified
    // above, joined — coverage holds by construction. Re-splitting the joined
    // text and demanding each fragment match a mapped sentence produced
    // fragments that SPAN two sentences (a dose written "at 1950. dT tetanus"
    // splits on the figure's full stop), and rejected entries every sentence
    // of which had already passed.

    const sections: WrittenSection[] = specs.map((spec) => {
      const text = written.get(spec.key) ?? null;
      return { key: spec.key, label: spec.label, text, gap: text ? null : gapFor(spec.key, input) };
    });
    return { ok: true as const, brief: parsed.data.brief.trim(), sections, map };
  };

  // A transient provider failure is not a verification failure, and must not be
  // treated as one. Running the writer eight-wide pushed 10 of 24 entries into
  // the unwritten fallback purely on rate limits — the entry was never composed
  // at all, and the reviewer saw "Unclassified record" for a record the writer
  // had never been given a chance to read.
  const withRetry = async (extra?: string) => {
    let lastError: unknown;
    for (let tryCount = 0; tryCount < 4; tryCount++) {
      try {
        return await withTimeout(attempt(extra));
      } catch (error) {
        lastError = error;
        await sleep(400 * 2 ** tryCount);
      }
    }
    throw lastError;
  };

  try {
    const first = await withRetry();
    if (first.ok) {
      return { heading, brief: first.brief, sections: first.sections, citation, sentenceClaimMap: first.map, fallback: false, rejections: [] };
    }
    const second = await withRetry(
      `Your previous entry was rejected for these reasons:\n${first.reasons.map((r) => `- ${r}`).join("\n")}\nRewrite it using ONLY the validated claims, attributing every sentence. Return ONLY the JSON object.`,
    );
    if (second.ok) {
      return { heading, brief: second.brief, sections: second.sections, citation, sentenceClaimMap: second.map, fallback: false, rejections: first.reasons };
    }
    return bail([...first.reasons, ...second.reasons]);
  } catch {
    return bail(["writer provider error after repeated attempts"]);
  }
}

/** A one-line summary that states a fact rather than a label, without the model. */
function deterministicBrief(input: EntryInput): string {
  const profile = profileFor(input.klass);
  const lead = profile.leadFields
    .map((f) => input.claims.find((c) => c.field === f))
    .find(Boolean);
  const unit = profile.unit.replace(/^./, (c) => c.toUpperCase());
  if (!lead) return `${unit} — see the cited source page.`;
  const fact = lead.value.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return `${unit} — ${fact.length > 200 ? `${fact.slice(0, 197)}…` : fact}.`;
}

/** Render one written entry as the plain text a chronology row displays. */
export function renderEntry(entry: WrittenEntry, opts: { includeGaps?: boolean } = {}): string {
  const lines = [entry.heading];
  for (const s of entry.sections) {
    if (s.text) lines.push(`${s.label}: ${s.text}`);
    else if (opts.includeGaps && s.gap) lines.push(`${s.label}: ${s.gap}`);
  }
  if (entry.citation) lines.push(`(${entry.citation})`);
  return lines.join("\n");
}
