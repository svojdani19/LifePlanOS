import type { CareCategory, InjurySpecialty, Probability, Relatedness, Vulnerability } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Specialty-specific recommendation library (Module 7 + the data-moat seed for
// Module 16). Each specialty contributes conditions, a chronology skeleton, and
// future-care templates. Probability/vulnerability/evidence are set honestly:
// speculative items are labeled speculative, and items without strong literature
// say so and require physician confirmation (AI guardrails, Module 18).
// ─────────────────────────────────────────────────────────────────────────────

export interface CareTemplate {
  category: CareCategory;
  service: string;
  specialty: string;
  rationale: string;
  cptCode?: string; // specific CPT/HCPCS when the item warrants it
  probability: Probability;
  frequencyPerYear: number;
  durationYears?: number | null;
  isLifetime?: boolean;
  unitCost?: number; // override the reference cost when the case warrants
  evidenceStrength: string;
  literatureSupport: string;
  defenseVulnerability: Vulnerability;
  lowerCostAlternative?: string;
  confidence: number; // 0–100
}

export interface ConditionTemplate {
  name: string;
  relatedness: Relatedness;
  confidence: number;
  reasoning: string;
  objectiveEvidence: string;
}

export interface ChronoTemplate {
  dayOffset: number; // days from date of injury
  provider: string;
  specialty: string;
  recordType: string;
  summary: string;
  objectiveFindings?: string;
  diagnosis?: string;
  treatment?: string;
  imagingFindings?: string;
  relevanceScore: number;
}

export interface SpecialtyPack {
  conditions: ConditionTemplate[];
  chronology: ChronoTemplate[];
  care: CareTemplate[];
}

// Baseline items every catastrophic/serious case tends to include.
const GENERAL_CARE: CareTemplate[] = [
  {
    category: "PRIMARY_CARE",
    service: "Primary care coordination visits",
    specialty: "Family Medicine",
    rationale: "Ongoing management of injury-related comorbidities and medication oversight.",
    probability: "PROBABLE",
    frequencyPerYear: 3,
    isLifetime: true,
    evidenceStrength: "Guideline-supported (chronic disease management)",
    literatureSupport: "Consistent with standard chronic-care follow-up cadence.",
    defenseVulnerability: "LOW",
    confidence: 80,
  },
  {
    category: "CASE_MANAGEMENT",
    service: "RN medical case management",
    specialty: "Nurse Case Manager",
    rationale: "Coordination of complex multi-provider care and equipment.",
    probability: "POSSIBLE",
    frequencyPerYear: 1,
    durationYears: 5,
    evidenceStrength: "Limited literature — physician confirmation required",
    literatureSupport: "Support is case-specific; not established for all injuries.",
    defenseVulnerability: "MODERATE",
    lowerCostAlternative: "Intermittent coordination via treating provider staff.",
    confidence: 55,
  },
];

const PACKS: Partial<Record<InjurySpecialty, SpecialtyPack>> = {
  KNEE_ARTHROPLASTY: {
    conditions: [
      {
        name: "Post-traumatic osteoarthritis, affected knee",
        relatedness: "RELATED",
        confidence: 82,
        reasoning: "Intra-articular fracture pattern with documented articular incongruity progresses to arthritis.",
        objectiveEvidence: "Radiographs showing joint space narrowing; operative note documenting chondral damage.",
      },
      {
        name: "Total knee arthroplasty, status post / anticipated",
        relatedness: "RELATED",
        confidence: 70,
        reasoning: "Degenerative progression of post-traumatic arthritis commonly necessitates arthroplasty.",
        objectiveEvidence: "Serial imaging; failed conservative management noted in records.",
      },
    ],
    chronology: [
      { dayOffset: 0, provider: "ED — Regional Medical Center", specialty: "Emergency", recordType: "ED note", summary: "Presentation after mechanism with knee pain and deformity.", objectiveFindings: "Effusion, limited ROM, tenderness.", imagingFindings: "Comminuted tibial plateau fracture.", diagnosis: "Tibial plateau fracture", relevanceScore: 90 },
      { dayOffset: 3, provider: "Dr. Ortho — Orthopedic Surgery", specialty: "Orthopedics", recordType: "Operative report", summary: "ORIF of tibial plateau fracture.", treatment: "Open reduction internal fixation.", relevanceScore: 95 },
      { dayOffset: 120, provider: "Ortho Clinic", specialty: "Orthopedics", recordType: "Follow-up", summary: "Persistent pain, early joint space narrowing.", imagingFindings: "Post-traumatic arthritic change.", relevanceScore: 80 },
    ],
    care: [
      {
        category: "ORTHOPEDIC_SURGERY",
        service: "Primary total knee arthroplasty",
        specialty: "Orthopedic Surgery",
        rationale: "End-stage post-traumatic arthritis failing conservative care.",
        probability: "PROBABLE",
        frequencyPerYear: 1,
        durationYears: 1,
        evidenceStrength: "Guideline-supported (AAOS)",
        literatureSupport: "AAOS clinical practice guidance on end-stage knee OA.",
        defenseVulnerability: "LOW",
        confidence: 78,
      },
      {
        category: "REVISION_SURGERY",
        service: "Revision knee arthroplasty (one anticipated)",
        specialty: "Orthopedic Surgery",
        rationale: "Prosthesis lifespan shorter than remaining life expectancy for a younger patient.",
        probability: "POSSIBLE",
        frequencyPerYear: 1,
        durationYears: 1,
        evidenceStrength: "Registry-supported revision rates",
        literatureSupport: "Joint registry data on implant survivorship informs revision probability.",
        defenseVulnerability: "MODERATE",
        lowerCostAlternative: "Defer until clinically indicated; surveillance only.",
        confidence: 60,
      },
      {
        category: "PHYSICAL_THERAPY",
        service: "Post-operative physical therapy course",
        specialty: "Physical Therapy",
        rationale: "Rehabilitation following arthroplasty to restore function.",
        probability: "PROBABLE",
        frequencyPerYear: 24,
        durationYears: 1,
        evidenceStrength: "Guideline-supported",
        literatureSupport: "Standard post-arthroplasty rehab protocols.",
        defenseVulnerability: "LOW",
        confidence: 82,
      },
      {
        category: "IMAGING",
        service: "Implant surveillance radiographs",
        specialty: "Orthopedics",
        rationale: "Periodic monitoring for loosening/wear.",
        probability: "PROBABLE",
        frequencyPerYear: 0.5,
        isLifetime: true,
        evidenceStrength: "Guideline-supported surveillance",
        literatureSupport: "Routine arthroplasty surveillance imaging.",
        defenseVulnerability: "LOW",
        confidence: 76,
      },
      {
        category: "PAIN_MANAGEMENT",
        service: "Pain management follow-up",
        specialty: "Pain Management",
        rationale: "Management of chronic post-traumatic knee pain.",
        probability: "POSSIBLE",
        frequencyPerYear: 4,
        durationYears: 10,
        evidenceStrength: "Case-specific",
        literatureSupport: "Support depends on documented ongoing pain; confirmation required.",
        defenseVulnerability: "MODERATE",
        confidence: 58,
      },
    ],
  },

  SPINE: {
    conditions: [
      {
        name: "Lumbar burst fracture with residual deficit",
        relatedness: "RELATED",
        confidence: 85,
        reasoning: "High-energy mechanism with imaging-confirmed burst fracture.",
        objectiveEvidence: "CT/MRI demonstrating burst morphology and canal compromise.",
      },
      {
        name: "Neurogenic bladder (incomplete)",
        relatedness: "AGGRAVATION",
        confidence: 55,
        reasoning: "May be multifactorial; requires urology/physiatry confirmation.",
        objectiveEvidence: "Urodynamics pending in records.",
      },
    ],
    chronology: [
      { dayOffset: 0, provider: "Trauma Center", specialty: "Trauma", recordType: "Admission", summary: "Polytrauma with back pain and lower-extremity weakness.", imagingFindings: "L1 burst fracture, canal compromise.", diagnosis: "L1 burst fracture", relevanceScore: 95 },
      { dayOffset: 2, provider: "Neurosurgery", specialty: "Neurosurgery", recordType: "Operative report", summary: "Posterior decompression and instrumented fusion.", treatment: "T12–L2 fusion.", relevanceScore: 96 },
    ],
    care: [
      {
        category: "NEUROSURGERY",
        service: "Hardware removal / adjacent-segment evaluation",
        specialty: "Neurosurgery",
        rationale: "Possible future hardware-related revision or adjacent segment disease.",
        probability: "POSSIBLE",
        frequencyPerYear: 1,
        durationYears: 1,
        evidenceStrength: "Registry-supported adjacent-segment rates",
        literatureSupport: "Adjacent-segment degeneration literature after lumbar fusion.",
        defenseVulnerability: "MODERATE",
        confidence: 55,
      },
      {
        category: "PHYSICAL_THERAPY",
        service: "Ongoing physical therapy",
        specialty: "Physical Therapy",
        rationale: "Maintenance of strength and function with residual deficit.",
        probability: "PROBABLE",
        frequencyPerYear: 20,
        durationYears: 5,
        evidenceStrength: "Guideline-supported",
        literatureSupport: "Rehabilitation after spinal injury.",
        defenseVulnerability: "LOW",
        confidence: 74,
      },
      {
        category: "DME",
        service: "Assistive devices and bracing",
        specialty: "PM&R",
        rationale: "Mobility and stability support with residual deficit.",
        probability: "PROBABLE",
        frequencyPerYear: 0.2,
        isLifetime: true,
        evidenceStrength: "Case-specific",
        literatureSupport: "Dependent on functional status documented by treating physiatrist.",
        defenseVulnerability: "MODERATE",
        confidence: 62,
      },
      {
        category: "PAIN_MANAGEMENT",
        service: "Interventional pain management",
        specialty: "Pain Management",
        rationale: "Chronic post-surgical/neuropathic pain management.",
        probability: "POSSIBLE",
        frequencyPerYear: 4,
        durationYears: 10,
        evidenceStrength: "Case-specific",
        literatureSupport: "Support contingent on documented chronic pain.",
        defenseVulnerability: "MODERATE",
        confidence: 57,
      },
    ],
  },

  AMPUTATION: {
    conditions: [
      {
        name: "Transtibial amputation",
        relatedness: "RELATED",
        confidence: 95,
        reasoning: "Traumatic amputation directly attributable to mechanism.",
        objectiveEvidence: "Operative report; post-op imaging.",
      },
      {
        name: "Phantom limb / residual limb pain",
        relatedness: "RELATED",
        confidence: 78,
        reasoning: "Common sequela of traumatic amputation.",
        objectiveEvidence: "Pain documentation in follow-up notes.",
      },
    ],
    chronology: [
      { dayOffset: 0, provider: "Trauma Center", specialty: "Trauma", recordType: "Operative report", summary: "Traumatic below-knee amputation, completion surgery.", treatment: "Guillotine then formal transtibial amputation.", relevanceScore: 98 },
      { dayOffset: 90, provider: "Prosthetics Clinic", specialty: "Prosthetics", recordType: "Fitting", summary: "Initial prosthesis fitting and gait training.", relevanceScore: 88 },
    ],
    care: [
      {
        category: "ORTHOTICS_PROSTHETICS",
        service: "Prosthesis replacement (every 3–5 years)",
        specialty: "Prosthetics",
        rationale: "Prostheses require periodic replacement over the lifespan.",
        probability: "PROBABLE",
        frequencyPerYear: 0.25,
        isLifetime: true,
        evidenceStrength: "Guideline-supported replacement schedule",
        literatureSupport: "Established prosthetic component replacement intervals.",
        defenseVulnerability: "LOW",
        confidence: 85,
      },
      {
        category: "SUPPLIES",
        service: "Prosthetic liners, socks, and supplies",
        specialty: "Prosthetics",
        rationale: "Consumable prosthetic components replaced routinely.",
        probability: "PROBABLE",
        frequencyPerYear: 1,
        isLifetime: true,
        evidenceStrength: "Guideline-supported",
        literatureSupport: "Standard consumable schedules.",
        defenseVulnerability: "LOW",
        confidence: 84,
      },
      {
        category: "PHYSICAL_THERAPY",
        service: "Gait training and periodic PT",
        specialty: "Physical Therapy",
        rationale: "Adaptation to new/replacement prostheses.",
        probability: "PROBABLE",
        frequencyPerYear: 8,
        isLifetime: true,
        evidenceStrength: "Guideline-supported",
        literatureSupport: "Prosthetic rehabilitation literature.",
        defenseVulnerability: "LOW",
        confidence: 80,
      },
      {
        category: "PSYCH",
        service: "Adjustment counseling",
        specialty: "Psychology",
        rationale: "Psychological adjustment to limb loss.",
        probability: "POSSIBLE",
        frequencyPerYear: 12,
        durationYears: 2,
        evidenceStrength: "Case-specific",
        literatureSupport: "Support depends on documented adjustment difficulties.",
        defenseVulnerability: "MODERATE",
        confidence: 60,
      },
    ],
  },

  TBI: {
    conditions: [
      {
        name: "Severe traumatic brain injury with cognitive sequelae",
        relatedness: "RELATED",
        confidence: 88,
        reasoning: "Imaging and neurocognitive testing confirm injury and deficits.",
        objectiveEvidence: "CT/MRI findings; neuropsychological evaluation.",
      },
      {
        name: "Spastic quadriparesis",
        relatedness: "RELATED",
        confidence: 80,
        reasoning: "Motor sequelae of severe anoxic/traumatic brain injury.",
        objectiveEvidence: "Physiatry exam; tone documentation.",
      },
    ],
    chronology: [
      { dayOffset: 0, provider: "Trauma/ICU", specialty: "Critical Care", recordType: "Admission", summary: "Severe TBI, intubated, ICP monitoring.", imagingFindings: "Diffuse axonal injury.", diagnosis: "Severe TBI", relevanceScore: 98 },
      { dayOffset: 45, provider: "Inpatient Rehab", specialty: "PM&R", recordType: "Rehab summary", summary: "Acute inpatient rehabilitation, moderate assistance.", relevanceScore: 90 },
    ],
    care: [
      {
        category: "ATTENDANT_CARE",
        service: "Attendant / home care (hours per treating physiatrist)",
        specialty: "PM&R",
        rationale: "Assistance with ADLs given functional dependence.",
        probability: "PROBABLE",
        frequencyPerYear: 1,
        isLifetime: true,
        evidenceStrength: "Case-specific — physiatry hours required",
        literatureSupport: "Level of support must be set by treating physiatrist.",
        defenseVulnerability: "HIGH",
        lowerCostAlternative: "Family-provided care with intermittent skilled visits.",
        confidence: 65,
      },
      {
        category: "COGNITIVE_THERAPY",
        service: "Cognitive rehabilitation",
        specialty: "Neuropsychology",
        rationale: "Remediation of cognitive deficits.",
        probability: "PROBABLE",
        frequencyPerYear: 24,
        durationYears: 3,
        evidenceStrength: "Guideline-supported (early phase)",
        literatureSupport: "Cognitive rehab evidence strongest in first years post-injury.",
        defenseVulnerability: "MODERATE",
        confidence: 68,
      },
      {
        category: "NEUROLOGY",
        service: "Neurology / seizure management",
        specialty: "Neurology",
        rationale: "Post-traumatic seizure risk monitoring.",
        probability: "POSSIBLE",
        frequencyPerYear: 2,
        isLifetime: true,
        evidenceStrength: "Risk-based",
        literatureSupport: "Post-traumatic epilepsy risk literature.",
        defenseVulnerability: "MODERATE",
        confidence: 58,
      },
      {
        category: "MEDICATION",
        service: "Antispasticity and neuro medications",
        specialty: "PM&R",
        rationale: "Management of spasticity and neurologic symptoms.",
        probability: "PROBABLE",
        frequencyPerYear: 1,
        isLifetime: true,
        evidenceStrength: "Guideline-supported",
        literatureSupport: "Standard spasticity pharmacotherapy.",
        defenseVulnerability: "LOW",
        confidence: 75,
      },
    ],
  },
};

// Map free-text/enum to a pack, with keyword inference as a fallback.
export function resolveSpecialty(specialty: InjurySpecialty, diagnosis?: string | null): InjurySpecialty {
  if (specialty && specialty !== "GENERAL") return specialty;
  const d = (diagnosis ?? "").toLowerCase();
  if (/ampu/.test(d)) return "AMPUTATION";
  if (/tbi|brain|anoxic/.test(d)) return "TBI";
  if (/spine|burst|fusion|vertebr|lumbar|cervical/.test(d)) return "SPINE";
  if (/knee|tibial plateau|tka/.test(d)) return "KNEE_ARTHROPLASTY";
  if (/hip|acetab|tha/.test(d)) return "HIP_ARTHROPLASTY";
  if (/cord|paraple|quadriple|tetraple/.test(d)) return "SPINAL_CORD_INJURY";
  return "GENERAL";
}

export function packFor(specialty: InjurySpecialty, diagnosis?: string | null): SpecialtyPack {
  const resolved = resolveSpecialty(specialty, diagnosis);
  const pack = PACKS[resolved];
  if (!pack) {
    // GENERAL / unmapped specialties still get a defensible baseline plan.
    return {
      conditions: [
        {
          name: diagnosis || "Primary injury-related condition",
          relatedness: "RELATED",
          confidence: 70,
          reasoning: "Attributed to the reported mechanism pending physician confirmation.",
          objectiveEvidence: "See medical records and imaging.",
        },
      ],
      chronology: [
        { dayOffset: 0, provider: "Treating Facility", specialty: "General", recordType: "Initial evaluation", summary: "Initial presentation and evaluation after the incident.", relevanceScore: 80 },
      ],
      care: [
        {
          category: "SPECIALIST_VISIT",
          service: "Specialist follow-up visits",
          specialty: "Relevant Specialty",
          rationale: "Ongoing specialist management of the injury.",
          probability: "PROBABLE",
          frequencyPerYear: 2,
          durationYears: 5,
          evidenceStrength: "Case-specific",
          literatureSupport: "Frequency to be confirmed by treating specialist.",
          defenseVulnerability: "MODERATE",
          confidence: 60,
        },
        {
          category: "PHYSICAL_THERAPY",
          service: "Physical therapy course",
          specialty: "Physical Therapy",
          rationale: "Functional rehabilitation.",
          probability: "PROBABLE",
          frequencyPerYear: 12,
          durationYears: 2,
          evidenceStrength: "Guideline-supported",
          literatureSupport: "Standard rehabilitation protocols.",
          defenseVulnerability: "LOW",
          confidence: 72,
        },
      ],
    };
  }
  return { ...pack, care: [...pack.care, ...GENERAL_CARE] };
}
