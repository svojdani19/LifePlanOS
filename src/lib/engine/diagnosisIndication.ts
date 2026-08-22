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
 * Where an indication comes from.
 *
 * A row is not my opinion that a diagnosis suits a procedure — it names the
 * guideline whose OWN population is that diagnosis and which addresses that
 * procedure for it. NASS writes a guideline about "lumbar disc herniation with
 * radiculopathy" and that document is where discectomy and epidural injection
 * are discussed; AAOS writes about "osteoarthritis of the knee" and that is
 * where arthroplasty is discussed. The pairing is the guideline's, not mine.
 *
 * `CONVENTION` is the honest value where no condition-specific CPG establishes
 * the pairing — durable medical equipment, transportation, case management.
 * Marking those rather than attaching a plausible-sounding guideline is the
 * difference between a citation and a decoration.
 */
export interface IndicationBasis {
  /** ReferenceSource id in `src/lib/references/sources.ts`. */
  sourceId: "nass" | "aaos" | "asipp" | "aan" | "cdc-opioid" | "acoem" | "odg" | "icsi";
  /** The guideline's own named population — the diagnosis it is written about. */
  namedDiagnosis: string;
  /**
   * WHICH WAY the guideline points for this pairing.
   *
   * The first version of this table had no direction field, and modelled "a
   * guideline discusses this topic" as "the guideline supports this
   * intervention". Two rows were therefore backwards on screen:
   *
   *   • arthroscopy for primary knee osteoarthritis cited AAOS — which
   *     recommends AGAINST arthroscopic lavage and debridement for it;
   *   • opioids for chronic pain cited the CDC — which prefers nonopioid
   *     therapy and supports opioids only where the benefits are expected to
   *     outweigh the risks for that patient.
   *
   * A citation that reverses the guideline's position is worse than no
   * citation: it lends the guideline's authority to the opposite of what it
   * says, in a document that gets read aloud under oath.
   */
  direction: "SUPPORTS" | "CONDITIONAL" | "AGAINST";
  /** For CONDITIONAL and AGAINST: the guideline's actual position, in brief. */
  position?: string;
  /**
   * VERIFICATION STATUS.
   *
   * `UNVERIFIED` means the body, its named population and the intervention it
   * addresses are stated from general knowledge and have NOT been checked
   * against the publication. Every row ships UNVERIFIED. A citation is worth
   * printing only once someone has opened the document, and asserting a title,
   * a year or a recommendation grade that nobody checked is exactly the kind of
   * decoration this file exists to avoid.
   */
  status: "UNVERIFIED" | "VERIFIED";
}

export interface IndicationRow {
  concept: DiagnosisConcept;
  basis: IndicationBasis | "CONVENTION";
}

const g = (sourceId: IndicationBasis["sourceId"], namedDiagnosis: string): IndicationBasis => ({ sourceId, namedDiagnosis, direction: "SUPPORTS", status: "UNVERIFIED" });
/** A guideline that qualifies rather than endorses. */
const gCond = (sourceId: IndicationBasis["sourceId"], namedDiagnosis: string, position: string): IndicationBasis => ({ sourceId, namedDiagnosis, direction: "CONDITIONAL", position, status: "UNVERIFIED" });
/** A guideline that recommends AGAINST this intervention for this diagnosis. */
const gAgainst = (sourceId: IndicationBasis["sourceId"], namedDiagnosis: string, position: string): IndicationBasis => ({ sourceId, namedDiagnosis, direction: "AGAINST", position, status: "UNVERIFIED" });
const row = (concept: DiagnosisConcept, basis: IndicationBasis | "CONVENTION"): IndicationRow => ({ concept, basis });
const CONV = "CONVENTION" as const;

/**
 * Which diagnoses indicate which intervention, and under which guideline.
 *
 * ── FOR CLINICAL REVIEW ─────────────────────────────────────────────────────
 * Read a row as: "this guideline is written about THIS diagnosis and addresses
 * THIS intervention for it." A concept absent from a row does not make the care
 * wrong — it makes that diagnosis background rather than support, and the panel
 * says so with the reason.
 *
 * Every row is UNVERIFIED until someone checks it against the publication.
 * `verificationSummary()` reports how many remain.
 */
export const INDICATIONS: Partial<Record<InterventionId, readonly IndicationRow[] | typeof ANY>> = {
  // ── Interventional pain ───────────────────────────────────────────────────
  // ASIPP's interventional-techniques guidelines separate the radicular
  // (epidural) indication from the axial facet-joint indication. That
  // separation is the guideline's, and it is why these rows differ.
  EPIDURAL_STEROID: [
    row("RADICULOPATHY", g("nass", "lumbar disc herniation with radiculopathy")),
    row("DISC_HERNIATION", g("nass", "lumbar disc herniation with radiculopathy")),
    row("SPINAL_STENOSIS", g("nass", "degenerative lumbar spinal stenosis")),
  ],
  MEDIAL_BRANCH_BLOCK: [
    row("FACET_ARTHROPATHY", g("asipp", "facet-joint (axial) chronic spinal pain")),
    row("CHRONIC_PAIN", g("asipp", "chronic axial spinal pain")),
  ],
  FACET_INJECTION: [
    row("FACET_ARTHROPATHY", g("asipp", "facet-joint (axial) chronic spinal pain")),
    row("CHRONIC_PAIN", g("asipp", "chronic axial spinal pain")),
  ],
  RADIOFREQUENCY_ABLATION: [
    row("FACET_ARTHROPATHY", g("asipp", "facet-joint (axial) chronic spinal pain")),
    row("CHRONIC_PAIN", g("asipp", "chronic axial spinal pain")),
  ],
  SYMPATHETIC_BLOCK: [
    row("CRPS", g("odg", "complex regional pain syndrome")),
    row("PERIPHERAL_NEUROPATHY", g("odg", "sympathetically-mediated pain")),
  ],
  JOINT_INJECTION: [
    row("OSTEOARTHRITIS", g("aaos", "osteoarthritis of the knee")),
    row("TENDINOPATHY", g("aaos", "rotator cuff and tendon disorders")),
    row("INTRA_ARTICULAR_TEAR", g("aaos", "meniscal and articular cartilage lesions")),
  ],
  VISCOSUPPLEMENTATION: [row("OSTEOARTHRITIS", g("aaos", "osteoarthritis of the knee"))],
  PRP_INJECTION: [
    row("OSTEOARTHRITIS", g("aaos", "osteoarthritis of the knee")),
    row("TENDINOPATHY", g("aaos", "tendinopathy")),
  ],
  TRIGGER_POINT: [
    row("MYOFASCIAL_SPASM", g("odg", "myofascial pain")),
    row("CHRONIC_PAIN", g("odg", "chronic pain")),
    row("HEADACHE", g("aan", "chronic migraine")),
  ],
  INJECTION_GUIDANCE: ANY,

  // ── Surgery ───────────────────────────────────────────────────────────────
  DISCECTOMY: [
    row("DISC_HERNIATION", g("nass", "lumbar disc herniation with radiculopathy")),
    row("RADICULOPATHY", g("nass", "lumbar disc herniation with radiculopathy")),
  ],
  LAMINECTOMY_DECOMPRESSION: [
    row("SPINAL_STENOSIS", g("nass", "degenerative lumbar spinal stenosis")),
    row("MYELOPATHY", g("nass", "cervical degenerative myelopathy")),
    row("RADICULOPATHY", g("nass", "cervical radiculopathy from degenerative disorders")),
  ],
  // Fusion appears in several guidelines, each about a different diagnosis —
  // which is why this row is the broadest. Its discipline comes from the
  // PREREQUISITE checklists in `indications.ts`, not from a narrow list here.
  SPINAL_FUSION: [
    row("SEGMENTAL_INSTABILITY", g("nass", "degenerative lumbar spondylolisthesis")),
    row("VERTEBRAL_FRACTURE", g("odg", "vertebral fracture requiring stabilisation")),
    row("SPINAL_CORD_INJURY", g("odg", "traumatic spinal cord injury")),
    row("MYELOPATHY", g("nass", "cervical degenerative myelopathy")),
    row("RADICULOPATHY", g("nass", "cervical radiculopathy from degenerative disorders")),
    row("DISC_HERNIATION", g("nass", "cervical radiculopathy from degenerative disorders")),
    row("SPINAL_STENOSIS", g("nass", "degenerative lumbar spinal stenosis")),
  ],
  ARTHROPLASTY: [
    row("OSTEOARTHRITIS", g("aaos", "surgical management of osteoarthritis of the knee")),
    row("NONUNION", g("aaos", "hip fracture in the elderly")),
    row("APPENDICULAR_FRACTURE", g("aaos", "hip fracture in the elderly")),
  ],
  REVISION_ARTHROPLASTY: [
    row("OSTEOARTHRITIS", g("aaos", "revision total joint arthroplasty")),
    row("NONUNION", g("aaos", "periprosthetic joint complications")),
    row("JOINT_INSTABILITY", g("aaos", "periprosthetic joint complications")),
  ],
  ARTHROSCOPY: [
    row("INTRA_ARTICULAR_TEAR", g("aaos", "management of rotator cuff injuries")),
    row("OSTEOARTHRITIS", gAgainst("aaos", "osteoarthritis of the knee", "AAOS recommends against arthroscopy with lavage and/or debridement for primary knee osteoarthritis")),
    row("JOINT_INSTABILITY", g("aaos", "glenohumeral instability")),
  ],
  FRACTURE_FIXATION: [
    row("APPENDICULAR_FRACTURE", g("aaos", "distal radius / hip / tibial fracture management")),
    row("VERTEBRAL_FRACTURE", g("odg", "vertebral fracture requiring stabilisation")),
    row("NONUNION", g("aaos", "fracture nonunion")),
  ],
  HARDWARE_REMOVAL: [
    row("NONUNION", CONV),
    row("APPENDICULAR_FRACTURE", CONV),
    row("VERTEBRAL_FRACTURE", CONV),
  ],
  SPINAL_CORD_STIMULATOR: [
    row("CHRONIC_PAIN", g("asipp", "chronic refractory spinal pain")),
    row("CRPS", g("odg", "complex regional pain syndrome")),
    row("RADICULOPATHY", g("asipp", "post-surgical persistent radicular pain")),
    row("PERIPHERAL_NEUROPATHY", g("aan", "painful diabetic and other neuropathies")),
  ],
  PUMP_IMPLANT: [
    row("CHRONIC_PAIN", g("asipp", "chronic refractory pain")),
    row("SPINAL_CORD_INJURY", g("odg", "spasticity in spinal cord injury")),
  ],

  // ── Diagnostics ───────────────────────────────────────────────────────────
  EMG_NCS: [
    row("RADICULOPATHY", g("aan", "electrodiagnostic assessment of radiculopathy")),
    row("PERIPHERAL_NEUROPATHY", g("aan", "distal symmetric polyneuropathy")),
    row("MYELOPATHY", g("aan", "electrodiagnostic assessment of myelopathy")),
  ],
  MRI: ANY,
  CT: ANY,
  RADIOGRAPH: ANY,
  ULTRASOUND: ANY,

  // ── Therapy ───────────────────────────────────────────────────────────────
  PHYSICAL_THERAPY: ANY,
  OCCUPATIONAL_THERAPY: ANY,
  AQUATIC_THERAPY: ANY,
  FUNCTIONAL_RESTORATION: [
    row("CHRONIC_PAIN", g("acoem", "chronic pain — functional restoration")),
    row("FUNCTIONAL_DEPENDENCE", g("acoem", "chronic pain — functional restoration")),
  ],
  CHIROPRACTIC: [
    row("MYOFASCIAL_SPASM", g("acoem", "low back disorders")),
    row("CHRONIC_PAIN", g("acoem", "low back disorders")),
    row("FACET_ARTHROPATHY", g("acoem", "low back disorders")),
  ],
  SPEECH_THERAPY: [
    row("TBI_COGNITIVE", g("acoem", "traumatic brain injury")),
    row("SPINAL_CORD_INJURY", CONV),
  ],
  COGNITIVE_THERAPY: [row("TBI_COGNITIVE", g("acoem", "traumatic brain injury"))],
  PSYCHOTHERAPY: [
    row("PSYCHIATRIC", g("icsi", "depression and anxiety in adults")),
    row("CHRONIC_PAIN", g("acoem", "chronic pain — psychological treatment")),
    row("TBI_COGNITIVE", g("acoem", "traumatic brain injury")),
  ],

  // ── Medication ────────────────────────────────────────────────────────────
  OPIOID: [row("CHRONIC_PAIN", gCond("cdc-opioid", "subacute and chronic pain", "CDC prefers nonopioid therapy; opioids only where expected benefits outweigh risks for this patient"))],
  NSAID: [
    row("CHRONIC_PAIN", g("acoem", "chronic pain")),
    row("OSTEOARTHRITIS", g("aaos", "osteoarthritis of the knee")),
    row("TENDINOPATHY", g("acoem", "shoulder and elbow disorders")),
    row("MYOFASCIAL_SPASM", g("acoem", "low back disorders")),
  ],
  NEUROPATHIC_AGENT: [
    row("RADICULOPATHY", g("acoem", "low back disorders — neuropathic pain")),
    row("PERIPHERAL_NEUROPATHY", g("aan", "painful diabetic neuropathy")),
    row("CRPS", g("odg", "complex regional pain syndrome")),
    row("CHRONIC_PAIN", g("acoem", "chronic pain")),
  ],
  MUSCLE_RELAXANT: [
    row("MYOFASCIAL_SPASM", g("acoem", "low back disorders")),
    row("CHRONIC_PAIN", g("acoem", "chronic pain")),
  ],
  TOPICAL_ANALGESIC: [
    row("CHRONIC_PAIN", g("acoem", "chronic pain")),
    row("OSTEOARTHRITIS", g("aaos", "osteoarthritis of the knee")),
    row("MYOFASCIAL_SPASM", g("acoem", "low back disorders")),
    row("TENDINOPATHY", g("acoem", "shoulder and elbow disorders")),
  ],
  PSYCHOTROPIC: [
    row("PSYCHIATRIC", g("icsi", "depression and anxiety in adults")),
    row("CHRONIC_PAIN", g("acoem", "chronic pain")),
  ],
  MEDICATION_MONITORING: ANY,
  LAB_MONITORING: ANY,

  // ── Equipment ─────────────────────────────────────────────────────────────
  // Durable medical equipment is largely CONVENTION: it is prescribed from a
  // documented deficit rather than from a condition-specific CPG. Saying so is
  // more useful than attaching a guideline that does not address the device.
  ORTHOSIS_BRACE: [
    row("SEGMENTAL_INSTABILITY", g("odg", "spinal bracing")),
    row("VERTEBRAL_FRACTURE", g("odg", "spinal bracing")),
    row("JOINT_INSTABILITY", CONV),
    row("APPENDICULAR_FRACTURE", CONV),
    row("OSTEOARTHRITIS", g("aaos", "osteoarthritis of the knee — bracing")),
    row("FUNCTIONAL_DEPENDENCE", CONV),
  ],
  MOBILITY_AID: [
    row("FUNCTIONAL_DEPENDENCE", CONV), row("SPINAL_CORD_INJURY", CONV),
    row("OSTEOARTHRITIS", CONV), row("APPENDICULAR_FRACTURE", CONV),
  ],
  WHEELCHAIR: [row("FUNCTIONAL_DEPENDENCE", CONV), row("SPINAL_CORD_INJURY", CONV)],
  TENS_UNIT: [
    row("CHRONIC_PAIN", g("odg", "transcutaneous electrical nerve stimulation")),
    row("MYOFASCIAL_SPASM", g("odg", "transcutaneous electrical nerve stimulation")),
    row("RADICULOPATHY", g("odg", "transcutaneous electrical nerve stimulation")),
  ],
  NMES_UNIT: [row("FUNCTIONAL_DEPENDENCE", CONV), row("SPINAL_CORD_INJURY", CONV), row("PERIPHERAL_NEUROPATHY", CONV)],
  PROSTHESIS: [row("APPENDICULAR_FRACTURE", CONV), row("FUNCTIONAL_DEPENDENCE", CONV)],
  HOSPITAL_BED: [row("FUNCTIONAL_DEPENDENCE", CONV), row("SPINAL_CORD_INJURY", CONV)],
  BATHROOM_SAFETY: [row("FUNCTIONAL_DEPENDENCE", CONV), row("SPINAL_CORD_INJURY", CONV)],
  ASSISTIVE_TECH: [row("FUNCTIONAL_DEPENDENCE", CONV), row("TBI_COGNITIVE", CONV), row("SPINAL_CORD_INJURY", CONV)],
  SUPPLIES: ANY,

  // ── Care & environment ────────────────────────────────────────────────────
  ATTENDANT_CARE: [row("FUNCTIONAL_DEPENDENCE", CONV), row("SPINAL_CORD_INJURY", CONV), row("TBI_COGNITIVE", CONV)],
  SKILLED_NURSING: [row("FUNCTIONAL_DEPENDENCE", CONV), row("SPINAL_CORD_INJURY", CONV)],
  HOME_MODIFICATION: [row("FUNCTIONAL_DEPENDENCE", CONV), row("SPINAL_CORD_INJURY", CONV)],
  TRANSPORTATION: [row("FUNCTIONAL_DEPENDENCE", CONV), row("SPINAL_CORD_INJURY", CONV), row("TBI_COGNITIVE", CONV)],
  CASE_MANAGEMENT: ANY,

  // ── Evaluation ────────────────────────────────────────────────────────────
  SPECIALIST_FOLLOWUP: ANY,
  PRIMARY_CARE: ANY,
  PSYCH_EVALUATION: [
    row("PSYCHIATRIC", g("icsi", "depression and anxiety in adults")),
    row("CHRONIC_PAIN", g("acoem", "chronic pain — psychological assessment")),
    row("TBI_COGNITIVE", g("acoem", "traumatic brain injury")),
  ],
  NEUROPSYCH_EVALUATION: [
    row("TBI_COGNITIVE", g("acoem", "traumatic brain injury")),
    row("PSYCHIATRIC", g("icsi", "depression and anxiety in adults")),
  ],
  FUNCTIONAL_CAPACITY_EVAL: ANY,
};

/** How much of the table has actually been checked against a publication. */
export function verificationSummary(): { total: number; verified: number; unverified: number; convention: number } {
  let verified = 0, unverified = 0, convention = 0;
  for (const v of Object.values(INDICATIONS)) {
    if (v === ANY || !v) continue;
    for (const r of v) {
      if (r.basis === "CONVENTION") convention++;
      else if (r.basis.status === "VERIFIED") verified++;
      else unverified++;
    }
  }
  return { total: verified + unverified + convention, verified, unverified, convention };
}

export type IndicationVerdict =
  /** A recognised indication for this intervention. */
  | "INDICATED"
  /** A real diagnosis in the case that this intervention is not offered for. */
  | "CONTEXT"
  /** A guideline recommends AGAINST this intervention for this diagnosis. */
  | "COUNTER_INDICATED"
  /**
   * A mapping exists but has not been checked against its publication.
   *
   * The verification gate covered the printed CITATION and not the VERDICT, so
   * an unchecked row still decided support and, worse, still produced a
   * counter-indication — a negative clinical claim asserted from a mapping
   * nobody had opened. I judged that direction "conservative" when I built it;
   * suppressing care on unverified authority is not conservative, it is the
   * same error pointed the other way.
   *
   * The mapping stays VISIBLE as a review candidate. Nothing is deleted, and
   * nothing is asserted.
   */
  | "REVIEW_REQUIRED"
  /** The intervention is legitimately non-specific. */
  | "NON_SPECIFIC"
  /** Nothing in the text resolved to a clinical concept. */
  | "UNCLASSIFIED";

export interface IndicationResult {
  verdict: IndicationVerdict;
  concepts: DiagnosisConcept[];
  /** The concepts that actually did the indicating, for disclosure. */
  matched: DiagnosisConcept[];
  /** The guideline that puts this diagnosis and this procedure in one document. */
  basis: IndicationBasis | "CONVENTION" | null;
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
  if (allowed === ANY) return { verdict: "NON_SPECIFIC", concepts, matched: [], basis: null };
  if (!concepts.length || !allowed) return { verdict: "UNCLASSIFIED", concepts, matched: [], basis: null };
  const hits = allowed.filter((r) => concepts.includes(r.concept));
  if (!hits.length) return { verdict: "CONTEXT", concepts, matched: [], basis: null };

  // A guideline that recommends AGAINST this pairing is the strongest thing the
  // table can say, and it must not be silently outvoted by another matching
  // row — but only a VERIFIED row may say it. An unchecked mapping suppressing
  // care is not caution.
  const against = hits.find((r) => r.basis !== "CONVENTION" && r.basis.direction === "AGAINST");
  if (against && against.basis !== "CONVENTION") {
    return against.basis.status === "VERIFIED"
      ? { verdict: "COUNTER_INDICATED", concepts, matched: [], basis: against.basis }
      : { verdict: "REVIEW_REQUIRED", concepts, matched: [], basis: against.basis };
  }

  const cited = hits.find((r) => r.basis !== "CONVENTION") ?? hits[0];
  const basis = cited.basis === "CONVENTION" ? ("CONVENTION" as const) : cited.basis;

  // AFFIRMATIVE direction requires verified authority. CONVENTION rows are
  // exempt: they claim no guideline, only established practice, and they say so.
  if (basis !== "CONVENTION" && basis.status !== "VERIFIED") {
    return { verdict: "REVIEW_REQUIRED", concepts, matched: hits.map((r) => r.concept), basis };
  }
  return { verdict: "INDICATED", concepts, matched: hits.map((r) => r.concept), basis };
}

/** May this diagnosis be presented as SUPPORT for this intervention? */
/**
 * May this diagnosis be presented as SUPPORT for this intervention?
 *
 * UNCLASSIFIED is deliberately NOT support. Failing open was meant to avoid
 * hiding a diagnosis the lexicon could not read, and it went one step too far:
 * "the engine cannot decide" was rendered as "this supports the care". Those
 * are different claims, and only one of them is true.
 *
 * The diagnosis is still SHOWN — as condition background, with the reason
 * saying the engine could not classify it. Nothing is hidden; nothing is
 * asserted either.
 */
export const diagnosisSupports = (diagnosisText: string, intervention: InterventionId): boolean => {
  const v = indicationFor(diagnosisText, intervention).verdict;
  // REVIEW_REQUIRED is deliberately absent: an unverified mapping is shown as
  // context for a reviewer, and does not carry the item.
  return v === "INDICATED" || v === "NON_SPECIFIC";
};

/**
 * May this indication be PRINTED as guideline authority?
 *
 * Only a VERIFIED row pointing the right way. Every row currently ships
 * UNVERIFIED, so nothing is cited as authority today — which is the honest
 * state, and the state the previous commit failed to enforce: it printed
 * "indication per AAOS clinical practice guidelines" from a mapping nobody had
 * checked against the publication.
 *
 * The mapping still does its job while unverified: it decides which diagnoses
 * READ as support and which read as background. What it may not do is borrow a
 * guideline's name for that decision.
 */
export const citableAsGuidelineAuthority = (basis: IndicationBasis | "CONVENTION" | null): basis is IndicationBasis =>
  !!basis && basis !== "CONVENTION" && basis.status === "VERIFIED" && basis.direction !== "AGAINST";

/** Why a diagnosis is shown as background rather than as support. */
export function contextReason(diagnosisText: string, intervention: InterventionId): string | null {
  const r = indicationFor(diagnosisText, intervention);
  if (r.verdict === "COUNTER_INDICATED" && r.basis && r.basis !== "CONVENTION") {
    // State the guideline's actual position. This is the one case where naming
    // the body is safe while unverified: the claim being made is that the
    // pairing is NOT endorsed, which is the conservative direction.
    return r.basis.position ?? "a clinical guideline recommends against this intervention for this diagnosis";
  }
  if (r.verdict === "REVIEW_REQUIRED") {
    const body = r.basis && r.basis !== "CONVENTION" ? `${r.basis.namedDiagnosis}` : "an unpublished mapping";
    return `a clinical mapping for this pairing (${body}) has not been verified against its publication — shown for review, not counted as support`;
  }
  if (r.verdict === "UNCLASSIFIED") {
    // Say which way the uncertainty runs. A reader must not read "the engine
    // could not classify this" as "this diagnosis is irrelevant".
    return "the engine could not classify this diagnosis against this service — shown for review, not counted as support";
  }
  if (r.verdict !== "CONTEXT") return null;
  const names = r.concepts.map((c) => c.replace(/_/g, " ").toLowerCase()).join(", ");
  return `documents ${names}, which is not an indication for this service`;
}
