// ─────────────────────────────────────────────────────────────────────────────
// Claim typing and the deterministic checks that keep clinically distinct
// statements distinct.
//
// A record review goes wrong in characteristic ways, and every one of them is
// a category error rather than a reading error:
//   • a consent form becomes evidence the procedure happened
//   • a recommendation becomes evidence the treatment was delivered
//   • "no complications" becomes a complication
//   • a left knee becomes a right knee
//   • a patient's report becomes a clinician's finding
//
// These are checked HERE, deterministically, against the cited excerpt — never
// left to the model's judgment, and never inferred from surrounding prose.
// ─────────────────────────────────────────────────────────────────────────────

export const CLAIM_TYPES = [
  "COMPLETED_TREATMENT", // performed / administered / underwent
  "PROCEDURE_PERFORMED",
  "RECOMMENDED_TREATMENT", // advised / should consider / candidate for
  "PLANNED_TREATMENT", // scheduled / will undergo
  "CONSENT_ONLY", // consent signed; NOT evidence of performance
  "PATIENT_REPORT", // the patient's own account
  "PROVIDER_OBSERVATION", // examined / on exam
  "IMAGING_FINDING",
  "LAB_FINDING",
  "DIAGNOSIS",
  "PROVIDER_OPINION", // impression / in my opinion / to a reasonable degree
  "FUNCTIONAL_STATUS",
  "WORK_STATUS",
  "MEDICATION",
  "DISPOSITION",
  "NEGATIVE_FINDING", // explicitly absent: "no fracture", "denies numbness"
  "CONTRADICTION",
  "ADMINISTRATIVE", // billing/consent/records-request material
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** Claim types that assert care was actually delivered. */
export const COMPLETED_TYPES = new Set<string>(["COMPLETED_TREATMENT", "PROCEDURE_PERFORMED"]);

/** Claim types that assert care was contemplated but NOT delivered. */
export const NOT_DELIVERED_TYPES = new Set<string>(["RECOMMENDED_TREATMENT", "PLANNED_TREATMENT", "CONSENT_ONLY"]);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

// ── Completed vs. contemplated ──────────────────────────────────────────────

/** Language that establishes care was actually delivered. */
const COMPLETED_RE =
  /\b(?:was |were |has been |have been )?(?:performed|completed|administered|injected|underwent|undergone|carried out|placed|excised|resected|repaired|removed|applied|delivered|received|took place|tolerated the procedure)\b/i;

/** Language that establishes care was only contemplated. */
const RECOMMENDED_RE =
  /\b(?:recommend(?:ed|s|ation)?|advis(?:ed|e)|suggest(?:ed|s)?|candidate for|consider(?:ed|ing)?|offered|discussed(?: the)? option|plan(?:ned|s)? (?:to|for)|scheduled for|will (?:undergo|proceed|be scheduled)|referred for|await(?:ing)?|pending)\b/i;

/** Consent-form language. Signing a consent is not having the procedure. */
const CONSENT_RE =
  /\b(?:consent(?:ed|s)? (?:to|for)|informed consent|i authorize|authoriz(?:e|ed) (?:dr|doctor|the surgeon)|risks(?:,| and) benefits (?:were )?(?:discussed|explained)|permission (?:to|for))\b/i;

export interface ClaimTypeCheck {
  ok: boolean;
  reason?: string;
  /** The type the excerpt actually supports, when it differs from the claim. */
  suggestedType?: ClaimType;
}

/**
 * Does the cited excerpt support a claim that care was DELIVERED?
 * A completed-care claim whose excerpt only shows a recommendation or a
 * consent is the single most consequential error in record review: it converts
 * contemplated care into treatment history, and from there into a damages
 * figure.
 */
export function checkCompletedClaim(claimType: string, value: string, excerpt: string): ClaimTypeCheck {
  if (!COMPLETED_TYPES.has(claimType)) return { ok: true };

  // Consent language with no independent evidence of performance.
  if (CONSENT_RE.test(excerpt) && !COMPLETED_RE.test(excerpt)) {
    return {
      ok: false,
      reason: "cited excerpt is a consent/authorization, which does not establish the procedure was performed",
      suggestedType: "CONSENT_ONLY",
    };
  }
  // Recommendation language with no independent evidence of performance.
  if (RECOMMENDED_RE.test(excerpt) && !COMPLETED_RE.test(excerpt)) {
    return {
      ok: false,
      reason: "cited excerpt records recommended or planned care, not care that was delivered",
      suggestedType: "RECOMMENDED_TREATMENT",
    };
  }
  // The performance language must be in the EXCERPT. A claim asserting
  // "underwent surgery" cannot support itself — that is the whole failure mode
  // this check exists to stop.
  if (!COMPLETED_RE.test(excerpt)) {
    return { ok: false, reason: "cited excerpt does not state that the treatment or procedure was performed" };
  }
  return { ok: true };
}

// ── Negation ────────────────────────────────────────────────────────────────

const NEGATORS = ["no", "not", "non", "without", "denies", "denied", "negative for", "free of", "absent", "ruled out", "unremarkable for"];

/** Is `term` negated in `text` (within a short window before it)? */
export function isNegated(text: string, term: string): boolean {
  const t = norm(text);
  const target = norm(term);
  if (!target) return false;
  let from = 0;
  for (;;) {
    const i = t.indexOf(target, from);
    if (i === -1) return false;
    const before = t.slice(Math.max(0, i - 40), i);
    if (NEGATORS.some((n) => new RegExp(`\\b${n}\\b(?:\\s+\\w+){0,3}\\s*$`).test(before))) return true;
    from = i + target.length;
  }
}

/**
 * A claim must not assert a finding the cited excerpt negates. "No acute
 * fracture" is a NEGATIVE_FINDING; recording it as a fracture inverts the
 * record's meaning.
 */
export function checkNegationConsistency(claimType: string, value: string, excerpt: string): ClaimTypeCheck {
  if (claimType === "NEGATIVE_FINDING") return { ok: true };
  // Test every significant term the claim asserts. Which word carries the
  // clinical meaning cannot be known positionally — "acute fracture of the
  // left hip" ends in the anatomy, not the finding — so any term the excerpt
  // negates while the claim states it plainly is an inversion.
  const terms = [...new Set(norm(value).split(" ").filter((w) => w.length > 3 && !STOPWORDS.has(w)))];
  for (const term of terms) {
    if (isNegated(excerpt, term) && !isNegated(value, term)) {
      return {
        ok: false,
        reason: `cited excerpt negates "${term}"; recording it as present inverts the record`,
        suggestedType: "NEGATIVE_FINDING",
      };
    }
  }
  return { ok: true };
}

/** Words too generic to carry a negated clinical meaning. */
const STOPWORDS = new Set([
  "with", "without", "left", "right", "bilateral", "acute", "chronic", "mild", "moderate", "severe",
  "patient", "reports", "noted", "seen", "there", "this", "that", "were", "have", "been", "from", "into",
]);

// ── Anatomy and laterality ──────────────────────────────────────────────────

const LATERALITY_RE = /\b(left|right|bilateral)\b/gi;

const ANATOMY_TERMS = [
  "knee", "hip", "shoulder", "elbow", "wrist", "hand", "ankle", "foot", "cervical", "thoracic",
  "lumbar", "lumbosacral", "spine", "back", "neck", "head", "brain", "femur", "tibia", "humerus",
  "radius", "ulna", "clavicle", "pelvis", "rib", "meniscus", "rotator cuff", "acl", "mcl",
];

function termsIn(text: string, terms: string[]): Set<string> {
  const t = norm(text);
  const found = new Set<string>();
  for (const term of terms) if (new RegExp(`\\b${term}\\b`).test(t)) found.add(term);
  return found;
}

/**
 * Laterality and anatomy stated in a claim must be present in its excerpt. A
 * left-knee finding recorded as the right knee is not a wording problem — it
 * is a different injury, and downstream it becomes a different surgery.
 */
export function checkAnatomyConsistency(value: string, excerpt: string, pageText?: string): ClaimTypeCheck {
  // Anatomy and laterality are frequently stated in a study header ("MRI RIGHT
  // KNEE") while the finding itself sits in the impression below it. So the
  // support is sought in the SERVER-HELD page, not only in the snippet the
  // model chose — the same principle that governs page attribution. What is
  // never tolerated is CONTRADICTION: a side the source states differently.
  const context = `${excerpt}\n${pageText ?? ""}`;
  const claimSides = new Set((value.match(LATERALITY_RE) ?? []).map((s) => s.toLowerCase()));
  const contextSides = new Set((context.match(LATERALITY_RE) ?? []).map((s) => s.toLowerCase()));
  for (const side of claimSides) {
    if (contextSides.has(side)) continue;
    const opposite = side === "left" ? "right" : side === "right" ? "left" : null;
    if (opposite && contextSides.has(opposite)) {
      return { ok: false, reason: `claim states "${side}" but the source states "${opposite}"` };
    }
    return { ok: false, reason: `claim states "${side}" laterality the source does not support` };
  }
  const claimParts = termsIn(value, ANATOMY_TERMS);
  const contextParts = termsIn(context, ANATOMY_TERMS);
  for (const part of claimParts) {
    if (!contextParts.has(part)) {
      return { ok: false, reason: `claim names anatomy "${part}" absent from the cited source` };
    }
  }
  return { ok: true };
}

// ── Copied-forward detection ────────────────────────────────────────────────

/**
 * Clinical notes routinely carry history forward verbatim from a prior visit.
 * Such text is real, but it is not evidence that the finding was observed
 * again today — so it is flagged rather than silently treated as current.
 */
export function looksCopiedForward(excerpt: string, priorExcerpts: string[]): boolean {
  const e = norm(excerpt);
  if (e.length < 40) return false;
  return priorExcerpts.some((p) => {
    const n = norm(p);
    return n.length >= 40 && (n.includes(e) || e.includes(n));
  });
}

/** Certainty language that a cited excerpt must itself contain. */
export const CERTAINTY_RE = /\b(?:definitely|certainly|clearly|unequivocally|confirms?|proves?|establishes?|without question)\b/i;

/** Hedging in the source that a claim must not discard. */
export const HEDGE_RE = /\b(?:possible|possibly|probable|probably|suspect(?:ed)?|likely|may|might|could|appears?|suggestive of|cannot be excluded|questionable|equivocal)\b/i;

/**
 * A claim must not convert the record's uncertainty into certainty. If the
 * excerpt hedges ("possible meniscal tear") the claim may not assert the
 * finding flatly, and it may never add certainty language of its own.
 */
export function checkCertainty(value: string, excerpt: string): ClaimTypeCheck {
  if (CERTAINTY_RE.test(value) && !CERTAINTY_RE.test(excerpt)) {
    return { ok: false, reason: "claim asserts certainty the cited excerpt does not express" };
  }
  if (HEDGE_RE.test(excerpt) && !HEDGE_RE.test(value)) {
    return { ok: false, reason: "cited excerpt hedges this finding; the claim states it as established" };
  }
  return { ok: true };
}
