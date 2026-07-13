// ─────────────────────────────────────────────────────────────────────────────
// Specialty-specific clinical reasoning (Clinical Intelligence Sprint).
//
// A Future Care recommendation should read as though the physician of the
// responsible SPECIALTY wrote it — a pain physician reasons about medication
// optimization and functional preservation; an orthopedic surgeon about implant
// surveillance and revision risk; a physiatrist about restoration of function.
// This module supplies each specialty's lens: opening frames (varied so no two
// sections start alike), the forward-looking clinical concern, and the clinical
// goal. The narrative builder weaves these so generic wording never repeats
// across specialties.
//
// Pure and deterministic; unit-tested.
// ─────────────────────────────────────────────────────────────────────────────

export interface SpecialtyLens {
  /** how the specialty refers to itself, e.g. "pain management", "physiatry (PM&R)" */
  label: string;
  /** varied opening frames written in that specialty's voice */
  frames: string[];
  /** the specialty's forward-looking clinical concern (what it watches for) */
  concern: string;
  /** the clinical objective this care serves */
  goal: string;
}

type Def = SpecialtyLens & { cats: string[]; svc?: RegExp };

// Ordered most-specific first; service keywords override category when present.
const LENSES: Def[] = [
  {
    label: "urology",
    cats: [],
    svc: /\b(bladder|urolog|neurogenic|catheter|urodynamic|renal|incontinen)\b/i,
    frames: ["From a urologic standpoint", "In terms of lower-urinary-tract function"],
    concern: "neurogenic bladder progression, renal protection, and prevention of recurrent infection",
    goal: "preserving renal function and bladder management",
  },
  {
    label: "pain management",
    cats: ["PAIN_MANAGEMENT", "INJECTION", "MEDICATION"],
    frames: ["From a pain-management standpoint", "In the longitudinal management of chronic pain", "Managing pain of this chronicity"],
    concern: "medication optimization, opioid stewardship, and interventional options as conservative measures are exhausted",
    goal: "durable symptom control and preservation of function",
  },
  {
    label: "physiatry (PM&R)",
    cats: ["PMR"],
    frames: ["From a physiatric standpoint", "Approached as a problem of function rather than of a single structure", "In rehabilitative terms"],
    concern: "restoration of function, adaptive strategy, and prevention of secondary disability",
    goal: "maximizing independence and consolidating neurologic recovery",
  },
  {
    label: "spine surgery",
    cats: ["NEUROSURGERY"],
    frames: ["From a spine-surgical standpoint", "Given the structural spinal injury", "In neurosurgical terms"],
    concern: "neurologic deterioration, segmental instability, fusion status, and adjacent-segment disease",
    goal: "protecting neurologic function and spinal stability",
  },
  {
    label: "orthopedic surgery",
    cats: ["ORTHOPEDIC_SURGERY", "REVISION_SURGERY", "FUTURE_SURGERY", "ORTHOTICS_PROSTHETICS"],
    frames: ["From an orthopedic surgical standpoint", "Following a joint injury of this severity", "In orthopedic terms"],
    concern: "surveillance for post-traumatic arthritis, hardware complication, and mechanical failure with its attendant revision risk",
    goal: "preserving the joint and anticipating predictable degeneration",
  },
  {
    label: "neurology",
    cats: ["NEUROLOGY"],
    frames: ["From a neurologic standpoint", "Tracking the neurologic course", "In neurologic terms"],
    concern: "evolving neurologic deficit, neuropathic symptoms, and electrodiagnostic monitoring",
    goal: "characterizing and following the neurologic injury over time",
  },
  {
    label: "rehabilitation",
    cats: ["PHYSICAL_THERAPY", "OCCUPATIONAL_THERAPY", "SPEECH_THERAPY"],
    frames: ["From a rehabilitation standpoint", "In therapy terms", "Approaching this functionally"],
    concern: "restoring strength, range, and gait, and consolidating gains against regression",
    goal: "measurable functional gain and its maintenance",
  },
  {
    label: "neuropsychology",
    cats: ["PSYCH", "COGNITIVE_THERAPY"],
    frames: ["From a neuropsychological standpoint", "In cognitive and behavioral terms"],
    concern: "cognitive and mood sequelae, compensatory strategy, and functional carryover",
    goal: "cognitive stabilization and adaptation to persisting deficits",
  },
  {
    label: "rehabilitation / assistive technology",
    cats: ["DME", "MOBILITY_AID", "ASSISTIVE_TECH", "HOME_MODIFICATION", "VEHICLE_MODIFICATION"],
    frames: ["From a functional standpoint", "In terms of daily function and safety", "Considering mobility and independence"],
    concern: "safe mobility, fall risk, and the equipment lifecycle as function changes",
    goal: "safe independence in the home and community",
  },
  {
    label: "attendant / nursing care",
    cats: ["ATTENDANT_CARE", "SKILLED_NURSING"],
    frames: ["From a care-needs standpoint", "In terms of daily support requirements"],
    concern: "dependence in activities of daily living and the level of assistance required",
    goal: "safe support for the activities the injury has compromised",
  },
  {
    label: "diagnostic surveillance",
    cats: ["IMAGING", "LABS"],
    frames: ["For ongoing surveillance", "As a monitoring measure"],
    concern: "detecting progression or complication before it becomes symptomatic",
    goal: "timely detection so intervention is not delayed",
  },
  {
    label: "primary care",
    cats: ["PRIMARY_CARE", "PHYSICIAN_VISIT", "CASE_MANAGEMENT", "SPECIALIST_VISIT"],
    frames: ["From a primary-care standpoint", "In terms of longitudinal oversight"],
    concern: "care coordination, chronic-disease interaction, and medication safety",
    goal: "coordinated oversight and preventive management",
  },
];

const DEFAULT_LENS: SpecialtyLens = {
  label: "treating specialty",
  frames: ["On the treating record", "Clinically"],
  concern: "the anticipated course of this condition",
  goal: "addressing the documented sequelae of the injury",
};

/** The clinical lens for a recommendation, from its care category (service
 *  keywords, e.g. a urologic service, take precedence). */
export function specialtyLens(category: string | null | undefined, service: string): SpecialtyLens {
  const bySvc = LENSES.find((l) => l.svc?.test(service));
  if (bySvc) return bySvc;
  const c = (category ?? "").toUpperCase();
  const byCat = LENSES.find((l) => l.cats.includes(c));
  return byCat ?? DEFAULT_LENS;
}
