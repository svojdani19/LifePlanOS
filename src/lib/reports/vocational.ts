import type { Block, ReportDoc } from "./doc";

// ─────────────────────────────────────────────────────────────────────────────
// Vocational Assessment — pure composition (docs/23 P4, docs/25).
//
// Everything here is deterministic and side-effect free: VocationalEntry rows
// in → readiness verdict / ReportDoc out. House rules enforced structurally:
//   - every factual line in the output is drawn from an entry, and every entry
//     carries its `source` citation into the document — nothing is invented;
//   - the vocational OPINION belongs to the vocational expert alone: the
//     Expert Findings section renders only `conclusion` entries, and a package
//     without a verified conclusion AND expert approval is ALWAYS a draft.
// ─────────────────────────────────────────────────────────────────────────────

/** The 15 entry kinds of prisma VocationalEntry.kind (schema comment). */
export const VOC_KINDS = [
  "employment",
  "education",
  "certification",
  "military",
  "job_demand",
  "earnings",
  "absence",
  "rtw_attempt",
  "restriction",
  "functional_capacity",
  "transferable_skill",
  "test_result",
  "labor_market",
  "scenario",
  "conclusion",
] as const;
export type VocKind = (typeof VOC_KINDS)[number];

export const KIND_LABELS: Record<VocKind, string> = {
  employment: "Employment",
  education: "Education",
  certification: "Certification / license",
  military: "Military service",
  job_demand: "Occupational demand",
  earnings: "Earnings",
  absence: "Work absence",
  rtw_attempt: "Return-to-work attempt",
  restriction: "Work restriction",
  functional_capacity: "Functional capacity",
  transferable_skill: "Transferable skill",
  test_result: "Vocational test result",
  labor_market: "Labor-market research",
  scenario: "Vocational scenario",
  conclusion: "Vocational expert conclusion",
};

/** Loose mirror of the VocationalEntry model — only what composition needs. */
export interface VocEntry {
  id?: string;
  kind: string;
  title: string;
  /** Kind-specific structured payload (Json record). */
  detail?: unknown;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  /** Document/interview/expert citation — REQUIRED, never invented. */
  source: string;
  verification?: string | null; // UNVERIFIED | VERIFIED | DISPUTED
  notes?: string | null;
}

// MUST match TYPE_DISCLOSURE.VOCATIONAL_ASSESSMENT in registry.ts (copied, not
// imported: registry.ts will import this module, and importing registry back
// would create a cycle).
export const VOCATIONAL_DISCLOSURE =
  "Medical restrictions are attributed to their clinical sources; client-reported work history, vocational testing, and labor-market data are attributed to their sources. Vocational conclusions require and are attributed to the qualified vocational expert.";

export const SUPPORT_PACKAGE_NOTICE =
  "Vocational expert conclusions have not been entered. This is a support package, not an expert opinion.";

// ── Readiness ────────────────────────────────────────────────────────────────

export type VocationalStatus =
  | "Intake incomplete"
  | "Expert input required"
  | "Draft support package available"
  | "Expert review required"
  | "Ready for final export";

/**
 * Readiness ladder for the vocational workflow:
 *  1. Intake incomplete — no employment history has been entered.
 *  2. Expert input required — intake exists but the clinical inputs (treating-
 *     provider restrictions, functional capacities) are absent.
 *  3. Draft support package available — the draft-required kinds are all
 *     present (employment, restriction, functional_capacity) but no vocational
 *     expert conclusion has been entered.
 *  4. Expert review required — conclusions exist but none is VERIFIED, or the
 *     expert's report-level approval is outstanding.
 *  5. Ready for final export — ≥1 VERIFIED conclusion AND expert approval.
 * `missing` names, in human-readable terms, exactly what is absent.
 */
export function vocationalReadiness(
  entries: VocEntry[],
  approval: { approved: boolean },
): { status: VocationalStatus; missing: string[] } {
  const has = (k: VocKind) => entries.some((e) => e.kind === k);
  const anyConclusion = has("conclusion");
  const verifiedConclusion = entries.some((e) => e.kind === "conclusion" && e.verification === "VERIFIED");

  const intakeMissing: string[] = [];
  if (!has("employment")) intakeMissing.push("Employment history (at least one employment entry)");

  const clinicalMissing: string[] = [];
  if (!has("restriction")) clinicalMissing.push("Work restrictions from a treating or examining provider (at least one restriction entry)");
  if (!has("functional_capacity")) clinicalMissing.push("Functional capacity findings (at least one functional_capacity entry)");

  const expertMissing: string[] = [];
  if (!verifiedConclusion) {
    expertMissing.push(
      anyConclusion
        ? "Verified vocational expert conclusion (an entered conclusion must be marked VERIFIED)"
        : "Vocational expert conclusion (at least one conclusion entry)",
    );
  }
  if (!approval.approved) expertMissing.push("Vocational expert report approval");

  if (intakeMissing.length) return { status: "Intake incomplete", missing: [...intakeMissing, ...clinicalMissing, ...expertMissing] };
  if (clinicalMissing.length) return { status: "Expert input required", missing: [...clinicalMissing, ...expertMissing] };
  if (!anyConclusion) return { status: "Draft support package available", missing: expertMissing };
  if (expertMissing.length) return { status: "Expert review required", missing: expertMissing };
  return { status: "Ready for final export", missing: [] };
}

// ── Pure formatting helpers ──────────────────────────────────────────────────

const fmtDate = (d: Date | string | null | undefined): string => {
  if (!d) return "";
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return "";
  return `${String(x.getUTCMonth() + 1).padStart(2, "0")}/${String(x.getUTCDate()).padStart(2, "0")}/${x.getUTCFullYear()}`;
};

const periodOf = (e: VocEntry): string => {
  const a = fmtDate(e.startDate);
  const b = fmtDate(e.endDate);
  if (a && b) return `${a} – ${b}`;
  if (a) return `${a} – present`;
  if (b) return `through ${b}`;
  return "";
};

const humanKey = (k: string) => k.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Flatten a Json detail record to "Key: value; …" — scalars only, no invention. */
export function detailText(detail: unknown): string {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") parts.push(`${humanKey(k)}: ${v}`);
    else if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) parts.push(`${humanKey(k)}: ${v.join(", ")}`);
  }
  return parts.join("; ");
}

const startTime = (e: VocEntry): number => {
  const t = e.startDate ? new Date(e.startDate).getTime() : NaN;
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
};

const byKind = (entries: VocEntry[], ...kinds: VocKind[]): VocEntry[] => entries.filter((e) => kinds.includes(e.kind as VocKind));

const p = (text: string, italics = false): Block => ({ kind: "p", text, italics });
const h1 = (text: string): Block => ({ kind: "h1", text });
const labeled = (label: string, text: string): Block => ({ kind: "labeled", label, text });
const bullet = (text: string): Block => ({ kind: "bullet", text });
const source = (text: string): Block => ({ kind: "source", text });

const emptyLine = (what: string): Block => p(`No ${what} entries have been recorded.`, true);

/** Body text for one entry: period, structured detail, notes — facts only. */
function entryText(e: VocEntry): string {
  const parts = [periodOf(e), detailText(e.detail), e.notes ?? ""].filter(Boolean);
  return parts.length ? parts.join(". ") + "." : "";
}

/** Standard rendering: labeled fact line + its source attribution. */
function entryBlocks(e: VocEntry, sourceLabel = "Source"): Block[] {
  const out: Block[] = [labeled(e.title, entryText(e) || "Entered without further detail.")];
  out.push(source(`${sourceLabel}: ${e.source}.`));
  return out;
}

// ── Composition ──────────────────────────────────────────────────────────────

export interface ComposeVocationalOpts {
  draft: boolean;
  expertApproved: boolean;
}

/**
 * Compose the Vocational Assessment ReportDoc. Sections appear in a fixed
 * order; empty buckets state so honestly; every entry's source travels with
 * it; and the document is a DRAFT unless a verified expert conclusion exists
 * and the vocational expert has approved — a support package is never a final.
 */
export function composeVocational(caseLabel: string, entries: VocEntry[], opts: ComposeVocationalOpts): ReportDoc {
  const readiness = vocationalReadiness(entries, { approved: opts.expertApproved });
  const blocks: Block[] = [];

  // 1. Demographics / Work History — chronological timeline table.
  blocks.push(h1("Demographics & Work History"));
  const history = byKind(entries, "employment", "education", "certification", "military").sort((a, b) => startTime(a) - startTime(b));
  if (history.length) {
    blocks.push({
      kind: "table",
      header: ["Period", "Category", "Entry", "Detail", "Source"],
      rows: history.map((e) => [periodOf(e) || "—", KIND_LABELS[e.kind as VocKind] ?? e.kind, e.title, [detailText(e.detail), e.notes ?? ""].filter(Boolean).join("; ") || "—", e.source]),
      caption: "Work, education, certification, and military history in chronological order.",
    });
  } else blocks.push(emptyLine("work, education, certification, or military history"));

  // 2. Earnings History.
  blocks.push(h1("Earnings History"));
  const earnings = byKind(entries, "earnings").sort((a, b) => startTime(a) - startTime(b));
  if (earnings.length) earnings.forEach((e) => blocks.push(...entryBlocks(e)));
  else blocks.push(emptyLine("earnings"));

  // 3. Occupational Demands & Transferable Skills.
  blocks.push(h1("Occupational Demands & Transferable Skills"));
  const demands = byKind(entries, "job_demand", "transferable_skill");
  if (demands.length) demands.forEach((e) => blocks.push(...entryBlocks(e)));
  else blocks.push(emptyLine("occupational demand or transferable skill"));

  // 4. Work Restrictions — each with its clinical source attributed.
  blocks.push(h1("Work Restrictions"));
  const restrictions = byKind(entries, "restriction");
  if (restrictions.length) restrictions.forEach((e) => blocks.push(...entryBlocks(e, "Clinical source")));
  else blocks.push(emptyLine("work restriction"));

  // 5. Functional Capacities.
  blocks.push(h1("Functional Capacities"));
  const capacities = byKind(entries, "functional_capacity");
  if (capacities.length) capacities.forEach((e) => blocks.push(...entryBlocks(e)));
  else blocks.push(emptyLine("functional capacity"));

  // 6. Return-to-Work History (attempts and documented absences).
  blocks.push(h1("Return-to-Work History"));
  const rtw = byKind(entries, "rtw_attempt", "absence").sort((a, b) => startTime(a) - startTime(b));
  if (rtw.length) rtw.forEach((e) => blocks.push(...entryBlocks(e)));
  else blocks.push(emptyLine("return-to-work attempt or work absence"));

  // 7. Vocational Testing.
  blocks.push(h1("Vocational Testing"));
  const tests = byKind(entries, "test_result");
  if (tests.length) tests.forEach((e) => blocks.push(...entryBlocks(e)));
  else blocks.push(emptyLine("vocational test result"));

  // 8. Labor-Market Research (including entered scenarios).
  blocks.push(h1("Labor-Market Research"));
  const market = byKind(entries, "labor_market", "scenario");
  if (market.length) market.forEach((e) => blocks.push(...entryBlocks(e)));
  else blocks.push(emptyLine("labor-market research or scenario"));

  // 9. Vocational Expert Findings — the expert's opinion, and ONLY the expert's.
  blocks.push(h1("Vocational Expert Findings"));
  const conclusions = byKind(entries, "conclusion");
  const hasVerifiedConclusion = conclusions.some((e) => e.verification === "VERIFIED");
  if (conclusions.length) {
    for (const e of conclusions) {
      blocks.push(labeled(e.title, entryText(e) || "Entered without further detail."));
      blocks.push(source(`Vocational expert conclusion — ${e.source}.`));
      if (e.verification !== "VERIFIED") blocks.push(p("This conclusion has not been verified by the vocational expert.", true));
    }
  } else {
    blocks.push(p(SUPPORT_PACKAGE_NOTICE, true));
  }

  // 10. Missing Information — readiness gaps + unverified entries, honestly.
  blocks.push(h1("Missing Information"));
  const unverified = entries.filter((e) => (e.verification ?? "UNVERIFIED") !== "VERIFIED");
  if (!readiness.missing.length && !unverified.length) {
    blocks.push(p("No outstanding information gaps are recorded.", true));
  } else {
    readiness.missing.forEach((m) => blocks.push(bullet(m)));
    unverified.forEach((e) =>
      blocks.push(bullet(`Unverified entry: ${e.title} (${KIND_LABELS[e.kind as VocKind] ?? e.kind}) — ${e.verification === "DISPUTED" ? "DISPUTED" : "UNVERIFIED"}; source: ${e.source}.`)),
    );
  }

  // 11. Source Records — deduplicated citations across every entry.
  blocks.push(h1("Source Records"));
  const sources = [...new Set(entries.map((e) => e.source.trim()).filter(Boolean))];
  if (sources.length) sources.forEach((s) => blocks.push(source(s)));
  else blocks.push(p("No source records have been cited.", true));

  // A package without a verified expert conclusion AND the expert's approval is
  // NEVER a final — regardless of what the caller asked for.
  const draft = opts.draft || !opts.expertApproved || !hasVerifiedConclusion;

  return {
    reportId: "VOCATIONAL_ASSESSMENT",
    title: "Vocational Assessment",
    subtitle: "Employability, work capacity, and earning implications",
    caseLabel,
    blocks,
    draft,
    disclosures: [VOCATIONAL_DISCLOSURE],
  };
}
