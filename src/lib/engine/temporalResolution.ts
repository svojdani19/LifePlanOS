// ─────────────────────────────────────────────────────────────────────────────
// Temporal resolution: WHEN a documented statement applies.
//
// A life care plan projects care the patient has yet to receive. The records
// are full of statements that look identical to that but are not: a fusion the
// patient had in 2019, a surgery they declined, an injection "if symptoms
// persist", a recommendation a later note withdrew. Reading any of those as
// future care inflates the plan with care nobody is going to deliver.
//
// Every care-relevant statement is therefore resolved to exactly one temporal
// status before it is allowed to support anything:
//
//   PRE_INJURY   dated before the injury — this plan projects injury care
//   COMPLETED    already delivered; a past operation is not a future one
//   PLANNED      recommended/ordered/scheduled and still owed
//   CURRENT      an ongoing regimen or a present functional status
//   CONDITIONAL  contingent on an event that may not occur
//   CANCELLED    withdrawn by the treating side
//   DECLINED     refused by the patient
//   SUPERSEDED   a later statement on the same subject governs instead
//   CONTRADICTED a later statement on the same subject says the opposite
//   AMBIGUOUS    the record does not establish when it applies
//
// Only PLANNED and CURRENT can satisfy a future-care gate. AMBIGUOUS cannot,
// and an UNDATED statement is always AMBIGUOUS: a claim that cannot be placed
// in time cannot establish that care is still owed, however emphatic its
// wording. That rule is deliberately strict — the cost of a missed item is a
// physician adding it back; the cost of an invented one is a plan that
// misrepresents the patient.
// ─────────────────────────────────────────────────────────────────────────────

export type TemporalStatus =
  | "PRE_INJURY"
  | "COMPLETED"
  | "PLANNED"
  | "CURRENT"
  | "CONDITIONAL"
  | "CANCELLED"
  | "DECLINED"
  | "SUPERSEDED"
  | "CONTRADICTED"
  | "AMBIGUOUS";

export interface TemporalFact {
  status: TemporalStatus;
  /** Reviewer-facing reason, safe to show beside the citation. */
  reason: string;
  /** Only PLANNED and CURRENT describe care still owed to the patient. */
  supportsFutureCare: boolean;
}

/**
 * What kind of statement is being placed in time. A RECOMMENDATION must say
 * that care is intended; an OBSERVATION (functional status, an active
 * medication) describes the patient as of its date and needs no verb of
 * intent.
 */
export type StatementKind = "RECOMMENDATION" | "OBSERVATION";

export interface TemporalInput {
  text: string;
  /** ISO date of the encounter the statement came from; null when undated. */
  date: string | null;
  dateOfInjury?: Date | null;
  kind: StatementKind;
}

// ── Language ────────────────────────────────────────────────────────────────

/** The patient refused. */
const DECLINED_RE = /\b(?:declin\w+|refus\w+|does not (?:wish|want|desire)|not interested in|opted (?:not|against)|against medical advice|patient (?:is )?unwilling)\b/i;

/** The treating side withdrew or called it off. */
// "No longer a surgical candidate" must not be read as "candidate for
// surgery" — the intervening adjective is exactly how a withdrawal reads as a
// recommendation.
const CANCELLED_RE =
  /\b(?:cancel\w+|call(?:ed)? off|no longer (?:planned|scheduled|recommended|indicated|(?:an? )?[a-z]{0,14}\s?candidate)|(?:not|never) (?:an? )?[a-z]{0,14}\s?candidate|held indefinitely|deferred indefinitely|abandon\w+ (?:the )?plan)\b/i;

/** Contingent on something that may never happen. */
const CONDITIONAL_RE =
  /^\s*(?:if|should)\b|\b(?:if (?:needed|indicated|necessary|conservative (?:care|treatment) fails|symptoms persist|he|she|they|the patient)|as needed only|prn only|possible option|may be (?:considered|an option)|might (?:be )?(?:need|require|consider)|in the event|would be a candidate|consider(?:ation of)? (?:future|possible)|potentially|contingent (?:up)?on|pending (?:insurance|authorization|approval))\b/i;

/** Already delivered. */
const COMPLETED_RE =
  /\b(?:s\/p|status[- ]post|underwent|was performed|were performed|has (?:had|undergone|completed)|had (?:a |an )?(?:successful )?(?:surgery|operation|fusion|discectomy|laminectomy|arthroplasty|replacement|repair|injection)|completed (?:a )?(?:course|series|program)|post[- ]?operative day|previously (?:had|underwent|received)|history of (?:surgery|fusion|arthroplasty))\b/i;

/** Intended and still owed. */
const PLANNED_RE =
  /\b(?:recommend\w*|advis\w*|candidate for|plan(?:ned|s)? (?:for|to|on)|will (?:undergo|need|require|proceed)|scheduled (?:for|to)|refer(?:red|ral)? (?:for|to)|prescrib\w*|order(?:ed|s)?\b|initiate|to be (?:scheduled|performed)|awaiting (?:authorization|scheduling))\b/i;

/** Ongoing as of the note. */
const CURRENT_RE =
  /\b(?:continue[sd]?|ongoing|currently (?:taking|receiving|using|on)|remains? on|maintained on|daily|active (?:medication|regimen)|is (?:taking|receiving)|at this time)\b/i;

/** An observation that a previously documented deficit has resolved. */
const RESOLUTION_RE =
  /\b(?:no longer (?:requires?|needs?|uses?|dependent)|has since (?:regained|returned|recovered)|weaned (?:off|from)|discontinued|returned to baseline|independent (?:with|in) (?:adls?|ambulation|transfers|mobility)|ambulate[sd]? independently|full(?:y)? independent|without (?:assistive device|assistance))\b/i;

// ── Subject identity ────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

const CLASS_TOKENS: [string, RegExp][] = [
  ["surgery", /\b(?:fusion|discectomy|laminectomy|decompression|arthroplasty|replacement|arthroscop\w*|orif|kyphoplasty|meniscectom\w*|surger\w+|operation|surgical)\b/i],
  ["injection", /\b(?:injection|epidural|nerve block|facet|radiofrequency|ablation|rhizotom\w*)\b/i],
  ["therapy", /\b(?:physical therapy|occupational therapy|\bpt\b|\bot\b|rehab\w*|aquatic therapy)\b/i],
  ["imaging", /\b(?:mri|ct scan|x-?ray|emg|ncv|myelogram|imaging)\b/i],
  ["psych", /\b(?:neuropsych\w*|psycholog\w*|psychiatr\w*|counsel\w*|behavioral health)\b/i],
  ["stimulator", /\b(?:spinal cord stimulator|neurostimulator|intrathecal pump|pain pump)\b/i],
  ["mobility", /\b(?:wheelchair|walker|scooter|prosthe\w*|orthotic|brace)\b/i],
  ["attendant", /\b(?:attendant care|home health|caregiver|personal care|24.?hour (?:care|supervision))\b/i],
];

const ANATOMY_TOKENS = ["cervical", "thoracic", "lumbar", "lumbosacral", "knee", "hip", "shoulder", "spine", "wrist", "ankle", "elbow", "foot", "hand"];

/**
 * The subject a statement is about: care class plus anatomy. Two statements
 * share a subject only when both are identified — a vague statement never
 * silently overrides a specific one.
 */
export function subjectKey(text: string): string | null {
  const cls = CLASS_TOKENS.find(([, re]) => re.test(text));
  if (!cls) return null;
  const t = norm(text);
  const anatomy = ANATOMY_TOKENS.filter((a) => t.includes(a)).sort().join("-") || "general";
  return `${cls[0]}|${anatomy}`;
}

// ── Resolution ──────────────────────────────────────────────────────────────

const fact = (status: TemporalStatus, reason: string): TemporalFact => ({
  status,
  reason,
  supportsFutureCare: status === "PLANNED" || status === "CURRENT",
});

/** Place ONE statement in time, from its own language and date alone. */
export function resolveTemporal(input: TemporalInput): TemporalFact {
  const { text, date, kind } = input;

  // Disqualifying language wins regardless of date: a refusal is a refusal
  // whether or not the note carrying it is dated.
  if (DECLINED_RE.test(text)) return fact("DECLINED", "The records document that the patient declined this care.");
  if (CANCELLED_RE.test(text)) return fact("CANCELLED", "This care was withdrawn or called off in the records.");
  if (CONDITIONAL_RE.test(text)) return fact("CONDITIONAL", "This is contingent on an event the records do not establish will occur.");

  // An undated statement cannot be placed in time, and care that cannot be
  // placed in time cannot be shown to be still owed.
  if (!date) return fact("AMBIGUOUS", "The statement carries no reliable date, so it cannot be shown to describe care still owed.");

  const doi = input.dateOfInjury ? input.dateOfInjury.toISOString().slice(0, 10) : null;
  if (doi && date < doi) return fact("PRE_INJURY", `Dated ${date}, before the date of injury (${doi}).`);

  if (kind === "OBSERVATION") {
    if (RESOLUTION_RE.test(text)) return fact("CONTRADICTED", "The statement records that the deficit or regimen has resolved.");
    if (COMPLETED_RE.test(text) && !CURRENT_RE.test(text)) return fact("COMPLETED", "Describes care already delivered rather than the patient's present state.");
    // A documented observation describes the patient as of its date; it needs
    // no verb of intent to be current.
    return fact("CURRENT", `Documented on ${date}.`);
  }

  if (COMPLETED_RE.test(text) && !PLANNED_RE.test(text)) {
    return fact("COMPLETED", "Describes care already delivered; a completed procedure is not evidence of a future one.");
  }
  if (PLANNED_RE.test(text)) return fact("PLANNED", `Recommended or ordered on ${date} and not withdrawn in later records.`);
  if (CURRENT_RE.test(text)) return fact("CURRENT", `Documented as ongoing on ${date}.`);
  return fact("AMBIGUOUS", "The statement mentions this care without recommending, ordering, or continuing it.");
}

export interface Resolved<T> {
  item: T;
  temporal: TemporalFact;
}

/**
 * Resolve a whole set together, so LATER records can override earlier ones on
 * the same subject. This is where a recommendation that a subsequent note
 * withdrew, or a deficit a subsequent note recorded as resolved, stops
 * supporting a projection — the single most common way a stale statement
 * survives into a plan.
 */
export function resolveTimeline<T extends { text: string; date: string | null }>(
  items: T[],
  opts: { dateOfInjury?: Date | null; kind: StatementKind },
): Resolved<T>[] {
  const resolved: Resolved<T>[] = items.map((item) => ({
    item,
    temporal: resolveTemporal({ text: item.text, date: item.date, dateOfInjury: opts.dateOfInjury, kind: opts.kind }),
  }));

  for (let i = 0; i < resolved.length; i++) {
    const cur = resolved[i];
    if (!cur.temporal.supportsFutureCare || !cur.item.date) continue;
    const key = subjectKey(cur.item.text);
    if (!key) continue;

    for (let j = 0; j < resolved.length; j++) {
      if (i === j) continue;
      const other = resolved[j];
      if (!other.item.date || other.item.date <= cur.item.date) continue; // only LATER records govern
      if (subjectKey(other.item.text) !== key) continue;

      const s = other.temporal.status;
      if (s === "DECLINED" || s === "CANCELLED" || s === "CONTRADICTED") {
        cur.temporal = {
          status: "CONTRADICTED",
          reason: `A later record (${other.item.date}) on the same care states the opposite: ${other.temporal.reason.toLowerCase()}`,
          supportsFutureCare: false,
        };
        break;
      }
      if (s === "COMPLETED") {
        cur.temporal = {
          status: "SUPERSEDED",
          reason: `This care was delivered on or before ${other.item.date}; it is no longer owed.`,
          supportsFutureCare: false,
        };
        break;
      }
      if (s === "PLANNED" || s === "CURRENT") {
        // The most recent statement of the same intent governs, so the same
        // recommendation repeated across ten notes counts once — and it is the
        // current one that is cited.
        cur.temporal = {
          status: "SUPERSEDED",
          reason: `A later record (${other.item.date}) states the same plan; that statement governs.`,
          supportsFutureCare: false,
        };
        break;
      }
    }
  }
  return resolved;
}

/** The subset that may support a future-care projection. */
export function supporting<T>(resolved: Resolved<T>[]): T[] {
  return resolved.filter((r) => r.temporal.supportsFutureCare).map((r) => r.item);
}
