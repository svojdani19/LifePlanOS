// Comprehensive catalog of pre-existing conditions commonly relevant to injury /
// life-care-planning cases (causation & apportionment). Grouped for the intake
// picker; users can also add custom entries.
export const PRE_EXISTING_GROUPS: { group: string; conditions: string[] }[] = [
  {
    group: "Musculoskeletal / Orthopedic",
    conditions: [
      "Prior low back injury / lumbar strain",
      "Degenerative disc disease",
      "Prior spinal surgery / fusion",
      "Osteoarthritis",
      "Prior fracture",
      "Prior joint replacement",
      "Prior knee injury / meniscus tear",
      "Prior shoulder injury / rotator cuff",
      "Scoliosis",
      "Osteoporosis",
      "Rheumatoid arthritis",
      "Fibromyalgia",
    ],
  },
  {
    group: "Neurological",
    conditions: [
      "Prior traumatic brain injury / concussion",
      "Migraine / chronic headache disorder",
      "Seizure disorder / epilepsy",
      "Peripheral neuropathy",
      "Stroke / CVA",
      "Multiple sclerosis",
      "Prior spinal cord injury",
      "Parkinson's disease",
    ],
  },
  {
    group: "Cardiovascular",
    conditions: [
      "Hypertension",
      "Coronary artery disease",
      "Prior myocardial infarction",
      "Congestive heart failure",
      "Cardiac arrhythmia",
      "Peripheral vascular disease",
      "Deep vein thrombosis history",
    ],
  },
  {
    group: "Endocrine / Metabolic",
    conditions: ["Diabetes mellitus, Type 2", "Diabetes mellitus, Type 1", "Obesity", "Thyroid disorder", "Hyperlipidemia"],
  },
  {
    group: "Respiratory",
    conditions: ["COPD", "Asthma", "Obstructive sleep apnea", "Tobacco use disorder"],
  },
  {
    group: "Psychiatric / Behavioral",
    conditions: [
      "Depression",
      "Anxiety disorder",
      "Pre-existing PTSD",
      "Bipolar disorder",
      "Substance use disorder",
      "Chronic pain syndrome",
    ],
  },
  {
    group: "Other systemic",
    conditions: [
      "Cancer history",
      "Chronic kidney disease",
      "Liver disease",
      "Autoimmune disorder",
      "Prior workers' compensation injury",
      "Prior motor vehicle collision injury",
    ],
  },
];

export const ALL_PRE_EXISTING: string[] = PRE_EXISTING_GROUPS.flatMap((g) => g.conditions);

// Stored as a "; "-delimited string. Split only on ";"/"|" so condition names
// that contain commas (e.g. "Diabetes mellitus, Type 2") stay intact.
export function parseConditions(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/\s*[;|]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function serializeConditions(list: string[]): string {
  return Array.from(new Set(list.map((s) => s.trim()).filter(Boolean))).join("; ");
}
