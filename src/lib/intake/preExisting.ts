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

// ── Record detection ─────────────────────────────────────────────────────────
// Keyword patterns used to flag which pre-existing conditions appear in the
// ingested medical records, keyed by the exact catalog label.
const CONDITION_KEYWORDS: Record<string, RegExp> = {
  "Prior low back injury / lumbar strain": /low back|lumbar strain|lumbago/i,
  "Degenerative disc disease": /degenerative disc|\bddd\b/i,
  "Prior spinal surgery / fusion": /spinal fusion|prior fusion|laminectomy|discectomy/i,
  Osteoarthritis: /osteoarthritis|degenerative joint disease|\bdjd\b/i,
  "Prior fracture": /(prior|old|healed|history of) fracture/i,
  "Prior joint replacement": /joint replacement|arthroplasty|prosthetic joint/i,
  "Prior knee injury / meniscus tear": /prior knee|meniscus tear|meniscal/i,
  "Prior shoulder injury / rotator cuff": /rotator cuff|prior shoulder/i,
  Scoliosis: /scoliosis/i,
  Osteoporosis: /osteoporosis|osteopenia/i,
  "Rheumatoid arthritis": /rheumatoid arthritis/i,
  Fibromyalgia: /fibromyalgia/i,
  "Prior traumatic brain injury / concussion": /prior (tbi|concussion|brain injury)|history of concussion/i,
  "Migraine / chronic headache disorder": /migraine|chronic headache/i,
  "Seizure disorder / epilepsy": /seizure|epilep/i,
  "Peripheral neuropathy": /peripheral neuropathy|polyneuropathy/i,
  "Stroke / CVA": /\bstroke\b|\bcva\b|cerebrovascular accident/i,
  "Multiple sclerosis": /multiple sclerosis/i,
  "Prior spinal cord injury": /prior spinal cord|history of spinal cord injury/i,
  "Parkinson's disease": /parkinson/i,
  Hypertension: /hypertension|\bhtn\b|high blood pressure/i,
  "Coronary artery disease": /coronary artery disease|\bcad\b/i,
  "Prior myocardial infarction": /myocardial infarction|heart attack/i,
  "Congestive heart failure": /congestive heart failure|\bchf\b/i,
  "Cardiac arrhythmia": /arrhythmia|atrial fibrillation|\bafib\b/i,
  "Peripheral vascular disease": /peripheral vascular disease|\bpvd\b/i,
  "Deep vein thrombosis history": /deep vein thrombosis|\bdvt\b/i,
  "Diabetes mellitus, Type 2": /type 2 diabetes|diabetes mellitus|\bt2dm\b|\bdiabetes\b/i,
  "Diabetes mellitus, Type 1": /type 1 diabetes|\bt1dm\b/i,
  Obesity: /obesity|\bobese\b|morbidly obese/i,
  "Thyroid disorder": /thyroid|hypothyroid|hyperthyroid/i,
  Hyperlipidemia: /hyperlipidemia|dyslipidemia|high cholesterol/i,
  COPD: /\bcopd\b|chronic obstructive pulmonary/i,
  Asthma: /asthma/i,
  "Obstructive sleep apnea": /sleep apnea|\bosa\b/i,
  "Tobacco use disorder": /tobacco|smoker|smoking|nicotine/i,
  Depression: /depression|depressive disorder/i,
  "Anxiety disorder": /anxiety/i,
  "Pre-existing PTSD": /\bptsd\b|post-?traumatic stress/i,
  "Bipolar disorder": /bipolar/i,
  "Substance use disorder": /substance (use|abuse)|alcohol (use|abuse)|opioid use disorder/i,
  "Chronic pain syndrome": /chronic pain/i,
  "Cancer history": /\bcancer\b|malignancy|carcinoma/i,
  "Chronic kidney disease": /chronic kidney disease|\bckd\b|renal insufficiency/i,
  "Liver disease": /liver disease|cirrhosis|hepatitis/i,
  "Autoimmune disorder": /autoimmune|lupus|\bsle\b/i,
  "Prior workers' compensation injury": /workers.? comp/i,
  "Prior motor vehicle collision injury": /(prior|previous).{0,30}(motor vehicle|mvc|mva|car accident)/i,
};

/** Return the catalog conditions whose keywords appear in the record text. */
export function findConditionsInRecords(text: string | null | undefined): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const [label, re] of Object.entries(CONDITION_KEYWORDS)) if (re.test(text)) found.push(label);
  return found;
}
