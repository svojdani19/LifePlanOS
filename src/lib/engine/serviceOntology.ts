// ─────────────────────────────────────────────────────────────────────────────
// What procedure IS this, in clinical terms?
//
// Two jobs used service NAMES as identity and both were wrong for it:
//
//   • the gold harness matched a generated item to a published one by word
//     overlap (`shared / min(words) >= 0.7`), so "Lumbar epidural steroid
//     injection" and "Cervical epidural steroid injection" are a match at 0.75
//     while "TKA" and "Total knee arthroplasty" are not a match at all;
//
//   • the evidence gates classified services into six coarse families, so an
//     epidural, a medial-branch block, a radiofrequency ablation and a facet
//     injection were one kind of thing and shared each other's evidence.
//
// A canonical INTERVENTION id fixes both. It is deliberately finer than the
// family and deliberately coarser than the name: "LUMBAR_RFA" is one concept
// however a planner writes it, and it is not the same concept as "LUMBAR_MBB"
// however similar the words.
//
// The resolver is pattern-driven, which is unavoidable when the input is a
// free-text service name written by a human. What is NOT pattern-driven is
// everything downstream: indications, prerequisites and evidence compatibility
// are keyed to the resolved id, so a new spelling of an existing procedure
// inherits the clinical model rather than escaping it.
// ─────────────────────────────────────────────────────────────────────────────

import { bodyRegion, spineSubRegions, sideOf, type BodyRegion, type SpineSubRegion, type Side } from "@/lib/engine/integrity";

export type ServiceFamily =
  | "EVALUATION"
  | "IMAGING"
  | "DIAGNOSTIC_PROCEDURE"
  | "THERAPY"
  | "MEDICATION"
  | "INJECTION"
  | "SURGERY"
  | "EQUIPMENT"
  | "ATTENDANT_CARE"
  | "HOME_MODIFICATION"
  | "TRANSPORT_COORDINATION"
  | "LAB_MONITORING"
  | "COMPLICATION"
  | "OTHER";

/**
 * Canonical intervention identity. Coarser than a service name, finer than a
 * family — the level at which "is this indicated for this patient" is a
 * well-posed clinical question.
 */
export type InterventionId =
  // Evaluation & follow-up
  | "SPECIALIST_FOLLOWUP" | "PRIMARY_CARE" | "PSYCH_EVALUATION" | "NEUROPSYCH_EVALUATION"
  | "FUNCTIONAL_CAPACITY_EVAL" | "CASE_MANAGEMENT"
  // Imaging & electrodiagnostics
  | "MRI" | "CT" | "RADIOGRAPH" | "ULTRASOUND" | "EMG_NCS" | "IMAGING_SURVEILLANCE"
  // Therapy
  | "PHYSICAL_THERAPY" | "OCCUPATIONAL_THERAPY" | "SPEECH_THERAPY" | "COGNITIVE_THERAPY"
  | "PSYCHOTHERAPY" | "AQUATIC_THERAPY" | "FUNCTIONAL_RESTORATION" | "CHIROPRACTIC"
  // Medication
  | "OPIOID" | "NSAID" | "NEUROPATHIC_AGENT" | "MUSCLE_RELAXANT" | "TOPICAL_ANALGESIC"
  | "PSYCHOTROPIC" | "MEDICATION_OTHER" | "MEDICATION_MONITORING"
  // Injections & interventional pain
  | "EPIDURAL_STEROID" | "MEDIAL_BRANCH_BLOCK" | "FACET_INJECTION" | "RADIOFREQUENCY_ABLATION"
  | "SYMPATHETIC_BLOCK" | "JOINT_INJECTION" | "VISCOSUPPLEMENTATION" | "TRIGGER_POINT"
  | "PRP_INJECTION" | "INJECTION_GUIDANCE"
  // Surgery
  | "DISCECTOMY" | "LAMINECTOMY_DECOMPRESSION" | "SPINAL_FUSION" | "ARTHROPLASTY"
  | "REVISION_ARTHROPLASTY" | "ARTHROSCOPY" | "FRACTURE_FIXATION" | "HARDWARE_REMOVAL"
  | "SPINAL_CORD_STIMULATOR" | "PUMP_IMPLANT" | "SURGERY_OTHER"
  // Equipment & assistive technology
  | "ORTHOSIS_BRACE" | "MOBILITY_AID" | "WHEELCHAIR" | "TENS_UNIT" | "NMES_UNIT"
  | "HOSPITAL_BED" | "BATHROOM_SAFETY" | "PROSTHESIS" | "ASSISTIVE_TECH" | "SUPPLIES"
  // Care & environment
  | "ATTENDANT_CARE" | "SKILLED_NURSING" | "HOME_MODIFICATION" | "TRANSPORTATION"
  // Monitoring
  | "LAB_MONITORING"
  // Fallback
  | "UNCLASSIFIED";

export interface ResolvedIntervention {
  id: InterventionId;
  family: ServiceFamily;
  /** Anatomic scope parsed from the service name itself. */
  region: BodyRegion;
  spinalLevels: SpineSubRegion[];
  laterality: Side;
  /** True when the name says "each additional level/unit" — an add-on line. */
  addOn: boolean;
  /** How the id was reached, for audit. */
  matchedOn: string;
}

interface Rule { id: InterventionId; family: ServiceFamily; re: RegExp }

/**
 * Order matters: the most specific procedure wins. A medial-branch block must
 * be tested before the generic "block", and radiofrequency ablation before
 * either, because the words overlap and the clinical meanings do not.
 */
const RULES: Rule[] = [
  // ── Interventional pain, most specific first ──────────────────────────────
  { id: "RADIOFREQUENCY_ABLATION", family: "INJECTION", re: /\b(?:radiofrequency|rhizotom\w*|neurotom\w*|rfa|ablation\w*)\b/i },
  { id: "MEDIAL_BRANCH_BLOCK", family: "INJECTION", re: /\bmedial branch\b|\bmbb\b|diagnostic (?:facet|branch) block/i },
  { id: "FACET_INJECTION", family: "INJECTION", re: /\bfacet (?:joint )?(?:injection|block)s?\b|zygapophyseal/i },
  { id: "EPIDURAL_STEROID", family: "INJECTION", re: /\bepidurals?\b|transforaminal|interlaminar|\besi\b|caudal (?:steroid|injection)/i },
  { id: "SYMPATHETIC_BLOCK", family: "INJECTION", re: /\b(?:stellate|sympathetic|ganglion impar|celiac plexus)\b/i },
  { id: "VISCOSUPPLEMENTATION", family: "INJECTION", re: /viscosupplement\w*|hyaluron\w*/i },
  { id: "PRP_INJECTION", family: "INJECTION", re: /\b(?:prp|platelet[- ]rich|stem cell)\b/i },
  { id: "TRIGGER_POINT", family: "INJECTION", re: /\btrigger point\w*\b|\bbotulinum\b|\bbotox\b/i },
  { id: "INJECTION_GUIDANCE", family: "INJECTION", re: /\b(?:ultrasound|fluoroscop\w*|image)[- ]guidance\b|guidance for injection/i },
  { id: "JOINT_INJECTION", family: "INJECTION", re: /\b(?:joint|bursa|intra[- ]articular|subacromial)\s*(?:steroid\s*)?injection\w*/i },

  // ── Surgery ───────────────────────────────────────────────────────────────
  { id: "REVISION_ARTHROPLASTY", family: "SURGERY", re: /\brevision\b.*\b(?:arthroplast\w*|replacement\w*)\b|\b(?:arthroplast\w*|replacement\w*)\b.*\brevision\b/i },
  { id: "ARTHROPLASTY", family: "SURGERY", re: /\b(?:arthroplast\w*|joint replacement\w*|tka|tha|hemiarthroplast\w*)\b/i },
  { id: "SPINAL_FUSION", family: "SURGERY", re: /\b(?:fusion\w*|arthrodesis|tlif|plif|alif|instrumentation)\b/i },
  { id: "DISCECTOMY", family: "SURGERY", re: /\bmicro-?disc?ectom\w*|\bdisc?ectom\w*/i },
  { id: "LAMINECTOMY_DECOMPRESSION", family: "SURGERY", re: /\b(?:laminectom\w*|laminotom\w*|foraminotom\w*|decompression\w*)\b/i },
  { id: "SPINAL_CORD_STIMULATOR", family: "SURGERY", re: /\b(?:spinal cord stimulator\w*|scs|dorsal column)\b|neurostimulat\w*/i },
  { id: "PUMP_IMPLANT", family: "SURGERY", re: /\b(?:intrathecal|pain pump|baclofen pump|drug delivery system)\b/i },
  { id: "HARDWARE_REMOVAL", family: "SURGERY", re: /\bhardware removal\b|removal of (?:hardware|implant\w*)/i },
  { id: "FRACTURE_FIXATION", family: "SURGERY", re: /\b(?:orif|open reduction|fracture fixation|internal fixation)\b/i },
  { id: "ARTHROSCOPY", family: "SURGERY", re: /arthroscop\w*|meniscectom\w*|rotator cuff repair|labral repair/i },

  // ── Imaging & electrodiagnostics ──────────────────────────────────────────
  { id: "EMG_NCS", family: "DIAGNOSTIC_PROCEDURE", re: /\b(?:emg|ncv|ncs)\b|electromyograph\w*|nerve conduction/i },
  { id: "IMAGING_SURVEILLANCE", family: "IMAGING", re: /\bsurveillance\b/i },
  { id: "MRI", family: "IMAGING", re: /\bmri\b|magnetic resonance/i },
  { id: "CT", family: "IMAGING", re: /\bct\b|computed tomograph\w*|\bcat scan\b/i },
  { id: "ULTRASOUND", family: "IMAGING", re: /\bultrasound\w*\b|sonograph\w*/i },
  { id: "RADIOGRAPH", family: "IMAGING", re: /\b(?:x-?rays?|radiograph\w*|plain films?)\b/i },

  // ── Therapy ───────────────────────────────────────────────────────────────
  { id: "FUNCTIONAL_RESTORATION", family: "THERAPY", re: /\bfunctional restoration\b|work hardening|work conditioning|chronic pain program/i },
  { id: "AQUATIC_THERAPY", family: "THERAPY", re: /\baquatic\w*|pool therap\w*|hydrotherap\w*/i },
  { id: "COGNITIVE_THERAPY", family: "THERAPY", re: /\bcognitive (?:therap\w*|rehab\w*|remediation)|speech[- ]cognitive/i },
  { id: "SPEECH_THERAPY", family: "THERAPY", re: /\bspeech\b|language patholog\w*|\bslp\b|swallow\w*/i },
  { id: "OCCUPATIONAL_THERAPY", family: "THERAPY", re: /\boccupational therap\w*|\bot\b/i },
  { id: "PSYCHOTHERAPY", family: "THERAPY", re: /psychotherap\w*|counsel\w*|pain psycholog\w*|behavioral health|\bcbt\b/i },
  { id: "CHIROPRACTIC", family: "THERAPY", re: /chiropract\w*|manipulation therap\w*/i },
  { id: "PHYSICAL_THERAPY", family: "THERAPY", re: /\bphysical therap\w*|\bpt\b|physiotherap\w*|therapeutic exercise|\btherap\w*\b/i },

  // ── Medication ────────────────────────────────────────────────────────────
  { id: "MEDICATION_MONITORING", family: "LAB_MONITORING", re: /\b(?:medication (?:monitoring|management)|drug screen\w*|toxicolog\w*|opioid monitoring)\b/i },
  { id: "OPIOID", family: "MEDICATION", re: /\b(?:oxycodone|hydrocodone|morphine|fentanyl|tramadol|codeine|hydromorphone|methadone|opioids?|percocet|norco)\b/i },
  { id: "NEUROPATHIC_AGENT", family: "MEDICATION", re: /\b(?:gabapentin|pregabalin|lyrica|neurontin|duloxetine|amitriptyline|nortriptyline)\b/i },
  { id: "MUSCLE_RELAXANT", family: "MEDICATION", re: /\b(?:cyclobenzaprine|methocarbamol|tizanidine|baclofen|robaxin|flexeril|muscle relaxants?)\b/i },
  { id: "NSAID", family: "MEDICATION", re: /\b(?:ibuprofen|naproxen|meloxicam|celecoxib|diclofenac|nsaids?|acetaminophen|tylenol)\b/i },
  { id: "TOPICAL_ANALGESIC", family: "MEDICATION", re: /\b(?:lidocaine|topical|patch\w*|capsaicin)\b|voltaren/i },
  { id: "PSYCHOTROPIC", family: "MEDICATION", re: /\b(?:sertraline|fluoxetine|escitalopram|bupropion|trazodone|antidepressant\w*|anxiolytic\w*)\b/i },

  // ── Equipment ─────────────────────────────────────────────────────────────
  { id: "TENS_UNIT", family: "EQUIPMENT", re: /\btens\b|transcutaneous electrical/i },
  { id: "NMES_UNIT", family: "EQUIPMENT", re: /\bnmes\b|neuromuscular stimulat\w*|electrical stimulat\w*/i },
  { id: "WHEELCHAIR", family: "EQUIPMENT", re: /wheelchair\w*|power chair\w*|\bscooter\w*\b/i },
  { id: "MOBILITY_AID", family: "EQUIPMENT", re: /\b(?:walkers?|rollators?|canes?|crutch\w*)\b/i },
  { id: "ORTHOSIS_BRACE", family: "EQUIPMENT", re: /\b(?:braces?|orthosis|orthoses|orthotics?|lso|tlso|collars?|splints?)\b/i },
  { id: "PROSTHESIS", family: "EQUIPMENT", re: /prosthe\w*/i },
  { id: "HOSPITAL_BED", family: "EQUIPMENT", re: /\b(?:hospital beds?|lift chairs?|patient lifts?|hoyer)\b/i },
  { id: "BATHROOM_SAFETY", family: "EQUIPMENT", re: /\b(?:shower chairs?|grab bars?|commodes?|tub bench\w*|toilet riser\w*)\b/i },
  { id: "ASSISTIVE_TECH", family: "EQUIPMENT", re: /assistive technolog\w*|communication devices?|environmental control\w*/i },
  { id: "SUPPLIES", family: "EQUIPMENT", re: /\bsupplies\b|\belectrodes?\b|\bconsumables?\b/i },

  // ── Care, environment, coordination ───────────────────────────────────────
  { id: "SKILLED_NURSING", family: "ATTENDANT_CARE", re: /skilled nursing|\b(?:rn|lpn)\b|nursing (?:care|visits?)/i },
  { id: "ATTENDANT_CARE", family: "ATTENDANT_CARE", re: /\b(?:attendant\w*|home health aides?|personal care|caregivers?|companion care|home care)\b/i },
  { id: "HOME_MODIFICATION", family: "HOME_MODIFICATION", re: /home modification\w*|\bramps?\b|stair lift\w*|widening|accessib\w*/i },
  { id: "TRANSPORTATION", family: "TRANSPORT_COORDINATION", re: /transportation|\bmileage\b|medical transport\w*|vehicle modification\w*/i },
  { id: "CASE_MANAGEMENT", family: "TRANSPORT_COORDINATION", re: /case management|care coordination|life care planner/i },

  // ── Evaluation & monitoring ───────────────────────────────────────────────
  { id: "NEUROPSYCH_EVALUATION", family: "EVALUATION", re: /neuropsycholog\w*/i },
  { id: "PSYCH_EVALUATION", family: "EVALUATION", re: /\b(?:psychiatr\w*|psycholog\w*)\s*(?:evaluation\w*|visits?|consult\w*|follow)/i },
  { id: "FUNCTIONAL_CAPACITY_EVAL", family: "EVALUATION", re: /functional capacity|\bfce\b/i },
  { id: "LAB_MONITORING", family: "LAB_MONITORING", re: /metabolic (?:panel|profile)|\bcbc\b|lab(?:oratory)? (?:work|monitoring|panel)|blood work/i },
  { id: "PRIMARY_CARE", family: "EVALUATION", re: /primary care|family (?:medicine|practice)|internist|\bpcp\b/i },
  { id: "SPECIALIST_FOLLOWUP", family: "EVALUATION", re: /\bfollow[- ]?ups?\b|office visits?|consultations?|evaluations?|management visits?|surveillance visits?/i },
];

const ADD_ON = /\beach additional\b|\badd[- ]on\b|\badditional (?:level|joint|unit)\b/i;

/**
 * Resolve a free-text service to a canonical intervention.
 *
 * `category` is consulted only to disambiguate when the name alone is silent —
 * the name is the better signal, because the category vocabulary is coarse and
 * has historically been assigned inconsistently.
 */
export function resolveIntervention(item: { service: string; category?: string | null }): ResolvedIntervention {
  const name = String(item.service ?? "");
  const hay = `${name} ${item.category ?? ""}`;
  let hit: Rule | undefined;
  for (const r of RULES) {
    if (r.re.test(name)) { hit = r; break; }
  }
  if (!hit) for (const r of RULES) {
    if (r.re.test(hay)) { hit = r; break; }
  }
  return {
    id: hit?.id ?? "UNCLASSIFIED",
    family: hit?.family ?? familyFromCategory(item.category) ?? "OTHER",
    region: bodyRegion(name),
    spinalLevels: spineSubRegions(name),
    laterality: sideOf(name),
    addOn: ADD_ON.test(name),
    matchedOn: hit ? hit.id : "category-fallback",
  };
}

const CATEGORY_FAMILY: Record<string, ServiceFamily> = {
  IMAGING: "IMAGING", LABS: "LAB_MONITORING",
  ORTHOPEDIC_SURGERY: "SURGERY", NEUROSURGERY: "SURGERY", FUTURE_SURGERY: "SURGERY", REVISION_SURGERY: "SURGERY",
  INJECTION: "INJECTION", PAIN_MANAGEMENT: "INJECTION",
  PHYSICAL_THERAPY: "THERAPY", OCCUPATIONAL_THERAPY: "THERAPY", SPEECH_THERAPY: "THERAPY", COGNITIVE_THERAPY: "THERAPY", PSYCH: "THERAPY",
  MEDICATION: "MEDICATION",
  PHYSICIAN_VISIT: "EVALUATION", SPECIALIST_VISIT: "EVALUATION", PRIMARY_CARE: "EVALUATION", NEUROLOGY: "EVALUATION", PMR: "EVALUATION",
  DME: "EQUIPMENT", MOBILITY_AID: "EQUIPMENT", ORTHOTICS_PROSTHETICS: "EQUIPMENT",
  HOME_MODIFICATION: "HOME_MODIFICATION",
  ATTENDANT_CARE: "ATTENDANT_CARE", SKILLED_NURSING: "ATTENDANT_CARE",
};
const familyFromCategory = (c?: string | null): ServiceFamily | undefined => CATEGORY_FAMILY[String(c ?? "").toUpperCase()];

/**
 * Do two service descriptions denote the SAME intervention on the SAME anatomy?
 *
 * This is what replaces word overlap in the gold matcher. Add-on lines ("each
 * additional level") are treated as the same intervention as their base, which
 * is how a planner who wrote one line and a generator that wrote two should be
 * reconciled — see `bundleKey`.
 */
export function sameIntervention(a: { service: string; category?: string | null }, b: { service: string; category?: string | null }): boolean {
  const ra = resolveIntervention(a);
  const rb = resolveIntervention(b);
  if (ra.id === "UNCLASSIFIED" || rb.id === "UNCLASSIFIED") return false;
  if (ra.id !== rb.id) return false;
  if (ra.region !== "general" && rb.region !== "general" && ra.region !== rb.region) return false;
  if (ra.spinalLevels.length && rb.spinalLevels.length && !ra.spinalLevels.some((l) => rb.spinalLevels.includes(l))) return false;
  const bothSided = ra.laterality !== "unstated" && rb.laterality !== "unstated";
  if (bothSided && ra.laterality !== "bilateral" && rb.laterality !== "bilateral" && ra.laterality !== rb.laterality) return false;
  return true;
}

/**
 * The key under which split lines collapse into one published concept.
 *
 * A planner writes "lumbar radiofrequency ablation" once; the generator may
 * emit a base line and an "each additional level" line. Scoring those as one
 * hit and one false positive would be wrong in both directions.
 */
export function bundleKey(item: { service: string; category?: string | null }): string {
  const r = resolveIntervention(item);
  return [r.id, r.region, r.spinalLevels.slice().sort().join("+") || "-", r.laterality].join("|");
}
