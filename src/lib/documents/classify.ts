import { guessDocType, TYPE_LABEL } from "@/lib/documents/taxonomy";

// ─────────────────────────────────────────────────────────────────────────────
// Content-based document classification.
//
// The document's extracted TEXT is scored against per-type content signatures —
// phrases that actually appear in the body of that kind of record (e.g. an
// operative note contains "preoperative diagnosis" and "estimated blood loss";
// a deposition contains "sworn" and "court reporter"). The filename is only a
// weak tie-breaker / fallback, never the primary signal. This is the fix for
// classifying by title instead of composition.
// ─────────────────────────────────────────────────────────────────────────────

// Each signature phrase is weighted by specificity: multi-word clinical phrases
// are far stronger evidence than a single common word.
const SIGNATURES: Record<string, string[]> = {
  OPERATIVE_NOTE: [
    "preoperative diagnosis",
    "postoperative diagnosis",
    "procedure performed",
    "estimated blood loss",
    "surgeon:",
    "assistant surgeon",
    "operative note",
    "operative report",
    "specimens removed",
    "anesthesia: general",
    "closure",
  ],
  ANESTHESIA_RECORD: ["anesthesia record", "asa class", "endotracheal", "induction", "anesthesiologist", "spinal anesthesia"],
  PATHOLOGY_REPORT: ["pathology report", "gross description", "microscopic description", "specimen", "histologic", "final diagnosis:"],
  IMAGING_REPORT: ["impression:", "findings:", "technique:", "radiologist", "comparison:", "there is no acute", "contrast was administered", "mri of the", "ct of the"],
  LAB_REPORT: ["reference range", "reference interval", "hemoglobin", "white blood cell", "specimen collected", "mg/dl", "out of range", "result flag"],
  ER_RECORD: ["chief complaint", "emergency department", "triage", "disposition:", "time of arrival", "mode of arrival"],
  DISCHARGE_SUMMARY: ["discharge summary", "hospital course", "discharge diagnosis", "discharge medications", "discharge disposition", "admission date"],
  HOSPITAL_RECORD: ["admission date", "attending physician", "hospital day", "progress note", "history and physical"],
  NURSING_NOTE: ["nursing note", "vital signs", "pain scale", "call light", "shift assessment", "turned and repositioned"],
  PT_OT_RECORD: ["physical therapy", "occupational therapy", "range of motion", "therapeutic exercise", "gait training", "home exercise program", "plan of care", "short-term goals"],
  SPEECH_THERAPY: ["speech therapy", "speech-language", "dysphagia", "swallow study", "language therapy"],
  PAIN_MANAGEMENT: ["epidural steroid injection", "facet joint", "pain management", "medial branch block", "fluoroscopic guidance", "pain scale", "opioid agreement"],
  CHIROPRACTIC_RECORD: ["chiropractic", "spinal adjustment", "manipulation", "subluxation"],
  NEUROLOGY_RECORD: ["cranial nerves", "deep tendon reflexes", "neurologic examination", "seizure", "gait is"],
  NEUROSURGERY_RECORD: ["neurosurgery", "laminectomy", "craniotomy", "decompression", "instrumented fusion"],
  ORTHOPEDIC_CLINIC: ["orthopedic", "range of motion", "hardware", "fracture", "weight bearing", "follow-up in", "orif"],
  PSYCHIATRY_RECORD: ["psychiatric", "mental status exam", "affect", "suicidal ideation", "psychiatric evaluation"],
  PSYCHOLOGY_RECORD: ["psychotherapy", "counseling session", "coping", "psychological"],
  CARDIOLOGY_RECORD: ["cardiology", "ejection fraction", "echocardiogram", "coronary"],
  EMG_NCS_REPORT: ["nerve conduction", "electromyography", "motor latency", "sensory amplitude", "denervation", "emg"],
  NEUROPSYCHOLOGICAL_EVALUATION: ["neuropsychological", "test battery", "wechsler", "cognitive functioning", "validity indicators", "memory index"],
  BILLING_RECORD: ["cpt", "hcpcs", "date of service", "total charges", "amount billed", "balance due", "explanation of benefits", "eob", "adjustments", "patient responsibility"],
  PHARMACY_RECORD: ["prescription", "refills", "ndc", "sig:", "dispense", "pharmacy", "days supply", "take one tablet"],
  DEPOSITION: ["deposition of", "being first duly sworn", "court reporter", "examination by", "reporter's certificate", "appearances:", "q.", "a."],
  IME_REPORT: ["independent medical examination", "record review", "maximum medical improvement", "impairment rating", "within a reasonable degree of medical", "history of present"],
  EXPERT_REPORT: ["expert report", "my opinions", "reasonable degree of medical certainty", "curriculum vitae", "materials reviewed", "retained by"],
  PEER_REVIEW: ["peer review", "medical necessity", "utilization review", "reviewer's determination"],
  LIFE_CARE_PLAN: ["life care plan", "future medical care", "cost projection", "annual cost", "life expectancy", "per year for life"],
  FUNCTIONAL_CAPACITY_EVALUATION: ["functional capacity evaluation", "material handling", "lifting capacity", "physical demand level", "work tolerance"],
  VOCATIONAL_ASSESSMENT: ["vocational", "labor market survey", "transferable skills", "earning capacity", "employability"],
  POLICE_REPORT: ["police department", "officer", "incident number", "citation", "vehicle 1", "traffic collision", "narrative:"],
  EMS_REPORT: ["ems", "paramedic", "glasgow coma", "on scene", "en route", "ambulance", "patient care report"],
  LEGAL_PLEADING: ["comes now", "plaintiff", "defendant", "cause of action", "jury trial demanded", "wherefore", "superior court"],
  DEMAND_LETTER: ["demand", "policy limits", "settlement", "hereby demand", "time-limited demand"],
  WAGE_LOSS_DOCUMENTATION: ["wage", "lost earnings", "gross pay", "pay period", "hourly rate", "w-2"],
  EMPLOYMENT_RECORDS: ["date of hire", "job title", "personnel file", "employment", "termination"],
  INSURANCE_RECORDS: ["policy number", "claim number", "coverage", "adjuster", "insured"],
};

const MULTIWORD_BONUS = 1; // multi-word phrases earn +1 on top of the base point

export interface ContentResult {
  type: string;
  score: number;
  runnerUp: string | null;
  runnerUpScore: number;
  matched: string[];
}

/** Score the extracted text against every type signature and pick the best. */
export function classifyByContent(text: string): ContentResult {
  const lower = ` ${text.toLowerCase()} `;
  const scores: { type: string; score: number; matched: string[] }[] = [];

  for (const [type, phrases] of Object.entries(SIGNATURES)) {
    let score = 0;
    const matched: string[] = [];
    for (const phrase of phrases) {
      if (lower.includes(phrase)) {
        score += 1 + (phrase.includes(" ") ? MULTIWORD_BONUS : 0);
        matched.push(phrase);
      }
    }
    if (score > 0) scores.push({ type, score, matched });
  }

  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const second = scores[1];
  return {
    type: top?.type ?? "MEDICAL_RECORD",
    score: top?.score ?? 0,
    runnerUp: second?.type ?? null,
    runnerUpScore: second?.score ?? 0,
    matched: top?.matched ?? [],
  };
}

export type ClassificationMethod = "content" | "filename" | "default";

export interface Classification {
  type: string;
  method: ClassificationMethod;
  score: number;
  confidence: number; // 0–1, for display
  note: string;
}

// A confident content classification needs a couple of real signals and a clear
// margin over the runner-up.
const CONFIDENT_SCORE = 3;
const CONFIDENT_MARGIN = 2;

/**
 * Decide a document's type primarily from its CONTENT, using the filename only
 * as a fallback when the body has no usable text (scans) or gives no signal.
 */
export function classifyDocument(input: { text: string; filename: string; hasText: boolean }): Classification {
  const filenameGuess = guessDocType(input.filename);
  const filenameHelped = filenameGuess !== "MEDICAL_RECORD";

  // No reliable text (e.g. a scanned image PDF) → we cannot read composition.
  if (!input.hasText || input.text.trim().length < 40) {
    return {
      type: filenameGuess,
      method: "filename",
      score: 0,
      confidence: filenameHelped ? 0.4 : 0.15,
      note: "No extractable text (likely a scan) — classified from the filename; verify and reassign if needed.",
    };
  }

  const content = classifyByContent(input.text);
  const confident = content.score >= CONFIDENT_SCORE && content.score - content.runnerUpScore >= CONFIDENT_MARGIN;

  if (confident) {
    // Filename agreement nudges confidence up.
    const agree = filenameGuess === content.type;
    return {
      type: content.type,
      method: "content",
      score: content.score,
      confidence: Math.min(0.98, 0.6 + content.score * 0.05 + (agree ? 0.1 : 0)),
      note: `Read from document content — matched ${content.matched.slice(0, 3).map((m) => `"${m}"`).join(", ")}.`,
    };
  }

  // Weak/ambiguous content: prefer a real filename hint if we have one.
  if (filenameHelped) {
    return {
      type: filenameGuess,
      method: "filename",
      score: content.score,
      confidence: 0.4,
      note: "Content signal was weak — used the filename hint. Reassign if incorrect.",
    };
  }

  // Some content signal but low: take it; else generic medical record.
  if (content.score > 0) {
    return {
      type: content.type,
      method: "content",
      score: content.score,
      confidence: 0.35,
      note: `Weak content match (${TYPE_LABEL[content.type] ?? content.type}) — please verify.`,
    };
  }

  return {
    type: "MEDICAL_RECORD",
    method: "default",
    score: 0,
    confidence: 0.1,
    note: "No distinguishing content or filename signal — filed as a general medical record.",
  };
}
