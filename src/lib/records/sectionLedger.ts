// ─────────────────────────────────────────────────────────────────────────────
// The section ledger: what a record of this kind documents, and whether we
// actually captured it.
//
// Every quality question this program had been answering by hand — "did we miss
// anything?" — was answered by diffing our output against a professionally
// published Life Care Plan. That works on the five reference cases and is
// useless on the sixth, because a real case arrives with records and no plan.
//
// So the ledger compares the extracted claims against THE SOURCE DOCUMENT, not
// against a gold answer. A clinic note that prints "Assessment:" on the page
// and yields no assessment claim is a miss we can detect with nothing but the
// upload. That is the whole design: self-referential, not comparative.
//
// Each section of an entry resolves to exactly one of three states:
//
//   PRESENT            — claims were captured for it.
//   ABSENT_FROM_SOURCE — the record does not document this section. Not a
//                        defect: an emergency note has no operative findings.
//   RECOVERABLE_MISS   — the section's heading IS on the page and we captured
//                        nothing from it. This is the state that matters. It is
//                        the only one that can be repaired, and it drives the
//                        targeted second extraction pass.
//
// Measured against a real case file, this is not a rare condition. On one
// chiropractic visit the record printed "ROS: Musculoskeletal: (+) limitation
// of motion" and the planner published "Exam: Limitation of motion and
// stiffness/tightness were present" — and the program captured no exam claim at
// all, silently, while reporting the entry as complete.
//
// OPEN WORLD. The per-class contract below is derived from the label sets that
// qualified planners actually use, which means it is derived from one corpus in
// one specialty. A burn case or a birth injury will contain headings this file
// has never seen. So the contract sets the FLOOR and the document sets the
// ceiling: headings discovered in the source that no contracted section claims
// are tracked as discovered sections, and a discovered heading with no claims
// behind it is a miss like any other. The ledger must not report "complete" on
// a document whose structure it does not recognise.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnalysisClass } from "@/lib/documents/analysisClass";
import type { ClaimField } from "@/lib/llm/recordExtraction";

export type SectionState = "PRESENT" | "ABSENT_FROM_SOURCE" | "RECOVERABLE_MISS";

/**
 * What a section IS, independent of what its document kind calls it.
 *
 * A radiologist writes "Impression", a clinician writes "Assessment", a
 * pathologist writes "Final diagnosis" — one concept, three names, and a
 * program that keys only on the name cannot tell that a study's conclusion and
 * a visit's conclusion play the same role. That mattered the moment we tried to
 * compare our output to a published plan across document kinds, and it matters
 * again for rendering, where the writer has to know which clause carries the
 * bottom line whatever the record calls it.
 */
export type SectionConcept =
  | "history"      // what the patient reported
  | "findings"     // what was observed or measured
  | "conclusion"   // what it was judged to be
  | "plan"         // what was decided or delivered
  | "procedure"    // what was performed
  | "medications"
  | "function"     // capacity, restrictions, work status
  | "technique"    // how a study was performed
  | "attribution"  // who said it, in testimony and opinion
  | "money"
  | "other";

export interface SectionSpec {
  /** Stable key, used by the repair pass and by rendering. */
  key: string;
  /** What this section is, across document kinds. */
  concept: SectionConcept;
  /** What the section is called when shown to a reviewer. */
  label: string;
  /** Claim fields that satisfy this section. Any one of them counts. */
  fields: readonly ClaimField[];
  /**
   * How the section announces itself in a source document. Deliberately
   * permissive about punctuation and case: these are OCR'd scans, and the same
   * section is "ASSESSMENT:", "Assessment/Plan -", or "A/P:" across three
   * facilities in the same case file.
   */
  header: RegExp;
}

export interface SectionVerdict {
  key: string;
  concept: SectionConcept;
  label: string;
  state: SectionState;
  /** Fields that satisfied it, when PRESENT. */
  satisfiedBy: string[];
  /** The heading as it appeared in the source, when we found one. */
  headingText: string | null;
  /** True when the section came from the document rather than the contract. */
  discovered: boolean;
}

export interface LedgerVerdict {
  klass: AnalysisClass;
  sections: SectionVerdict[];
  /** Sections whose heading is on the page and which yielded nothing. */
  recoverable: SectionVerdict[];
  /**
   * Of the sections this record actually documents, the share we captured.
   * Sections absent from the source are excluded — a note cannot be faulted
   * for lacking a section it never had.
   */
  completeness: number;
}

// ── Section vocabulary ───────────────────────────────────────────────────────
//
// Headers are matched at a line start (or after a bullet) so that a section
// name mentioned mid-sentence — "the assessment was unchanged" — is not read as
// a heading. `\b` after the alternation keeps "Plan" from matching "Planned".

const H = (body: string) => new RegExp(String.raw`(?:^|\n)\s*(?:[•*\-]\s*)?(${body})\s*[:\-–—]`, "i");

const SUBJECTIVE: SectionSpec = {
  key: "subjective",
  concept: "history",
  label: "Subjective",
  fields: ["subjective", "pastMedicalHistory"],
  header: H(String.raw`subjective|history of present illness|hpi|chief complaint|cc|presenting complaint|interval history|patient reports?`),
};

const EXAM: SectionSpec = {
  key: "exam",
  concept: "findings",
  label: "Exam",
  fields: ["objectiveFindings"],
  // A review of systems is where the great majority of missed exam content
  // lives: it is printed as "(+) limitation of motion" checkbox notation and
  // reads to a language model like form furniture rather than a finding.
  header: H(String.raw`objective|physical exam(?:ination)?|exam|examination|review of systems|ros|musculoskeletal|neurologic(?:al)?\s*exam|inspection|palpation|range of motion|rom`),
};

const ASSESSMENT: SectionSpec = {
  key: "assessment",
  concept: "conclusion",
  label: "Assessment",
  fields: ["assessment"],
  header: H(String.raw`assessment|impression|diagnos[ei]s|diagnoses|clinical impression|a\/p|assessment\s*(?:and|&|\/)\s*plan`),
};

const PLAN: SectionSpec = {
  key: "plan",
  concept: "plan",
  label: "Plan",
  fields: ["treatment", "recommendations", "disposition", "procedure"],
  header: H(String.raw`plan|treatment plan|treatment|recommendations?|disposition|follow[\s-]?up|instructions|home care`),
};

const MEDICATIONS: SectionSpec = {
  key: "medications",
  concept: "medications",
  label: "Medications",
  fields: ["medications"],
  header: H(String.raw`medications?|medication used|meds|current medications?|drugs? (?:given|administered|used)|prescriptions?`),
};

const FUNCTIONAL: SectionSpec = {
  key: "functional",
  concept: "function",
  label: "Functional status",
  fields: ["functionalStatus", "restrictions", "workStatus"],
  header: H(String.raw`functional status|activities of daily living|adls?|work status|restrictions?|limitations?|return to work`),
};

const RESPONSE: SectionSpec = {
  key: "response",
  concept: "findings",
  label: "Response to treatment",
  fields: ["responseToTreatment"],
  header: H(String.raw`response to (?:treatment|therapy)|patient response|tolerance|progress|interval change`),
};

const STUDIES_ORDERED: SectionSpec = {
  key: "studies",
  concept: "findings",
  label: "Diagnostic studies",
  fields: ["diagnosticStudies"],
  header: H(String.raw`diagnostic studies|imaging|studies (?:ordered|performed)|labs?|laboratory|radiolog(?:y|ic)`),
};

// Operative
const PROCEDURE: SectionSpec = {
  key: "procedure",
  concept: "procedure",
  label: "Procedure performed",
  fields: ["procedure"],
  header: H(String.raw`procedure(?: performed| done)?|operation(?: performed)?|surgery|name of procedure|title of procedure`),
};
const PREOP_DX: SectionSpec = {
  key: "preopDx",
  concept: "conclusion",
  label: "Preoperative diagnosis",
  fields: ["preOperativeDiagnosis"],
  header: H(String.raw`pre[\s-]?operative diagnos[ei]s|preop(?:erative)? dx|pre[\s-]?op diagnosis|(?:pre|post)[\s-]?operative diagnos[ei]s`),
};
const POSTOP_DX: SectionSpec = {
  key: "postopDx",
  concept: "conclusion",
  label: "Postoperative diagnosis",
  fields: ["postOperativeDiagnosis"],
  header: H(String.raw`post[\s-]?operative diagnos[ei]s|postop(?:erative)? dx|post[\s-]?op diagnosis`),
};
const OP_FINDINGS: SectionSpec = {
  key: "operativeFindings",
  concept: "findings",
  label: "Operative findings",
  fields: ["operativeFindings"],
  header: H(String.raw`(?:operative|intra[\s-]?operative|surgical) findings|findings at surgery|description of procedure`),
};
const ANESTHESIA_SEC: SectionSpec = {
  key: "anesthesia",
  concept: "medications",
  label: "Anesthesia",
  fields: ["anesthesia", "anesthesiaType", "anesthesiaEvent"],
  header: H(String.raw`anesthesia(?: type)?|type of anesthesia|anesthetic`),
};
const EBL: SectionSpec = {
  key: "ebl",
  concept: "findings",
  label: "Estimated blood loss",
  fields: ["estimatedBloodLoss"],
  header: H(String.raw`estimated blood loss|ebl|blood loss`),
};
const SPECIMEN: SectionSpec = {
  key: "specimen",
  concept: "findings",
  label: "Specimen",
  fields: ["specimen"],
  header: H(String.raw`specimens?(?: removed)?|tissue removed|pathology specimen`),
};
const COMPLICATIONS: SectionSpec = {
  key: "complications",
  concept: "findings",
  label: "Complications",
  fields: ["complications"],
  header: H(String.raw`complications?|adverse events?`),
};
const IMPLANTS: SectionSpec = {
  key: "implants",
  concept: "procedure",
  label: "Implants",
  fields: ["implants", "deviceIdentifier", "manufacturer"],
  header: H(String.raw`implants?|hardware|instrumentation|devices?(?: used)?`),
};

// Diagnostic study
const TECHNIQUE: SectionSpec = {
  key: "technique",
  concept: "technique",
  label: "Technique",
  fields: ["studyTechnique"],
  header: H(String.raw`technique|protocol|procedure performed|exam(?:ination)? performed|sequences?`),
};
const COMPARISON: SectionSpec = {
  key: "comparison",
  concept: "technique",
  label: "Comparison",
  fields: ["comparison"],
  header: H(String.raw`comparison|prior (?:study|studies|exam)|previous (?:study|exam)`),
};
const FINDINGS: SectionSpec = {
  key: "findings",
  concept: "findings",
  label: "Findings",
  fields: ["diagnosticStudies", "objectiveFindings"],
  header: H(String.raw`findings|observations|results`),
};
const IMPRESSION: SectionSpec = {
  key: "impression",
  concept: "conclusion",
  label: "Impression",
  fields: ["impression", "assessment"],
  header: H(String.raw`impressions?|conclusions?|summary|interpretation`),
};

// Pathology
const GROSS: SectionSpec = {
  key: "gross",
  concept: "findings",
  label: "Gross description",
  fields: ["grossDescription"],
  header: H(String.raw`gross(?: description| examination)?|macroscopic`),
};
const MICRO: SectionSpec = {
  key: "microscopic",
  concept: "findings",
  label: "Microscopic description",
  fields: ["microscopicDescription"],
  header: H(String.raw`microscopic(?: description| examination)?|histolog(?:y|ic)`),
};
const PATH_DX: SectionSpec = {
  key: "pathologicDiagnosis",
  concept: "conclusion",
  label: "Pathologic diagnosis",
  fields: ["pathologicDiagnosis"],
  header: H(String.raw`(?:final |pathologic(?:al)? )?diagnos[ei]s|path diagnosis`),
};

// Incident
const MECHANISM: SectionSpec = {
  key: "mechanism",
  concept: "history",
  label: "Mechanism",
  fields: ["mechanism"],
  header: H(String.raw`mechanism(?: of injury)?|how (?:injury )?occurred|nature of (?:incident|accident)|description of (?:incident|accident)`),
};
const SCENE: SectionSpec = {
  key: "scene",
  concept: "findings",
  label: "Scene findings",
  fields: ["sceneFindings"],
  header: H(String.raw`scene(?: findings| description)?|on arrival|at the scene|conditions`),
};
const WITNESS: SectionSpec = {
  key: "witness",
  concept: "history",
  label: "Witness statement",
  fields: ["witnessStatement"],
  header: H(String.raw`witness(?:es)?(?: statements?)?|statements?|reported by`),
};

// Testimony / opinion
const TESTIMONY_SEC: SectionSpec = {
  key: "testimony",
  concept: "attribution",
  label: "Testimony",
  fields: ["testimony"],
  header: H(String.raw`testimony|examination by|direct examination|cross[\s-]?examination|q|question`),
};
const ADMISSION_SEC: SectionSpec = {
  key: "admission",
  concept: "attribution",
  label: "Admission",
  fields: ["admission"],
  header: H(String.raw`admission|concession|acknowledg(?:e|ment)`),
};
const OPINION_SEC: SectionSpec = {
  key: "opinion",
  concept: "conclusion",
  label: "Opinion",
  fields: ["opinion"],
  header: H(String.raw`opinions?|conclusions?|discussion|analysis`),
};
const CAUSATION_SEC: SectionSpec = {
  key: "causation",
  concept: "conclusion",
  label: "Causation opinion",
  fields: ["causationOpinion"],
  header: H(String.raw`causation|causal relationship|medical causation|relatedness`),
};

// Financial
const CHARGES: SectionSpec = {
  key: "charges",
  concept: "money",
  label: "Charges",
  fields: ["charge", "billedAmount", "serviceCode"],
  header: H(String.raw`charges?|billed(?: amount)?|amount billed|total(?: charges?)?|balance|cpt|service code|procedure code`),
};
const PAYER: SectionSpec = {
  key: "payer",
  concept: "money",
  label: "Payer",
  fields: ["payer", "coverage", "claimStatus"],
  header: H(String.raw`payer|insurance|carrier|coverage|claim status|adjustments?|payments?`),
};

/**
 * What each kind of record documents.
 *
 * These are the label sets professional Life Care Plans actually use — an
 * encounter reads Subjective / Exam / Assessment / Plan, a study reads
 * Findings / Impression, a procedure reads Procedure Performed / Pre- and
 * postoperative diagnosis / Medication used. The contract is the floor, not the
 * whole world: see `discoverSections`.
 */
export const SECTION_CONTRACT: Record<AnalysisClass, readonly SectionSpec[]> = {
  CLINICAL_ENCOUNTER: [SUBJECTIVE, EXAM, ASSESSMENT, PLAN, MEDICATIONS, STUDIES_ORDERED, FUNCTIONAL],
  THERAPY_COURSE: [SUBJECTIVE, EXAM, ASSESSMENT, PLAN, RESPONSE, FUNCTIONAL],
  OPERATIVE: [PROCEDURE, PREOP_DX, POSTOP_DX, OP_FINDINGS, ANESTHESIA_SEC, MEDICATIONS, EBL, SPECIMEN, COMPLICATIONS, IMPLANTS],
  ANESTHESIA: [ANESTHESIA_SEC, MEDICATIONS, COMPLICATIONS],
  PATHOLOGY_DIAGNOSTIC: [GROSS, MICRO, PATH_DX],
  DEVICE_OR_IMPLANT: [IMPLANTS, PROCEDURE],
  DIAGNOSTIC_STUDY: [TECHNIQUE, COMPARISON, FINDINGS, IMPRESSION],
  TESTIMONY: [TESTIMONY_SEC, ADMISSION_SEC],
  EXPERT_OPINION: [OPINION_SEC, CAUSATION_SEC],
  INCIDENT: [MECHANISM, SCENE, WITNESS],
  FINANCIAL: [CHARGES, PAYER],
  EMPLOYMENT_ECONOMIC: [
    { key: "employment",
  concept: "function", label: "Employment", fields: ["employer", "employmentStatus", "earnings"], header: H(String.raw`employ(?:er|ment)|wages?|earnings|salary|occupation|job title`) },
  ],
  INSURANCE_ADMINISTRATIVE: [PAYER],
  LEGAL: [
    { key: "assertion",
  concept: "attribution", label: "Assertion", fields: ["legalAssertion", "partyPosition"], header: H(String.raw`allegations?|counts?|cause of action|assertions?|position`) },
    { key: "relief",
  concept: "other", label: "Relief sought", fields: ["reliefSought"], header: H(String.raw`relief(?: sought| requested)?|prayer|damages|wherefore`) },
  ],
  CORRESPONDENCE_OR_GENERIC_EVIDENCE: [
    { key: "content",
  concept: "other", label: "Content", fields: ["documentContent"], header: H(String.raw`re|subject|regarding|body|message`) },
  ],
  // Neither carries a documented clinical structure to audit. A supporting file
  // is explicitly exempt, and UNKNOWN has not earned a contract to be measured
  // against — asserting one would manufacture misses out of unclassified paper.
  SUPPORTING_FILE: [],
  UNKNOWN: [],
};

// ── Locating the record's own text ───────────────────────────────────────────

/**
 * Where in the document this entry's text lives.
 *
 * Takes text already run through `prepareDocumentText`. That is deliberate: a
 * single case holds thousands of entries against documents of a million
 * characters, and normalizing the haystack per entry made the audit quadratic
 * in the size of the case. The caller prepares each document once.
 *
 * Page numbers cannot be trusted for this: a real 56-page packet came back with
 * every row recorded on "page 1". The claims themselves are the reliable
 * anchor, because each one carries a verbatim excerpt that the extractor
 * already verified against the document. So the span is bounded by the first
 * and last excerpt that can be located, and padded to take in the headings that
 * sit above the text a claim quoted.
 */
export function locateSpan(
  preparedText: string,
  excerpts: readonly string[],
  pad = 1_500,
): { start: number; end: number; text: string } | null {
  const hay = preparedText;
  let lo = Infinity;
  let hi = -Infinity;
  for (const raw of excerpts) {
    const needle = prepareDocumentText(raw);
    if (needle.length < 12) continue;
    const at = hay.indexOf(needle);
    if (at < 0) continue;
    lo = Math.min(lo, at);
    hi = Math.max(hi, at + needle.length);
  }
  if (!Number.isFinite(lo) || hi < 0) return null;
  const start = Math.max(0, lo - pad);
  const end = Math.min(hay.length, hi + pad);
  return { start, end, text: hay.slice(start, end) };
}

/**
 * Collapse whitespace so that a heading broken across an OCR line wrap still
 * matches, while keeping newlines — the header patterns anchor to line starts,
 * which is what stops "the assessment was unchanged" reading as a heading.
 *
 * Idempotent, and cheap to apply to a short excerpt. Apply it to a whole
 * document ONCE, via this function, and reuse the result across every entry
 * drawn from that document.
 */
export function prepareDocumentText(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ");
}

// ── Discovering sections the contract does not know ──────────────────────────

/**
 * Any `Word:` / `Two Words:` line-leading label in the span.
 *
 * This is what keeps the ledger honest outside the corpus it learned from. A
 * document whose headings we do not recognise must not be scored as complete;
 * its headings become sections in their own right.
 */
const CANDIDATE_HEADING = /(?:^|\n)\s*(?:[•*\-]\s*)?([A-Z][A-Za-z][A-Za-z /&'()-]{2,38}?)\s*:\s/g;

/** Headings that are record furniture, not clinical sections. */
const NOT_A_SECTION =
  /^(?:patient|name|dob|d\.o\.b|date|mrn|account|chart|visit|page|provider|physician|clinician|facility|location|address|phone|fax|email|npi|id|sex|gender|age|race|insurance id|guarantor|encounter|admit|discharge date|printed|signed|electronically signed|dictated|transcribed|cc|re|attn|from|to|subject|note|source|reference|confidential|disclaimer|copy|fig(?:ure)?|table)$/i;

export function discoverSections(spanText: string, contracted: readonly SectionSpec[]): SectionSpec[] {
  const known = new Set<string>();
  for (const spec of contracted) {
    // A heading the contract already matches is not a discovery.
    const m = spec.header.exec(spanText);
    if (m) known.add(normalizeHeading(m[1]));
  }
  const out = new Map<string, SectionSpec>();
  for (const m of spanText.matchAll(CANDIDATE_HEADING)) {
    const raw = m[1].trim();
    const key = normalizeHeading(raw);
    if (!key || known.has(key) || out.has(key)) continue;
    if (NOT_A_SECTION.test(key)) continue;
    // A heading that any contracted section would match is that section, even
    // when the contracted section did not fire on its own pattern first.
    if (contracted.some((s) => s.header.test(`\n${raw}: `))) continue;
    out.set(key, {
      key: `discovered:${key.replace(/\s+/g, "-")}`,
      // A heading we have never seen cannot be mapped to a known concept
      // without guessing, and guessing is what an open-world check exists to
      // avoid. It is tracked by its own name until the contract learns it.
      concept: "other",
      label: raw.replace(/\s+/g, " "),
      // A discovered section has no field mapping — nothing can satisfy it
      // except a claim whose own text quotes it, which is handled below.
      fields: [],
      header: H(escapeRe(raw)),
    });
  }
  return [...out.values()];
}

function normalizeHeading(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── The ledger ───────────────────────────────────────────────────────────────

export interface LedgerClaim {
  field: string;
  value: string;
  excerpt: string;
}

/**
 * Resolve every section of one entry.
 *
 * `spanText` is this entry's own slice of the source document. Pass null when
 * the span could not be located — every unsatisfied section then resolves to
 * ABSENT_FROM_SOURCE rather than to a miss, because with no source in hand we
 * cannot honestly say anything was missed.
 */
export function ledgerFor(
  klass: AnalysisClass,
  claims: readonly LedgerClaim[],
  spanText: string | null,
): LedgerVerdict {
  const contracted = SECTION_CONTRACT[klass] ?? [];
  // A class with no contract is not audited at all — not even by discovery.
  // A supporting file is exempt by policy, and UNKNOWN is unclassified paper:
  // reading "Re:" off a fax cover sheet as an unfilled section would flood the
  // ledger with misses that no extraction pass could ever repair. Material in
  // the wrong class is a classification problem, and the reviewer can reassign
  // it — at which point it acquires a contract and is measured properly.
  if (!contracted.length) {
    return { klass, sections: [], recoverable: [], completeness: 1 };
  }
  const specs: SectionSpec[] = [...contracted];
  if (spanText) specs.push(...discoverSections(spanText, contracted));

  const byField = new Map<string, string[]>();
  for (const c of claims) {
    if (!c.value?.trim()) continue;
    const list = byField.get(c.field) ?? [];
    list.push(c.value);
    byField.set(c.field, list);
  }

  const sections: SectionVerdict[] = specs.map((spec) => {
    const satisfiedBy = spec.fields.filter((f) => (byField.get(f)?.length ?? 0) > 0);
    const discovered = spec.key.startsWith("discovered:");
    // A discovered section has no fields to satisfy it, so it is satisfied when
    // any claim's excerpt was drawn from beneath that heading. Approximated by
    // the heading's own words appearing in a captured value or excerpt.
    const quoted = discovered && claims.some((c) => quotesHeading(c, spec.label));
    if (satisfiedBy.length || quoted) {
      return { key: spec.key, concept: spec.concept, label: spec.label, state: "PRESENT", satisfiedBy: [...satisfiedBy], headingText: null, discovered };
    }
    const m = spanText ? spec.header.exec(spanText) : null;
    if (m) {
      return {
        key: spec.key,
        concept: spec.concept,
        label: spec.label,
        state: "RECOVERABLE_MISS",
        satisfiedBy: [],
        headingText: m[1].replace(/\s+/g, " ").trim(),
        discovered,
      };
    }
    return { key: spec.key, concept: spec.concept, label: spec.label, state: "ABSENT_FROM_SOURCE", satisfiedBy: [], headingText: null, discovered };
  });

  const documented = sections.filter((s) => s.state !== "ABSENT_FROM_SOURCE");
  const present = documented.filter((s) => s.state === "PRESENT");
  return {
    klass,
    sections,
    recoverable: sections.filter((s) => s.state === "RECOVERABLE_MISS"),
    completeness: documented.length ? present.length / documented.length : 1,
  };
}

function quotesHeading(claim: LedgerClaim, label: string): boolean {
  const l = label.toLowerCase();
  return claim.value.toLowerCase().includes(l) || claim.excerpt.toLowerCase().includes(l);
}

/**
 * What a reviewer is told about a section we could not fill.
 *
 * A silent blank reads as "this visit had no examination". A stated gap reads
 * as "go look at page 12" — which is the difference between a defensible report
 * and a misleading one.
 */
export function gapNotice(v: SectionVerdict, pages: string | null): string {
  return v.state === "RECOVERABLE_MISS"
    ? `Not captured from this record${pages ? ` — review ${pages}` : ""}.`
    : "Not documented in this record.";
}
