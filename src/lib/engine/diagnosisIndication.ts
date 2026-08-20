// ─────────────────────────────────────────────────────────────────────────────
// Which DIAGNOSES clinically indicate which CARE?
//
// The panel's "Supporting diagnoses" bucket was gated on anatomy alone, so any
// lumbar diagnosis appeared under any lumbar service. A lumbar discectomy was
// shown as supported by "chronic cervical, thoracic and lumbar pain" and by a
// "lumbar burst fracture" — the first is not an indication for a discectomy at
// all, and the second indicates STABILISATION, which is a different operation.
//
// Anatomy answers "is this the right body part". It cannot answer "would a
// clinician offer THIS procedure FOR THIS diagnosis", and that is the question
// a defence expert asks first.
//
// So the model has two layers:
//
//   CONCEPT — what kind of clinical problem a diagnosis names, independent of
//   how it was written. "M54.16 Radiculopathy, lumbar region", "lumbar
//   radiculopathy" and "L5 nerve root impingement with radicular pain" are one
//   concept.
//
//   INDICATION — which concepts a given intervention is offered for. Keyed to
//   the canonical InterventionId, so a new spelling of an existing procedure
//   inherits the clinical model rather than escaping it.
//
// RELATED, AND NOT THE SAME: `indications.ts` holds per-service prerequisite
// CHECKLISTS evaluated against the whole case corpus, producing advisory
// validation findings. That asks "does the case as a whole show what this
// service presupposes". This module asks a narrower question about one pairing:
// "is THIS diagnosis a reason to offer THIS service", so the panel can stop
// presenting a diagnosis as support when it is really background.
//
// ── CLINICAL REVIEW ─────────────────────────────────────────────────────────
// The INDICATIONS table below encodes clinical practice and is the part of this
// file a physician should redline. It is deliberately written as data, in one
// place, with a version, so that reviewing it does not mean reading code. It is
// a filter on what the panel PRESENTS as support; it never overrides a treating
// provider's documented recommendation, and it never removes a diagnosis from
// the record — an excluded diagnosis is still shown, as condition background.
// ─────────────────────────────────────────────────────────────────────────────

import type { InterventionId } from "@/lib/engine/serviceOntology";

export const INDICATION_MODEL_VERSION = "indications-1";

/** The kind of clinical problem a diagnosis names. */
export type DiagnosisConcept =
  // ── Spine ────────────────────────────────────────────────────────────────
  | "RADICULOPATHY"
  | "DISC_HERNIATION"
  | "SPINAL_STENOSIS"
  | "FACET_ARTHROPATHY"
  | "SEGMENTAL_INSTABILITY"
  | "VERTEBRAL_FRACTURE"
  | "MYELOPATHY"
  | "SPINAL_CORD_INJURY"
  // ── Appendicular / joint ─────────────────────────────────────────────────
  | "OSTEOARTHRITIS"
  | "INTRA_ARTICULAR_TEAR"
  | "TENDINOPATHY"
  | "APPENDICULAR_FRACTURE"
  | "NONUNION"
  | "JOINT_INSTABILITY"
  // ── Neurologic / pain ────────────────────────────────────────────────────
  | "PERIPHERAL_NEUROPATHY"
  | "CRPS"
  | "CHRONIC_PAIN"
  | "MYOFASCIAL_SPASM"
  | "HEADACHE"
  // ── Whole-person ─────────────────────────────────────────────────────────
  | "TBI_COGNITIVE"
  | "PSYCHIATRIC"
  | "FUNCTIONAL_DEPENDENCE";

interface ConceptRule { concept: DiagnosisConcept; re: RegExp }

/**
 * Order matters: the more specific pathology wins. "Disc herniation with
 * radiculopathy" is both, and both are returned — but a bare "radiculopathy"
 * must not be read as a herniation, because a herniation is what licenses a
 * discectomy and radiculopathy alone does not.
 */
const CONCEPT_RULES: ConceptRule[] = [
  { concept: "SPINAL_CORD_INJURY", re: /\bspinal cord injur\w*|\bsci\b|tetrapleg\w*|parapleg\w*|quadripleg\w*|cauda equina/i },
  { concept: "MYELOPATHY", re: /myelopath\w*|cord compression|myelomalacia/i },
  { concept: "RADICULOPATHY", re: /radiculopath\w*|radicular|nerve root (?:impingement|compression|contact|irritation)|sciatica|\bm54\.1/i },
  { concept: "DISC_HERNIATION", re: /herniat\w*|\bhnp\b|disc (?:protrusion|extrusion|bulge|displacement)|annular tear/i },
  { concept: "SPINAL_STENOSIS", re: /stenosis|canal narrowing|foraminal narrowing/i },
  { concept: "FACET_ARTHROPATHY", re: /facet (?:arthropath\w*|syndrome|arthritis|hypertroph\w*)|zygapophyseal|spondylosis without|facet-mediated/i },
  { concept: "SEGMENTAL_INSTABILITY", re: /spondylolisthesis|segmental instabilit\w*|pars defect|spondylolysis|listhesis/i },
  { concept: "VERTEBRAL_FRACTURE", re: /(?:vertebral|burst|compression|chance) fracture|fracture of the (?:spine|vertebra)|\bt\d{1,2}\s+fracture|\bl[1-5]\s+fracture/i },
  { concept: "OSTEOARTHRITIS", re: /osteoarthrit\w*|degenerative joint disease|\bdjd\b|chondral loss|cartilage loss|bone[- ]on[- ]bone|kellgren/i },
  { concept: "INTRA_ARTICULAR_TEAR", re: /meniscal tear|meniscus tear|rotator cuff tear|labral tear|\bacl\b tear|ligament tear|torn (?:meniscus|cuff|labrum|ligament)/i },
  { concept: "TENDINOPATHY", re: /tendinopath\w*|tendinit\w*|tendinos\w*|bursit\w*|epicondylit\w*|impingement syndrome|plantar fasciit\w*/i },
  { concept: "NONUNION", re: /nonunion|non-union|malunion|delayed union|hardware failure/i },
  { concept: "APPENDICULAR_FRACTURE", re: /fracture/i },
  { concept: "JOINT_INSTABILITY", re: /joint instabilit\w*|subluxation|dislocation|laxity/i },
  { concept: "CRPS", re: /complex regional pain|\bcrps\b|reflex sympathetic dystroph\w*|causalgia/i },
  { concept: "PERIPHERAL_NEUROPATHY", re: /neuropath\w*|nerve (?:injury|damage|entrapment)|carpal tunnel|neuralgia/i },
  { concept: "TBI_COGNITIVE", re: /traumatic brain injur\w*|\btbi\b|concussion|post[- ]concussi\w*|cognitive (?:impairment|deficit)|memory (?:loss|impairment)/i },
  { concept: "PSYCHIATRIC", re: /depress\w*|anxiet\w*|\bptsd\b|post[- ]traumatic stress|adjustment disorder|insomnia|mood disorder/i },
  { concept: "HEADACHE", re: /headache|migraine|cephalgia/i },
  { concept: "MYOFASCIAL_SPASM", re: /muscle spasm|myofascial|strain\b|sprain\b|myositis/i },
  { concept: "FUNCTIONAL_DEPENDENCE", re: /dependen\w* (?:in|for|with)|requires assistance|unable to (?:ambulate|transfer|self-care)|gait (?:disorder|abnormality)|\badl\b deficit|functional (?:limitation\w*|deficit\w*|impairment\w*)|residual deficit\w*/i },
  // A bounded window rather than a fixed gap: "chronic cervical, thoracic, and
  // lumbar pain" puts thirty characters between the two words, and a 20-char
  // window read the whole phrase as naming no clinical concept at all.
  { concept: "CHRONIC_PAIN", re: /\bchronic\b[^.;]{0,48}?\bpain\b|pain syndrome|persistent pain|\bg89\./i },
];

/** Every concept a diagnosis names. A diagnosis commonly names several. */
export function classifyDiagnosis(text: string | null | undefined): DiagnosisConcept[] {
  const t = String(text ?? "");
  if (!t.trim()) return [];
  const out: DiagnosisConcept[] = [];
  for (const r of CONCEPT_RULES) if (r.re.test(t) && !out.includes(r.concept)) out.push(r.concept);
  // A generic fracture rule sits last so a vertebral fracture is not also
  // reported as an appendicular one.
  if (out.includes("VERTEBRAL_FRACTURE")) return out.filter((c) => c !== "APPENDICULAR_FRACTURE");
  return out;
}

/**
 * "ANY" means the intervention is legitimately non-specific: physical therapy,
 * a specialist follow-up or an MRI is offered across the whole musculoskeletal
 * and neurologic range, and listing every concept would be a fiction of
 * precision. Anatomy and the support contract still gate these.
 */
const ANY = "ANY" as const;

/**
 * Which diagnosis concepts indicate which intervention.
 *
 * ── FOR CLINICAL REVIEW ─────────────────────────────────────────────────────
 * Each row answers: "for which documented problems would a clinician offer
 * this?" Rows are conservative — a concept absent here does not make the care
 * wrong, it makes that diagnosis not the thing that supports it, and the panel
 * then shows the diagnosis as background rather than as support.
 */
export const INDICATIONS: Partial<Record<InterventionId, readonly DiagnosisConcept[] | typeof ANY>> = {
  // ── Interventional pain ───────────────────────────────────────────────────
  // An epidural addresses nerve-root pain; a facet procedure addresses axial
  // joint pain. They are not interchangeable, and this is where that is stated.
  EPIDURAL_STEROID: ["RADICULOPATHY", "DISC_HERNIATION", "SPINAL_STENOSIS"],
  MEDIAL_BRANCH_BLOCK: ["FACET_ARTHROPATHY", "CHRONIC_PAIN"],
  FACET_INJECTION: ["FACET_ARTHROPATHY", "CHRONIC_PAIN"],
  RADIOFREQUENCY_ABLATION: ["FACET_ARTHROPATHY", "CHRONIC_PAIN"],
  SYMPATHETIC_BLOCK: ["CRPS", "PERIPHERAL_NEUROPATHY"],
  JOINT_INJECTION: ["OSTEOARTHRITIS", "TENDINOPATHY", "INTRA_ARTICULAR_TEAR"],
  VISCOSUPPLEMENTATION: ["OSTEOARTHRITIS"],
  PRP_INJECTION: ["OSTEOARTHRITIS", "TENDINOPATHY"],
  TRIGGER_POINT: ["MYOFASCIAL_SPASM", "CHRONIC_PAIN", "HEADACHE"],
  INJECTION_GUIDANCE: ANY,

  // ── Surgery ───────────────────────────────────────────────────────────────
  // A discectomy removes herniated disc material compressing a nerve root. A
  // burst fracture is not an indication for it — that indicates stabilisation.
  DISCECTOMY: ["DISC_HERNIATION", "RADICULOPATHY"],
  LAMINECTOMY_DECOMPRESSION: ["SPINAL_STENOSIS", "MYELOPATHY", "RADICULOPATHY"],
  // Fusion spans more than instability. An ACDF is the standard operation for
  // cervical radiculopathy from disc disease, and a lumbar fusion is offered
  // for stenosis or herniation with instability. Excluding radiculopathy here
  // made the panel call a cervical radiculopathy "not an indication" for an
  // ACDF — the one operation most clearly offered for it.
  //
  // Fusion's specificity comes from PREREQUISITES — documented instability,
  // failed conservative care — not from a narrow diagnosis list. See
  // `indications.ts` for the prerequisite checklists.
  SPINAL_FUSION: ["SEGMENTAL_INSTABILITY", "VERTEBRAL_FRACTURE", "SPINAL_CORD_INJURY", "MYELOPATHY", "RADICULOPATHY", "DISC_HERNIATION", "SPINAL_STENOSIS"],
  ARTHROPLASTY: ["OSTEOARTHRITIS", "NONUNION", "APPENDICULAR_FRACTURE"],
  REVISION_ARTHROPLASTY: ["OSTEOARTHRITIS", "NONUNION", "JOINT_INSTABILITY"],
  ARTHROSCOPY: ["INTRA_ARTICULAR_TEAR", "OSTEOARTHRITIS", "JOINT_INSTABILITY"],
  FRACTURE_FIXATION: ["APPENDICULAR_FRACTURE", "VERTEBRAL_FRACTURE", "NONUNION"],
  HARDWARE_REMOVAL: ["NONUNION", "APPENDICULAR_FRACTURE", "VERTEBRAL_FRACTURE"],
  SPINAL_CORD_STIMULATOR: ["CHRONIC_PAIN", "CRPS", "RADICULOPATHY", "PERIPHERAL_NEUROPATHY"],
  PUMP_IMPLANT: ["CHRONIC_PAIN", "SPINAL_CORD_INJURY"],

  // ── Diagnostics ───────────────────────────────────────────────────────────
  EMG_NCS: ["RADICULOPATHY", "PERIPHERAL_NEUROPATHY", "MYELOPATHY"],
  MRI: ANY,
  CT: ANY,
  RADIOGRAPH: ANY,
  ULTRASOUND: ANY,

  // ── Therapy ───────────────────────────────────────────────────────────────
  PHYSICAL_THERAPY: ANY,
  OCCUPATIONAL_THERAPY: ANY,
  AQUATIC_THERAPY: ANY,
  FUNCTIONAL_RESTORATION: ["CHRONIC_PAIN", "FUNCTIONAL_DEPENDENCE"],
  CHIROPRACTIC: ["MYOFASCIAL_SPASM", "CHRONIC_PAIN", "FACET_ARTHROPATHY"],
  SPEECH_THERAPY: ["TBI_COGNITIVE", "SPINAL_CORD_INJURY"],
  COGNITIVE_THERAPY: ["TBI_COGNITIVE"],
  PSYCHOTHERAPY: ["PSYCHIATRIC", "CHRONIC_PAIN", "TBI_COGNITIVE"],

  // ── Medication ────────────────────────────────────────────────────────────
  OPIOID: ["CHRONIC_PAIN"],
  NSAID: ["CHRONIC_PAIN", "OSTEOARTHRITIS", "TENDINOPATHY", "MYOFASCIAL_SPASM"],
  NEUROPATHIC_AGENT: ["RADICULOPATHY", "PERIPHERAL_NEUROPATHY", "CRPS", "CHRONIC_PAIN"],
  MUSCLE_RELAXANT: ["MYOFASCIAL_SPASM", "CHRONIC_PAIN"],
  TOPICAL_ANALGESIC: ["CHRONIC_PAIN", "OSTEOARTHRITIS", "MYOFASCIAL_SPASM", "TENDINOPATHY"],
  PSYCHOTROPIC: ["PSYCHIATRIC", "CHRONIC_PAIN"],
  MEDICATION_MONITORING: ANY,
  LAB_MONITORING: ANY,

  // ── Equipment ─────────────────────────────────────────────────────────────
  ORTHOSIS_BRACE: ["SEGMENTAL_INSTABILITY", "JOINT_INSTABILITY", "APPENDICULAR_FRACTURE", "VERTEBRAL_FRACTURE", "OSTEOARTHRITIS", "FUNCTIONAL_DEPENDENCE"],
  MOBILITY_AID: ["FUNCTIONAL_DEPENDENCE", "SPINAL_CORD_INJURY", "OSTEOARTHRITIS", "APPENDICULAR_FRACTURE"],
  WHEELCHAIR: ["FUNCTIONAL_DEPENDENCE", "SPINAL_CORD_INJURY"],
  TENS_UNIT: ["CHRONIC_PAIN", "MYOFASCIAL_SPASM", "RADICULOPATHY"],
  NMES_UNIT: ["FUNCTIONAL_DEPENDENCE", "SPINAL_CORD_INJURY", "PERIPHERAL_NEUROPATHY"],
  PROSTHESIS: ["APPENDICULAR_FRACTURE", "FUNCTIONAL_DEPENDENCE"],
  HOSPITAL_BED: ["FUNCTIONAL_DEPENDENCE", "SPINAL_CORD_INJURY"],
  BATHROOM_SAFETY: ["FUNCTIONAL_DEPENDENCE", "SPINAL_CORD_INJURY"],
  ASSISTIVE_TECH: ["FUNCTIONAL_DEPENDENCE", "TBI_COGNITIVE", "SPINAL_CORD_INJURY"],
  SUPPLIES: ANY,

  // ── Care & environment ────────────────────────────────────────────────────
  ATTENDANT_CARE: ["FUNCTIONAL_DEPENDENCE", "SPINAL_CORD_INJURY", "TBI_COGNITIVE"],
  SKILLED_NURSING: ["FUNCTIONAL_DEPENDENCE", "SPINAL_CORD_INJURY"],
  HOME_MODIFICATION: ["FUNCTIONAL_DEPENDENCE", "SPINAL_CORD_INJURY"],
  TRANSPORTATION: ["FUNCTIONAL_DEPENDENCE", "SPINAL_CORD_INJURY", "TBI_COGNITIVE"],
  CASE_MANAGEMENT: ANY,

  // ── Evaluation ────────────────────────────────────────────────────────────
  SPECIALIST_FOLLOWUP: ANY,
  PRIMARY_CARE: ANY,
  PSYCH_EVALUATION: ["PSYCHIATRIC", "CHRONIC_PAIN", "TBI_COGNITIVE"],
  NEUROPSYCH_EVALUATION: ["TBI_COGNITIVE", "PSYCHIATRIC"],
  FUNCTIONAL_CAPACITY_EVAL: ANY,
};

export type IndicationVerdict =
  /** A recognised indication for this intervention. */
  | "INDICATED"
  /** A real diagnosis in the case that this intervention is not offered for. */
  | "CONTEXT"
  /** The intervention is legitimately non-specific. */
  | "NON_SPECIFIC"
  /** Nothing in the text resolved to a clinical concept. */
  | "UNCLASSIFIED";

export interface IndicationResult {
  verdict: IndicationVerdict;
  concepts: DiagnosisConcept[];
  /** The concepts that actually did the indicating, for disclosure. */
  matched: DiagnosisConcept[];
}

/**
 * Would a clinician offer this intervention for this diagnosis?
 *
 * `CONTEXT` is the important verdict and the one that did not exist: a real,
 * anatomically-correct diagnosis that is simply not what this service treats.
 * It is not an error and it is not support.
 */
export function indicationFor(diagnosisText: string, intervention: InterventionId): IndicationResult {
  const concepts = classifyDiagnosis(diagnosisText);
  const allowed = INDICATIONS[intervention];
  if (allowed === ANY) return { verdict: "NON_SPECIFIC", concepts, matched: concepts };
  if (!concepts.length) return { verdict: "UNCLASSIFIED", concepts, matched: [] };
  if (!allowed) return { verdict: "UNCLASSIFIED", concepts, matched: [] };
  const matched = concepts.filter((c) => allowed.includes(c));
  return { verdict: matched.length ? "INDICATED" : "CONTEXT", concepts, matched };
}

/** May this diagnosis be presented as SUPPORT for this intervention? */
export const diagnosisSupports = (diagnosisText: string, intervention: InterventionId): boolean => {
  const v = indicationFor(diagnosisText, intervention).verdict;
  return v === "INDICATED" || v === "NON_SPECIFIC" || v === "UNCLASSIFIED";
};

/** Why a diagnosis is shown as background rather than as support. */
export function contextReason(diagnosisText: string, intervention: InterventionId): string | null {
  const r = indicationFor(diagnosisText, intervention);
  if (r.verdict !== "CONTEXT") return null;
  const names = r.concepts.map((c) => c.replace(/_/g, " ").toLowerCase()).join(", ");
  return `documents ${names}, which is not an indication for this service`;
}
