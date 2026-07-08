// ─────────────────────────────────────────────────────────────────────────────
// Document taxonomy + auto-classification (ported from OrthoCaseIQ).
//
// `guessDocType` is a filename heuristic used to auto-assign a label to any
// uploaded document when the user does not pick a type. `DOC_TYPE_GROUPS` gives
// each type a human-readable label and a group, which powers both the grouped
// picker and the filtered document view. This module is pure (no server imports)
// so it can be used on the client and the server alike.
// ─────────────────────────────────────────────────────────────────────────────

export const DOC_TYPE_GROUPS: { label: string; types: [string, string][] }[] = [
  {
    label: "Emergency & Acute Care",
    types: [
      ["POLICE_REPORT", "Police Report"],
      ["EMS_REPORT", "EMS / Ambulance Report"],
      ["ER_RECORD", "Emergency Room Record"],
      ["HOSPITAL_RECORD", "Hospital / Inpatient Record"],
      ["NURSING_NOTE", "Nursing Notes"],
      ["DISCHARGE_SUMMARY", "Discharge Summary"],
    ],
  },
  {
    label: "Surgical & Procedural",
    types: [
      ["OPERATIVE_NOTE", "Operative Note"],
      ["ANESTHESIA_RECORD", "Anesthesia Record"],
      ["PATHOLOGY_REPORT", "Pathology Report"],
      ["IMPLANT_RECORDS", "Implant / Device Records"],
    ],
  },
  {
    label: "Outpatient / Clinic",
    types: [
      ["MEDICAL_RECORD", "General Medical Record"],
      ["PRIMARY_CARE", "Primary Care"],
      ["ORTHOPEDIC_CLINIC", "Orthopedic Clinic"],
      ["NEUROLOGY_RECORD", "Neurology"],
      ["NEUROSURGERY_RECORD", "Neurosurgery"],
      ["PAIN_MANAGEMENT", "Pain Management"],
      ["PHYSICAL_MEDICINE", "Physical Medicine & Rehab"],
      ["PSYCHIATRY_RECORD", "Psychiatry"],
      ["PSYCHOLOGY_RECORD", "Psychology"],
      ["CARDIOLOGY_RECORD", "Cardiology"],
      ["PULMONOLOGY_RECORD", "Pulmonology"],
      ["INFECTIOUS_DISEASE", "Infectious Disease"],
      ["INTERNAL_MEDICINE", "Internal Medicine"],
      ["ONCOLOGY_RECORD", "Oncology"],
      ["WOUND_CARE", "Wound Care"],
    ],
  },
  {
    label: "Rehabilitation & Therapy",
    types: [
      ["PT_OT_RECORD", "Physical / Occupational Therapy"],
      ["SPEECH_THERAPY", "Speech Therapy"],
      ["CHIROPRACTIC_RECORD", "Chiropractic"],
      ["ACUPUNCTURE_RECORD", "Acupuncture"],
    ],
  },
  {
    label: "Diagnostics",
    types: [
      ["IMAGING_REPORT", "Imaging (X-ray / MRI / CT)"],
      ["LAB_REPORT", "Lab Report"],
      ["EMG_NCS_REPORT", "EMG / Nerve Conduction Study"],
      ["NEUROPSYCHOLOGICAL_EVALUATION", "Neuropsychological Evaluation"],
    ],
  },
  {
    label: "Life Care Plan & Vocational",
    types: [
      ["LIFE_CARE_PLAN", "Life Care Plan"],
      ["VOCATIONAL_ASSESSMENT", "Vocational Assessment"],
      ["FUNCTIONAL_CAPACITY_EVALUATION", "Functional Capacity Evaluation"],
      ["REHABILITATION_PLAN", "Rehabilitation Plan"],
      ["COST_PROJECTION", "Cost Projection / Economic Analysis"],
    ],
  },
  {
    label: "Financial & Economic",
    types: [
      ["BILLING_RECORD", "Medical Bills / EOB"],
      ["PHARMACY_RECORD", "Pharmacy / Prescriptions"],
      ["WAGE_LOSS_DOCUMENTATION", "Wage Loss Documentation"],
      ["EMPLOYMENT_RECORDS", "Employment Records"],
      ["TAX_RECORDS", "Tax Returns"],
      ["INSURANCE_RECORDS", "Insurance Records"],
    ],
  },
  {
    label: "Medicolegal / Expert",
    types: [
      ["IME_REPORT", "Independent Medical Exam (IME)"],
      ["EXPERT_REPORT", "Expert Report / Opinion"],
      ["PEER_REVIEW", "Peer Review"],
      ["PRIOR_RECORDS", "Prior Medical Records"],
    ],
  },
  {
    label: "Legal & Liability",
    types: [
      ["DEPOSITION", "Deposition Transcript"],
      ["LEGAL_PLEADING", "Pleading / Complaint / Motion"],
      ["DEMAND_LETTER", "Demand Letter"],
      ["SETTLEMENT_AGREEMENT", "Settlement Agreement"],
      ["COURT_ORDER", "Court Order"],
      ["CORRESPONDENCE", "Correspondence"],
    ],
  },
  {
    label: "Scene & Evidence",
    types: [
      ["ACCIDENT_RECONSTRUCTION", "Accident Reconstruction Report"],
      ["PHOTOGRAPHS", "Photographs / Scene Images"],
      ["SURVEILLANCE_VIDEO", "Surveillance / Video Evidence"],
      ["INCIDENT_REPORT", "Incident Report"],
    ],
  },
  {
    label: "Other",
    types: [["OTHER", "Other / Uncategorized"]],
  },
];

// Flat lookups derived from the groups.
export const TYPE_LABEL: Record<string, string> = {};
export const TYPE_GROUP: Record<string, string> = {};
DOC_TYPE_GROUPS.forEach((g) =>
  g.types.forEach(([v, l]) => {
    TYPE_LABEL[v] = l;
    TYPE_GROUP[v] = g.label;
  }),
);

export function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type.replace(/_/g, " ");
}

export function typeGroup(type: string): string {
  return TYPE_GROUP[type] ?? "Other";
}

// Filename heuristic — the auto-detect fallback when no explicit type is chosen.
export function guessDocType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.includes("police")) return "POLICE_REPORT";
  if (lower.includes("ems") || lower.includes("ambulance") || lower.includes("paramedic")) return "EMS_REPORT";
  if (lower.includes("er_") || lower.includes("emergency")) return "ER_RECORD";
  if (lower.includes("discharge")) return "DISCHARGE_SUMMARY";
  if (lower.includes("hospital") || lower.includes("admission")) return "HOSPITAL_RECORD";
  if (lower.includes("anesthesia")) return "ANESTHESIA_RECORD";
  if (lower.includes("operative") || lower.includes("op_note") || lower.includes("surgery")) return "OPERATIVE_NOTE";
  if (lower.includes("patholog")) return "PATHOLOGY_REPORT";
  if (lower.includes("implant")) return "IMPLANT_RECORDS";
  if (lower.includes("ortho")) return "ORTHOPEDIC_CLINIC";
  if (lower.includes("neurosurg")) return "NEUROSURGERY_RECORD";
  if (lower.includes("neuropsych") || lower.includes("neuro_psych")) return "NEUROPSYCHOLOGICAL_EVALUATION";
  if (lower.includes("neuro")) return "NEUROLOGY_RECORD";
  if (lower.includes("psych")) return "PSYCHIATRY_RECORD";
  if (lower.includes("cardio")) return "CARDIOLOGY_RECORD";
  if (lower.includes("pulmon")) return "PULMONOLOGY_RECORD";
  if (lower.includes("pain_mgmt") || lower.includes("pain_management") || lower.includes("injection")) return "PAIN_MANAGEMENT";
  if (lower.includes("chiro")) return "CHIROPRACTIC_RECORD";
  if (
    lower.includes("pt_") ||
    lower.includes("physical_therapy") ||
    lower.includes("_ot_") ||
    lower.includes("occupational_therapy") ||
    lower.includes("rehab")
  )
    return "PT_OT_RECORD";
  if (lower.includes("speech")) return "SPEECH_THERAPY";
  if (lower.includes("wound")) return "WOUND_CARE";
  if (lower.includes("emg") || lower.includes("ncs") || lower.includes("nerve_conduction")) return "EMG_NCS_REPORT";
  if (lower.includes("lab") || lower.includes("crp") || lower.includes("culture") || lower.includes("blood")) return "LAB_REPORT";
  if (
    lower.includes("imaging") ||
    lower.includes("xray") ||
    lower.includes("x-ray") ||
    lower.includes("mri") ||
    lower.includes("ct_") ||
    lower.includes("radiology") ||
    lower.includes("ultrasound")
  )
    return "IMAGING_REPORT";
  if (lower.includes("nursing")) return "NURSING_NOTE";
  if (lower.includes("life_care") || lower.includes("lcp")) return "LIFE_CARE_PLAN";
  if (lower.includes("vocational")) return "VOCATIONAL_ASSESSMENT";
  if (lower.includes("fce") || lower.includes("functional_capacity")) return "FUNCTIONAL_CAPACITY_EVALUATION";
  if (lower.includes("bill") || lower.includes("invoice") || lower.includes("eob")) return "BILLING_RECORD";
  if (lower.includes("pharmacy") || lower.includes("prescription") || lower.includes("medication") || lower.includes("rx"))
    return "PHARMACY_RECORD";
  if (lower.includes("wage") || lower.includes("earnings")) return "WAGE_LOSS_DOCUMENTATION";
  if (lower.includes("employ")) return "EMPLOYMENT_RECORDS";
  if (lower.includes("tax")) return "TAX_RECORDS";
  if (lower.includes("insurance")) return "INSURANCE_RECORDS";
  if (lower.includes("deposition") || lower.includes("depo")) return "DEPOSITION";
  if (lower.includes("ime")) return "IME_REPORT";
  if (lower.includes("expert")) return "EXPERT_REPORT";
  if (lower.includes("peer_review")) return "PEER_REVIEW";
  if (lower.includes("prior")) return "PRIOR_RECORDS";
  if (lower.includes("accident_recon") || lower.includes("reconstruction")) return "ACCIDENT_RECONSTRUCTION";
  if (lower.includes("photo") || lower.includes("image")) return "PHOTOGRAPHS";
  if (lower.includes("surveillance") || lower.includes("video")) return "SURVEILLANCE_VIDEO";
  if (lower.includes("incident")) return "INCIDENT_REPORT";
  if (lower.includes("complaint") || lower.includes("pleading") || lower.includes("motion")) return "LEGAL_PLEADING";
  if (lower.includes("demand")) return "DEMAND_LETTER";
  if (lower.includes("settlement")) return "SETTLEMENT_AGREEMENT";
  return "MEDICAL_RECORD";
}
