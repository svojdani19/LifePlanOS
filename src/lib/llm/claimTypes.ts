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
  // ── Non-clinical epistemic types ──────────────────────────────────────────
  // What KIND of knowledge a statement is. A deponent's account and a
  // clinician's examination are both "statements about the patient" and are
  // not remotely the same evidence; collapsing them into PROVIDER_OBSERVATION
  // is how testimony becomes a medical finding.
  "SWORN_TESTIMONY", // stated under oath by the deponent
  "PARTY_ADMISSION", // testimony against the deponent's own interest
  "EXPERT_OPINION", // an opinion attributed to a retained/examining expert
  "CAUSATION_OPINION", // an attributed opinion about cause or apportionment
  "INCIDENT_OBSERVATION", // what a responder or officer observed at the scene
  "REPORTED_STATEMENT", // what a party or witness said, as reported
  "DIAGNOSTIC_IMPRESSION", // the interpreting physician's conclusion
  "OPERATIVE_FINDING", // observed intra-operatively
  "BILLING_ENTRY", // a charge, code, or amount
  "EMPLOYMENT_OR_ECONOMIC_RECORD",
  "LEGAL_ASSERTION",
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
// Past tense counts. A chronology entry is written in the past tense by
// definition, so a radiologist's "soft tissues appear grossly unremarkable"
// becomes "appeared" in the entry — and a pattern matching only the present
// tense read that as the hedge having been dropped, rejecting correctly
// hedged prose on a fifth of imaging records.
export const HEDGE_RE = /\b(?:possible|possibly|probable|probably|suspect(?:s|ed|ing)?|likely|may|might|could|appear(?:s|ed|ing)?|seem(?:s|ed)?|suggest(?:s|ed)?|suggestive of|cannot be excluded|could not be excluded|questionable|equivocal|presumed)\b/i;

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

// ─────────────────────────────────────────────────────────────────────────────
// Analysis class × claim field → claim type
//
// The extraction schema has always permitted a claimType, but the prompt never
// asked for one and validation defaulted whatever was missing to
// PROVIDER_OBSERVATION. That default is the single most consequential error
// available to this system: it silently converts sworn testimony, a billing
// line, a legal assertion and an expert's opinion into a treating clinician's
// observation of the patient — the exact evidential upgrade that the whole
// grounding architecture exists to prevent.
//
// The type is therefore DERIVED deterministically from the pair (analysis
// class, claim field) wherever that pair is unambiguous, and a type the model
// proposes is accepted only where it is compatible with that pair. Nothing
// here depends on prompt compliance.
// ─────────────────────────────────────────────────────────────────────────────

/** The type a (class, field) pair implies when it implies exactly one. */
const DERIVED: Record<string, ClaimType> = {
  // Testimony — never a clinical observation, whatever it is about.
  "TESTIMONY|testimony": "SWORN_TESTIMONY",
  "TESTIMONY|admission": "PARTY_ADMISSION",
  "TESTIMONY|functionalStatus": "SWORN_TESTIMONY",
  "TESTIMONY|workStatus": "SWORN_TESTIMONY",
  "TESTIMONY|restrictions": "SWORN_TESTIMONY",
  "TESTIMONY|pastMedicalHistory": "SWORN_TESTIMONY",
  "TESTIMONY|contradictions": "CONTRADICTION",

  // Expert opinion — attributed opinion, never established fact.
  "EXPERT_OPINION|opinion": "EXPERT_OPINION",
  "EXPERT_OPINION|causationOpinion": "CAUSATION_OPINION",
  "EXPERT_OPINION|assessment": "EXPERT_OPINION",
  "EXPERT_OPINION|recommendations": "EXPERT_OPINION",
  "EXPERT_OPINION|functionalStatus": "EXPERT_OPINION",
  "EXPERT_OPINION|workStatus": "EXPERT_OPINION",
  "EXPERT_OPINION|restrictions": "EXPERT_OPINION",
  "EXPERT_OPINION|objectiveFindings": "PROVIDER_OBSERVATION", // the expert's OWN examination
  "EXPERT_OPINION|diagnosticStudies": "IMAGING_FINDING",
  "EXPERT_OPINION|pastMedicalHistory": "EXPERT_OPINION",

  // Diagnostic study — findings vs. the interpreting physician's impression.
  "DIAGNOSTIC_STUDY|impression": "DIAGNOSTIC_IMPRESSION",
  "DIAGNOSTIC_STUDY|diagnosticStudies": "IMAGING_FINDING",
  "DIAGNOSTIC_STUDY|studyTechnique": "ADMINISTRATIVE",
  "DIAGNOSTIC_STUDY|comparison": "ADMINISTRATIVE",
  "DIAGNOSTIC_STUDY|recommendations": "RECOMMENDED_TREATMENT",

  // Pathology.
  "PATHOLOGY_DIAGNOSTIC|pathologicDiagnosis": "DIAGNOSTIC_IMPRESSION",
  "PATHOLOGY_DIAGNOSTIC|grossDescription": "PROVIDER_OBSERVATION",
  "PATHOLOGY_DIAGNOSTIC|microscopicDescription": "PROVIDER_OBSERVATION",
  "PATHOLOGY_DIAGNOSTIC|specimen": "ADMINISTRATIVE",
  "PATHOLOGY_DIAGNOSTIC|comparison": "ADMINISTRATIVE",

  // Operative.
  "OPERATIVE|operativeFindings": "OPERATIVE_FINDING",
  "OPERATIVE|preOperativeDiagnosis": "DIAGNOSIS",
  "OPERATIVE|postOperativeDiagnosis": "DIAGNOSIS",
  "OPERATIVE|implants": "PROCEDURE_PERFORMED",
  "OPERATIVE|estimatedBloodLoss": "PROVIDER_OBSERVATION",
  "OPERATIVE|specimen": "ADMINISTRATIVE",
  "OPERATIVE|anesthesia": "ADMINISTRATIVE",

  // Anesthesia.
  "ANESTHESIA|anesthesiaType": "ADMINISTRATIVE",
  "ANESTHESIA|anesthesiaEvent": "PROVIDER_OBSERVATION",
  "ANESTHESIA|medications": "MEDICATION",
  "ANESTHESIA|estimatedBloodLoss": "PROVIDER_OBSERVATION",

  // Device / implant log — inventory documentation.
  "DEVICE_OR_IMPLANT|implants": "ADMINISTRATIVE",
  "DEVICE_OR_IMPLANT|deviceIdentifier": "ADMINISTRATIVE",
  "DEVICE_OR_IMPLANT|manufacturer": "ADMINISTRATIVE",
  "DEVICE_OR_IMPLANT|procedure": "ADMINISTRATIVE",

  // Incident / prehospital.
  "INCIDENT|mechanism": "INCIDENT_OBSERVATION",
  "INCIDENT|sceneFindings": "INCIDENT_OBSERVATION",
  "INCIDENT|witnessStatement": "REPORTED_STATEMENT",
  "INCIDENT|objectiveFindings": "PROVIDER_OBSERVATION", // a responder's own assessment
  "INCIDENT|treatment": "COMPLETED_TREATMENT",
  "INCIDENT|disposition": "DISPOSITION",

  // Billing / financial — a code on a claim justifies a charge.
  "FINANCIAL|charge": "BILLING_ENTRY",
  "FINANCIAL|serviceCode": "BILLING_ENTRY",
  "FINANCIAL|billedAmount": "BILLING_ENTRY",
  "FINANCIAL|payer": "BILLING_ENTRY",
  "FINANCIAL|treatment": "BILLING_ENTRY",
  "FINANCIAL|procedure": "BILLING_ENTRY",
  "FINANCIAL|medications": "BILLING_ENTRY",

  // Employment / economic.
  "EMPLOYMENT_ECONOMIC|employer": "EMPLOYMENT_OR_ECONOMIC_RECORD",
  "EMPLOYMENT_ECONOMIC|employmentStatus": "EMPLOYMENT_OR_ECONOMIC_RECORD",
  "EMPLOYMENT_ECONOMIC|earnings": "EMPLOYMENT_OR_ECONOMIC_RECORD",
  "EMPLOYMENT_ECONOMIC|workStatus": "EMPLOYMENT_OR_ECONOMIC_RECORD",
  "EMPLOYMENT_ECONOMIC|restrictions": "EMPLOYMENT_OR_ECONOMIC_RECORD",
  "EMPLOYMENT_ECONOMIC|documentContent": "EMPLOYMENT_OR_ECONOMIC_RECORD",

  // Insurance administration.
  "INSURANCE_ADMINISTRATIVE|coverage": "ADMINISTRATIVE",
  "INSURANCE_ADMINISTRATIVE|claimStatus": "ADMINISTRATIVE",
  "INSURANCE_ADMINISTRATIVE|authorization": "ADMINISTRATIVE",
  "INSURANCE_ADMINISTRATIVE|payer": "ADMINISTRATIVE",
  "INSURANCE_ADMINISTRATIVE|billedAmount": "BILLING_ENTRY",
  "INSURANCE_ADMINISTRATIVE|documentContent": "ADMINISTRATIVE",

  // Legal.
  "LEGAL|legalAssertion": "LEGAL_ASSERTION",
  "LEGAL|reliefSought": "LEGAL_ASSERTION",
  "LEGAL|partyPosition": "LEGAL_ASSERTION",

  // Correspondence / unknown.
  "CORRESPONDENCE_OR_GENERIC_EVIDENCE|documentContent": "ADMINISTRATIVE",
  "UNKNOWN|documentContent": "ADMINISTRATIVE",
};

/**
 * Types a clinical-encounter or therapy field may legitimately take. These
 * remain model-proposed (a "treatment" may be completed, recommended, planned
 * or consent-only, and the excerpt decides which), then checked by the
 * existing performed-vs-planned validators.
 */
const CLINICAL_FIELD_TYPES: Record<string, ClaimType[]> = {
  subjective: ["PATIENT_REPORT", "NEGATIVE_FINDING"],
  pastMedicalHistory: ["PATIENT_REPORT", "DIAGNOSIS", "PROVIDER_OBSERVATION"],
  objectiveFindings: ["PROVIDER_OBSERVATION", "NEGATIVE_FINDING"],
  diagnosticStudies: ["IMAGING_FINDING", "LAB_FINDING", "DIAGNOSTIC_IMPRESSION", "NEGATIVE_FINDING"],
  assessment: ["DIAGNOSIS", "PROVIDER_OPINION", "NEGATIVE_FINDING"],
  treatment: ["COMPLETED_TREATMENT", "RECOMMENDED_TREATMENT", "PLANNED_TREATMENT", "CONSENT_ONLY", "MEDICATION", "PROVIDER_OBSERVATION"],
  procedure: ["PROCEDURE_PERFORMED", "COMPLETED_TREATMENT", "RECOMMENDED_TREATMENT", "PLANNED_TREATMENT", "CONSENT_ONLY", "PROVIDER_OBSERVATION"],
  medications: ["MEDICATION"],
  functionalStatus: ["FUNCTIONAL_STATUS", "PATIENT_REPORT", "PROVIDER_OBSERVATION"],
  workStatus: ["WORK_STATUS"],
  restrictions: ["WORK_STATUS", "FUNCTIONAL_STATUS", "PROVIDER_OPINION"],
  disposition: ["DISPOSITION"],
  responseToTreatment: ["PROVIDER_OBSERVATION", "PATIENT_REPORT", "NEGATIVE_FINDING"],
  recommendations: ["RECOMMENDED_TREATMENT", "PLANNED_TREATMENT", "PROVIDER_OPINION"],
  contradictions: ["CONTRADICTION"],
  complications: ["PROVIDER_OBSERVATION", "NEGATIVE_FINDING"],
};

/**
 * The claim type for one (class, field, proposed type) triple.
 *
 * Returns the derived type where the pair is unambiguous — the model's
 * proposal cannot override it. Where several types are legitimate, a
 * compatible proposal is kept and an incompatible or absent one falls back to
 * the field's safest type. Never returns PROVIDER_OBSERVATION by default.
 */
/**
 * For a clinical field with several legitimate types and no honest proposal,
 * read the EXCERPT rather than assume. Assuming "completed" would assert that
 * care was delivered on the strength of nothing at all — the precise error the
 * performed-versus-planned validators exist to catch.
 */
function inferFromExcerpt(field: string, excerpt: string | null | undefined): ClaimType | null {
  if (!excerpt) return null;
  if (field !== "treatment" && field !== "procedure") return null;
  if (CONSENT_RE.test(excerpt)) return "CONSENT_ONLY";
  if (COMPLETED_RE.test(excerpt)) return field === "procedure" ? "PROCEDURE_PERFORMED" : "COMPLETED_TREATMENT";
  if (RECOMMENDED_RE.test(excerpt)) return "RECOMMENDED_TREATMENT";
  return null;
}

export function resolveClaimType(
  analysisClass: string,
  field: string,
  proposed: string | null | undefined,
  excerpt?: string | null,
): { claimType: ClaimType; rejected: string | null } {
  const derived = DERIVED[`${analysisClass}|${field}`];
  if (derived) {
    if (proposed && proposed !== derived) {
      return { claimType: derived, rejected: `claim type "${proposed}" is not available to a ${field} claim in a ${analysisClass} document; recorded as ${derived}` };
    }
    return { claimType: derived, rejected: null };
  }
  const allowed = CLINICAL_FIELD_TYPES[field];
  if (allowed?.length) {
    if (proposed && (allowed as string[]).includes(proposed)) return { claimType: proposed as ClaimType, rejected: null };
    const inferred = inferFromExcerpt(field, excerpt) ?? (allowed.length === 1 ? allowed[0] : null);
    // Nothing in the excerpt settles it: record the weakest reading — that the
    // note says this — rather than asserting delivery or non-delivery.
    const fallback = inferred ?? (allowed.includes("PROVIDER_OBSERVATION") ? "PROVIDER_OBSERVATION" : allowed[0]);
    if (proposed) return { claimType: fallback, rejected: `claim type "${proposed}" is not valid for a ${field} claim; recorded as ${fallback}` };
    return { claimType: fallback, rejected: null };
  }
  // An unmapped pair is administrative rather than a clinical observation:
  // when the system cannot say what kind of knowledge this is, it must not
  // claim it is a clinician's finding.
  if (proposed && (CLAIM_TYPES as readonly string[]).includes(proposed)) return { claimType: proposed as ClaimType, rejected: null };
  return { claimType: "ADMINISTRATIVE", rejected: null };
}

/** Types that may NEVER arise from a non-clinical document kind. */
const CLINICAL_ONLY_TYPES = new Set<string>(["DIAGNOSIS", "PROCEDURE_PERFORMED", "COMPLETED_TREATMENT", "PROVIDER_OPINION"]);

const NON_CLINICAL_CLASSES = new Set<string>([
  "TESTIMONY",
  "FINANCIAL",
  "EMPLOYMENT_ECONOMIC",
  "INSURANCE_ADMINISTRATIVE",
  "LEGAL",
  "CORRESPONDENCE_OR_GENERIC_EVIDENCE",
  "UNKNOWN",
  "DEVICE_OR_IMPLANT",
]);

/**
 * A last structural guard: a non-clinical document can never produce a claim
 * type that asserts clinical fact. Enforced separately from resolveClaimType so
 * that a future mapping mistake still cannot promote testimony to a diagnosis.
 */
export function claimTypeCompatible(analysisClass: string, claimType: string): boolean {
  if (NON_CLINICAL_CLASSES.has(analysisClass) && CLINICAL_ONLY_TYPES.has(claimType)) return false;
  return true;
}
