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
// Keyword patterns for each catalog condition, keyed by the exact label. These
// only identify the *term*; whether an occurrence counts as PRE-EXISTING is
// decided by context (see findConditionsInRecords) so that post-injury
// diagnoses are not misread as prior history.
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

// Headers that open a PRIOR / past-history section. "History of present illness"
// (HPI) is deliberately excluded — it narrates the current injury, not history.
const PMH_HEADER = /(past\s+medical(?:\s*\/?\s*surgical)?\s+history|past\s+surgical\s+history|prior\s+medical\s+history|previous\s+medical\s+history|significant\s+past\s+history|past\s+history|\bpmhx?\b|\bpshx?\b)\s*[:\-]?/gi;

// Keywords/headers that close a history section (i.e. begin a different section).
const SECTION_END = /(history of present illness|chief complaint|\bhpi\b|medications?\b|allerg|social history|family history|review of systems|\bros\b|physical exam|vital signs|assessment|impression|findings|diagnosis\b|disposition|\bplan\b|procedure|technique)/i;

// A qualifier that, appearing just before a condition term, marks it as prior.
const PRIOR_QUALIFIER = /(pre-?existing|prior|previous|history of|h\/o|hx of|long-?standing|remote|known|underlying|baseline|status[- ]post)\b[\w,\-\/ ]{0,25}$/i;
// A qualifier embedded within the matched term itself (e.g. "old fracture").
const SELF_PRIOR = /pre-?existing|prior|previous|history of|\bh\/o\b|\bold\b|healed|remote/i;

// Concatenate the text falling under past-history headers only.
function pmhScope(text: string): string {
  const out: string[] = [];
  PMH_HEADER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PMH_HEADER.exec(text))) {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 500);
    const blank = rest.search(/\n\s*\n/);
    const sec = rest.search(SECTION_END);
    const ends = [blank, sec].filter((i) => i >= 0);
    out.push(rest.slice(0, ends.length ? Math.min(...ends) : rest.length));
  }
  return out.join("\n");
}

// True if the term appears anywhere in the text explicitly framed as prior.
function contextuallyPrior(text: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 45), m.index);
    if (SELF_PRIOR.test(m[0]) || PRIOR_QUALIFIER.test(before)) return true;
    if (m.index === g.lastIndex) g.lastIndex++;
  }
  return false;
}

/**
 * Return the catalog conditions documented as PRE-EXISTING in the records. A
 * term only qualifies when it appears inside a past-medical-history section or
 * is explicitly qualified as prior ("history of …", "prior …", etc.). This keeps
 * post-injury diagnoses — sequelae that naturally recur throughout the chart —
 * from being misconstrued as pre-existing simply because the term is present.
 */
export function findConditionsInRecords(text: string | null | undefined): string[] {
  if (!text) return [];
  const scoped = pmhScope(text);
  const found: string[] = [];
  for (const [label, re] of Object.entries(CONDITION_KEYWORDS)) {
    if (re.test(scoped) || contextuallyPrior(text, re)) found.push(label);
  }
  return found;
}
