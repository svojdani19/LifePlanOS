import type { CareTemplate } from "@/lib/engine/specialty";

// ─────────────────────────────────────────────────────────────────────────────
// Diagnosis-driven future-care library (Module 6/7), modeled on the breadth of
// a professional Life Care Plan Medical Cost Table. Each clinical condition maps
// to a COMPREHENSIVE set of anticipated future care spanning provider visits,
// diagnostics, therapies, interventional procedures, medications, DME, and — where
// applicable — future surgery. A case with several diagnoses accumulates care
// from ALL of them (aggregated and de-duplicated by the generator), so the plan
// reflects every injury-related condition rather than a single specialty.
// ─────────────────────────────────────────────────────────────────────────────

export type ConditionKey =
  | "LUMBAR_SPINE"
  | "CERVICAL_SPINE"
  | "SPINAL_CORD"
  | "TBI"
  | "HEADACHE"
  | "CHRONIC_PAIN"
  | "CRPS"
  | "KNEE"
  | "HIP"
  | "SHOULDER"
  | "AMPUTATION"
  | "PSYCH"
  | "SEIZURE"
  | "NEUROPATHY"
  | "FRACTURE"
  | "BURN";

// Small helpers to keep the templates terse but complete.
const G = "Guideline-supported (ODG)";
const REG = "Registry / literature-supported";
const CASE = "Case-specific — physician confirmation required";
function item(t: Partial<CareTemplate> & Pick<CareTemplate, "category" | "service" | "frequencyPerYear">): CareTemplate {
  return {
    specialty: "",
    rationale: "",
    probability: "PROBABLE",
    isLifetime: false,
    evidenceStrength: G,
    literatureSupport: "Consistent with accepted treatment guidelines for the condition.",
    defenseVulnerability: "LOW",
    confidence: 75,
    ...t,
  } as CareTemplate;
}

export const CONDITION_CARE: Record<ConditionKey, CareTemplate[]> = {
  LUMBAR_SPINE: [
    item({ category: "PAIN_MANAGEMENT", service: "Pain management office visits", specialty: "Pain Management", rationale: "Ongoing management of chronic low back and radicular pain.", frequencyPerYear: 4, isLifetime: true, unitCost: 360, defenseVulnerability: "MODERATE", confidence: 68 }),
    item({ category: "SPECIALIST_VISIT", service: "Spine surgeon follow-up", specialty: "Orthopedic / Spine Surgery", rationale: "Surveillance of the lumbar condition and surgical candidacy.", frequencyPerYear: 1, durationYears: 10, unitCost: 385 }),
    item({ category: "PHYSICAL_THERAPY", service: "Physical therapy for lumbar flare-ups", specialty: "Physical Therapy", rationale: "Reconditioning during periodic symptomatic flare-ups.", frequencyPerYear: 12, isLifetime: true, unitCost: 145 }),
    item({ category: "INJECTION", service: "Lumbar transforaminal epidural steroid injection", specialty: "Interventional Pain", rationale: "Interventional control of radicular pain.", cptCode: "62323", frequencyPerYear: 3, durationYears: 10, unitCost: 3345, probability: "PROBABLE", evidenceStrength: G, defenseVulnerability: "MODERATE", confidence: 65 }),
    item({ category: "INJECTION", service: "Lumbar medial branch block / radiofrequency ablation", specialty: "Interventional Pain", rationale: "Facet-mediated pain control.", cptCode: "64635", frequencyPerYear: 2, isLifetime: true, unitCost: 2400, probability: "POSSIBLE", evidenceStrength: CASE, defenseVulnerability: "MODERATE", confidence: 58 }),
    item({ category: "IMAGING", service: "Lumbar MRI surveillance", specialty: "Radiology", rationale: "Periodic monitoring for progression / surgical planning.", cptCode: "72148", frequencyPerYear: 0.2, isLifetime: true, unitCost: 2667 }),
    item({ category: "IMAGING", service: "EMG / nerve conduction study, lower extremity", specialty: "Neurology", rationale: "Evaluation of lumbar radiculopathy.", cptCode: "95886", frequencyPerYear: 0.2, isLifetime: true, unitCost: 615, probability: "POSSIBLE", confidence: 60 }),
    item({ category: "MEDICATION", service: "Neuropathic pain & anti-inflammatory medications", specialty: "Pain Management", rationale: "Gabapentinoids, NSAIDs, and muscle relaxants for chronic pain.", frequencyPerYear: 1, isLifetime: true, unitCost: 2400 }),
    item({ category: "DME", service: "Lumbosacral orthosis (LSO brace)", specialty: "PM&R", rationale: "Lumbar support; replaced on a useful-life schedule.", frequencyPerYear: 0.2, isLifetime: true, unitCost: 300 }),
    item({ category: "DME", service: "TENS unit & supplies", specialty: "PM&R", rationale: "Home pain control; unit replaced periodically with ongoing supplies.", frequencyPerYear: 1, isLifetime: true, unitCost: 450, defenseVulnerability: "LOW", confidence: 70 }),
    item({ category: "FUTURE_SURGERY", service: "Lumbar decompression / fusion", specialty: "Spine Surgery", rationale: "Anticipated surgical intervention for progressive lumbar pathology.", frequencyPerYear: 1, durationYears: 1, unitCost: 68000, probability: "POSSIBLE", evidenceStrength: CASE, defenseVulnerability: "HIGH", confidence: 55, lowerCostAlternative: "Continued conservative management with interventional pain care." }),
    item({ category: "REVISION_SURGERY", service: "Adjacent-segment / revision surgery (one anticipated)", specialty: "Spine Surgery", rationale: "Adjacent-segment degeneration following fusion.", frequencyPerYear: 1, durationYears: 1, unitCost: 78000, probability: "SPECULATIVE", evidenceStrength: REG, defenseVulnerability: "HIGH", confidence: 45 }),
  ],
  CERVICAL_SPINE: [
    item({ category: "PAIN_MANAGEMENT", service: "Cervical pain management visits", specialty: "Pain Management", rationale: "Management of chronic cervical and cervicogenic pain.", frequencyPerYear: 3, isLifetime: true, unitCost: 360, defenseVulnerability: "MODERATE", confidence: 66 }),
    item({ category: "INJECTION", service: "Cervical epidural steroid injection", specialty: "Interventional Pain", rationale: "Interventional control of cervical radicular pain.", cptCode: "62321", frequencyPerYear: 2, durationYears: 10, unitCost: 3345, defenseVulnerability: "MODERATE", confidence: 62 }),
    item({ category: "INJECTION", service: "Cervical trigger-point injections", specialty: "Pain Management", rationale: "Myofascial pain control.", cptCode: "20553", frequencyPerYear: 3, durationYears: 8, unitCost: 350, probability: "POSSIBLE", confidence: 58 }),
    item({ category: "IMAGING", service: "Cervical MRI surveillance", specialty: "Radiology", rationale: "Monitoring cervical disc/spondylotic progression.", cptCode: "72141", frequencyPerYear: 0.2, isLifetime: true, unitCost: 2395 }),
    item({ category: "IMAGING", service: "EMG / nerve conduction study, upper extremity", specialty: "Neurology", rationale: "Evaluation of cervical radiculopathy.", cptCode: "95885", frequencyPerYear: 0.2, isLifetime: true, unitCost: 637, probability: "POSSIBLE", confidence: 60 }),
    item({ category: "PHYSICAL_THERAPY", service: "Cervical physical therapy for flare-ups", specialty: "Physical Therapy", rationale: "Reconditioning during cervical flare-ups.", frequencyPerYear: 10, isLifetime: true, unitCost: 145 }),
    item({ category: "DME", service: "Cervical collar / decompression device", specialty: "PM&R", rationale: "Cervical support, replaced on a useful-life schedule.", frequencyPerYear: 0.2, isLifetime: true, unitCost: 120 }),
    item({ category: "FUTURE_SURGERY", service: "Anterior cervical discectomy & fusion (ACDF)", specialty: "Spine Surgery", rationale: "Anticipated surgery for progressive cervical pathology.", frequencyPerYear: 1, durationYears: 1, unitCost: 72000, probability: "POSSIBLE", evidenceStrength: CASE, defenseVulnerability: "HIGH", confidence: 52, lowerCostAlternative: "Continued conservative / interventional care." }),
  ],
  SPINAL_CORD: [
    item({ category: "SPECIALIST_VISIT", service: "Physiatry (PM&R) management visits", specialty: "PM&R", rationale: "Coordination of neurologic rehabilitation and complications.", frequencyPerYear: 3, isLifetime: true, unitCost: 330 }),
    item({ category: "ATTENDANT_CARE", service: "Attendant / home care (hours per physiatry)", specialty: "Home Health", rationale: "Assistance with ADLs given functional dependence.", frequencyPerYear: 1, isLifetime: true, unitCost: 62000, probability: "PROBABLE", evidenceStrength: CASE, defenseVulnerability: "HIGH", confidence: 62, lowerCostAlternative: "Family-provided care with intermittent skilled visits." }),
    item({ category: "PHYSICAL_THERAPY", service: "Ongoing physical & occupational therapy", specialty: "Rehabilitation", rationale: "Maintenance of strength, mobility, and function.", frequencyPerYear: 24, isLifetime: true, unitCost: 145 }),
    item({ category: "MOBILITY_AID", service: "Wheelchair & mobility equipment", specialty: "PM&R", rationale: "Mobility equipment with periodic replacement.", frequencyPerYear: 0.2, isLifetime: true, unitCost: 6800 }),
    item({ category: "SUPPLIES", service: "Neurogenic bowel/bladder & skin-care supplies", specialty: "Urology / Rehab", rationale: "Ongoing supplies for neurogenic complications.", frequencyPerYear: 1, isLifetime: true, unitCost: 3600, defenseVulnerability: "MODERATE", confidence: 64 }),
    item({ category: "SPECIALIST_VISIT", service: "Urology follow-up (neurogenic bladder)", specialty: "Urology", rationale: "Management of neurogenic bladder.", frequencyPerYear: 2, isLifetime: true, unitCost: 385, probability: "POSSIBLE", confidence: 60 }),
    item({ category: "HOME_MODIFICATION", service: "Home accessibility modifications", specialty: "Rehabilitation", rationale: "ADA modifications for accessibility.", frequencyPerYear: 0.05, isLifetime: true, unitCost: 28000, probability: "POSSIBLE", defenseVulnerability: "MODERATE", confidence: 58 }),
    item({ category: "COMPLICATION_MANAGEMENT", service: "Management of pressure injury / UTI episodes", specialty: "PM&R", rationale: "Recurrent complications common to SCI.", frequencyPerYear: 1, isLifetime: true, unitCost: 15000, probability: "POSSIBLE", evidenceStrength: REG, defenseVulnerability: "MODERATE", confidence: 55 }),
  ],
  TBI: [
    item({ category: "NEUROLOGY", service: "Neurology management visits", specialty: "Neurology", rationale: "Management of post-traumatic neurologic sequelae.", frequencyPerYear: 2, isLifetime: true, unitCost: 420 }),
    item({ category: "COGNITIVE_THERAPY", service: "Cognitive rehabilitation therapy", specialty: "Neuropsychology", rationale: "Remediation of cognitive deficits.", frequencyPerYear: 24, durationYears: 3, unitCost: 175, defenseVulnerability: "MODERATE", confidence: 66 }),
    item({ category: "SPECIALIST_VISIT", service: "Neuropsychological evaluation (serial)", specialty: "Neuropsychology", rationale: "Serial assessment of cognitive function.", frequencyPerYear: 0.2, isLifetime: true, unitCost: 3340 }),
    item({ category: "IMAGING", service: "Brain MRI without contrast", specialty: "Radiology", rationale: "Neuroimaging surveillance.", cptCode: "70551", frequencyPerYear: 0.2, isLifetime: true, unitCost: 2053 }),
    item({ category: "PHYSICAL_THERAPY", service: "Vestibular therapy", specialty: "Physical Therapy", rationale: "Treatment of post-traumatic dizziness / balance dysfunction.", cptCode: "97112", frequencyPerYear: 6, durationYears: 2, unitCost: 280, probability: "POSSIBLE", confidence: 62 }),
    item({ category: "MEDICATION", service: "Neurocognitive & symptom medications", specialty: "Neurology", rationale: "Memantine, sleep, and mood/attention agents as indicated.", frequencyPerYear: 1, isLifetime: true, unitCost: 3600 }),
    item({ category: "PSYCH", service: "Neuropsychiatric management", specialty: "Psychiatry", rationale: "Management of mood lability and behavioral sequelae.", frequencyPerYear: 4, durationYears: 5, unitCost: 302, probability: "POSSIBLE", confidence: 60 }),
    item({ category: "CASE_MANAGEMENT", service: "Neuro case management", specialty: "Nurse Case Manager", rationale: "Coordination of complex neurologic care.", frequencyPerYear: 1, durationYears: 5, unitCost: 4800, probability: "POSSIBLE", evidenceStrength: CASE, defenseVulnerability: "MODERATE", confidence: 55 }),
  ],
  HEADACHE: [
    item({ category: "NEUROLOGY", service: "Headache / neurology follow-up", specialty: "Neurology", rationale: "Management of post-traumatic headache / migraine.", frequencyPerYear: 3, isLifetime: true, unitCost: 420, defenseVulnerability: "LOW", confidence: 70 }),
    item({ category: "MEDICATION", service: "Migraine abortive & preventive medications", specialty: "Neurology", rationale: "Abortive (e.g., gepants) and preventive pharmacotherapy.", frequencyPerYear: 1, isLifetime: true, unitCost: 6000, defenseVulnerability: "MODERATE", confidence: 62 }),
    item({ category: "INJECTION", service: "Occipital nerve blocks / Botox for chronic migraine", specialty: "Neurology", rationale: "Interventional migraine management.", cptCode: "64405", frequencyPerYear: 3, durationYears: 10, unitCost: 1200, probability: "POSSIBLE", confidence: 58 }),
  ],
  CHRONIC_PAIN: [
    item({ category: "PAIN_MANAGEMENT", service: "Chronic pain management visits", specialty: "Pain Management", rationale: "Longitudinal management of chronic pain.", frequencyPerYear: 4, isLifetime: true, unitCost: 360, defenseVulnerability: "MODERATE", confidence: 66 }),
    item({ category: "MEDICATION", service: "Chronic pain pharmacotherapy", specialty: "Pain Management", rationale: "Multimodal analgesic regimen.", frequencyPerYear: 1, isLifetime: true, unitCost: 2400 }),
    item({ category: "COMPLICATION_MANAGEMENT", service: "Functional restoration program", specialty: "PM&R / Pain Psychology", rationale: "Interdisciplinary functional restoration per treatment guidelines.", frequencyPerYear: 1, durationYears: 1, unitCost: 30000, probability: "POSSIBLE", evidenceStrength: G, defenseVulnerability: "MODERATE", confidence: 58 }),
    item({ category: "PSYCH", service: "Pain psychology / supportive psychotherapy", specialty: "Psychology", rationale: "Behavioral pain management and coping.", cptCode: "90837", frequencyPerYear: 12, durationYears: 3, unitCost: 290, probability: "POSSIBLE", confidence: 60 }),
  ],
  CRPS: [
    item({ category: "PAIN_MANAGEMENT", service: "CRPS-directed pain management", specialty: "Pain Management", rationale: "Specialized management of complex regional pain syndrome.", frequencyPerYear: 6, isLifetime: true, unitCost: 360, defenseVulnerability: "MODERATE", confidence: 62 }),
    item({ category: "INJECTION", service: "Sympathetic nerve blocks", specialty: "Interventional Pain", rationale: "Sympathetically-mediated pain control.", cptCode: "64520", frequencyPerYear: 4, durationYears: 10, unitCost: 2000, probability: "POSSIBLE", confidence: 55 }),
    item({ category: "FUTURE_SURGERY", service: "Spinal cord stimulator (trial & implant)", specialty: "Interventional Pain", rationale: "Neuromodulation for refractory CRPS.", cptCode: "63650", frequencyPerYear: 1, durationYears: 1, unitCost: 55000, probability: "POSSIBLE", evidenceStrength: REG, defenseVulnerability: "HIGH", confidence: 50 }),
    item({ category: "PHYSICAL_THERAPY", service: "Desensitization / graded motor imagery therapy", specialty: "Occupational Therapy", rationale: "CRPS rehabilitation.", frequencyPerYear: 12, durationYears: 3, unitCost: 150 }),
  ],
  KNEE: [
    item({ category: "SPECIALIST_VISIT", service: "Orthopedic follow-up visits", specialty: "Orthopedic Surgery", rationale: "Surveillance of post-traumatic knee arthritis.", cptCode: "99214", frequencyPerYear: 2, isLifetime: true, unitCost: 261 }),
    item({ category: "ORTHOPEDIC_SURGERY", service: "Total knee arthroplasty", specialty: "Orthopedic Surgery", rationale: "End-stage post-traumatic arthritis.", cptCode: "27447", frequencyPerYear: 1, durationYears: 1, unitCost: 42000, probability: "PROBABLE", confidence: 72 }),
    item({ category: "REVISION_SURGERY", service: "Revision knee arthroplasty (one anticipated)", specialty: "Orthopedic Surgery", rationale: "Implant survivorship shorter than life expectancy.", cptCode: "27487", frequencyPerYear: 1, durationYears: 1, unitCost: 68000, probability: "POSSIBLE", evidenceStrength: REG, defenseVulnerability: "MODERATE", confidence: 60 }),
    item({ category: "PHYSICAL_THERAPY", service: "Post-operative & maintenance physical therapy", specialty: "Physical Therapy", rationale: "Rehabilitation following arthroplasty and for flare-ups.", frequencyPerYear: 12, isLifetime: true, unitCost: 145 }),
    item({ category: "INJECTION", service: "Intra-articular knee injections", specialty: "Orthopedics", rationale: "Corticosteroid / viscosupplementation for symptom control.", cptCode: "20610", frequencyPerYear: 2, isLifetime: true, unitCost: 850, probability: "POSSIBLE", confidence: 62 }),
    item({ category: "IMAGING", service: "Implant surveillance radiographs", specialty: "Orthopedics", rationale: "Monitoring for loosening / wear.", frequencyPerYear: 0.5, isLifetime: true, unitCost: 250 }),
    item({ category: "DME", service: "Knee brace & assistive devices", specialty: "Orthopedics", rationale: "Support and mobility aids.", frequencyPerYear: 0.3, isLifetime: true, unitCost: 600 }),
  ],
  HIP: [
    item({ category: "SPECIALIST_VISIT", service: "Orthopedic follow-up visits", specialty: "Orthopedic Surgery", rationale: "Surveillance of post-traumatic hip arthritis.", frequencyPerYear: 2, isLifetime: true, unitCost: 261 }),
    item({ category: "ORTHOPEDIC_SURGERY", service: "Total hip arthroplasty", specialty: "Orthopedic Surgery", rationale: "End-stage post-traumatic hip arthritis.", frequencyPerYear: 1, durationYears: 1, unitCost: 44000, probability: "POSSIBLE", confidence: 66 }),
    item({ category: "REVISION_SURGERY", service: "Revision hip arthroplasty (one anticipated)", specialty: "Orthopedic Surgery", rationale: "Implant survivorship shorter than life expectancy.", frequencyPerYear: 1, durationYears: 1, unitCost: 70000, probability: "POSSIBLE", evidenceStrength: REG, defenseVulnerability: "MODERATE", confidence: 58 }),
    item({ category: "PHYSICAL_THERAPY", service: "Physical therapy (post-op & maintenance)", specialty: "Physical Therapy", rationale: "Rehabilitation following arthroplasty.", frequencyPerYear: 12, durationYears: 2, unitCost: 145 }),
    item({ category: "IMAGING", service: "Implant surveillance radiographs", specialty: "Orthopedics", rationale: "Monitoring for loosening / wear.", frequencyPerYear: 0.5, isLifetime: true, unitCost: 250 }),
  ],
  SHOULDER: [
    item({ category: "SPECIALIST_VISIT", service: "Orthopedic shoulder follow-up", specialty: "Orthopedic Surgery", rationale: "Management of rotator cuff / shoulder pathology.", frequencyPerYear: 2, durationYears: 10, unitCost: 261 }),
    item({ category: "FUTURE_SURGERY", service: "Rotator cuff repair / shoulder surgery", specialty: "Orthopedic Surgery", rationale: "Anticipated surgical repair.", frequencyPerYear: 1, durationYears: 1, unitCost: 26000, probability: "POSSIBLE", evidenceStrength: CASE, defenseVulnerability: "MODERATE", confidence: 58 }),
    item({ category: "PHYSICAL_THERAPY", service: "Shoulder physical therapy", specialty: "Physical Therapy", rationale: "Post-operative and maintenance rehabilitation.", frequencyPerYear: 12, durationYears: 2, unitCost: 145 }),
    item({ category: "INJECTION", service: "Subacromial corticosteroid injections", specialty: "Orthopedics", rationale: "Symptom control.", cptCode: "20610", frequencyPerYear: 2, durationYears: 10, unitCost: 850, probability: "POSSIBLE", confidence: 60 }),
  ],
  AMPUTATION: [
    item({ category: "ORTHOTICS_PROSTHETICS", service: "Prosthesis replacement (every 3–5 years)", specialty: "Prosthetics", rationale: "Prostheses require periodic replacement over the lifespan.", cptCode: "L5301", frequencyPerYear: 0.25, isLifetime: true, unitCost: 21000, confidence: 85 }),
    item({ category: "SUPPLIES", service: "Prosthetic liners, socks & supplies", specialty: "Prosthetics", rationale: "Consumable prosthetic components.", frequencyPerYear: 1, isLifetime: true, unitCost: 1800, confidence: 84 }),
    item({ category: "PHYSICAL_THERAPY", service: "Gait training & periodic therapy", specialty: "Physical Therapy", rationale: "Adaptation to new/replacement prostheses.", frequencyPerYear: 8, isLifetime: true, unitCost: 145 }),
    item({ category: "SPECIALIST_VISIT", service: "Physiatry / prosthetics clinic visits", specialty: "PM&R", rationale: "Residual limb management and prosthetic prescription.", frequencyPerYear: 2, isLifetime: true, unitCost: 330 }),
    item({ category: "PSYCH", service: "Adjustment counseling", specialty: "Psychology", rationale: "Psychological adjustment to limb loss.", frequencyPerYear: 12, durationYears: 2, unitCost: 210, probability: "POSSIBLE", confidence: 60 }),
    item({ category: "MOBILITY_AID", service: "Mobility aids & wheelchair (backup)", specialty: "PM&R", rationale: "Backup mobility equipment.", frequencyPerYear: 0.15, isLifetime: true, unitCost: 6800, probability: "POSSIBLE", confidence: 62 }),
  ],
  PSYCH: [
    item({ category: "PSYCH", service: "Psychiatric medication management", specialty: "Psychiatry", rationale: "Management of injury-related mood/anxiety disorder.", cptCode: "99214", frequencyPerYear: 4, durationYears: 5, unitCost: 302, defenseVulnerability: "MODERATE", confidence: 62 }),
    item({ category: "PSYCH", service: "Individual psychotherapy", specialty: "Psychology", rationale: "Supportive and cognitive-behavioral therapy.", cptCode: "90837", frequencyPerYear: 26, durationYears: 3, unitCost: 290, defenseVulnerability: "MODERATE", confidence: 62 }),
    item({ category: "MEDICATION", service: "Psychotropic medications", specialty: "Psychiatry", rationale: "Antidepressant / anxiolytic / sleep pharmacotherapy.", frequencyPerYear: 1, durationYears: 5, unitCost: 1200 }),
  ],
  SEIZURE: [
    item({ category: "NEUROLOGY", service: "Neurology / epilepsy management", specialty: "Neurology", rationale: "Management of post-traumatic seizure disorder.", frequencyPerYear: 2, isLifetime: true, unitCost: 420, probability: "POSSIBLE", confidence: 58 }),
    item({ category: "MEDICATION", service: "Antiepileptic medications", specialty: "Neurology", rationale: "Ongoing seizure prophylaxis.", frequencyPerYear: 1, isLifetime: true, unitCost: 2400, probability: "POSSIBLE", confidence: 58 }),
    item({ category: "IMAGING", service: "EEG monitoring", specialty: "Neurology", rationale: "Periodic electroencephalographic evaluation.", cptCode: "95816", frequencyPerYear: 0.2, isLifetime: true, unitCost: 997, probability: "POSSIBLE", confidence: 56 }),
  ],
  NEUROPATHY: [
    item({ category: "NEUROLOGY", service: "Neurology follow-up (neuropathy)", specialty: "Neurology", rationale: "Management of peripheral nerve injury / neuropathy.", frequencyPerYear: 2, durationYears: 10, unitCost: 420, probability: "POSSIBLE", confidence: 60 }),
    item({ category: "IMAGING", service: "EMG / nerve conduction studies", specialty: "Neurology", rationale: "Serial electrodiagnostic evaluation.", cptCode: "95910", frequencyPerYear: 0.2, isLifetime: true, unitCost: 600, probability: "POSSIBLE", confidence: 58 }),
    item({ category: "MEDICATION", service: "Neuropathic pain medication", specialty: "Neurology", rationale: "Gabapentinoids / SNRIs for neuropathic pain.", frequencyPerYear: 1, isLifetime: true, unitCost: 2400 }),
  ],
  FRACTURE: [
    item({ category: "SPECIALIST_VISIT", service: "Orthopedic follow-up", specialty: "Orthopedic Surgery", rationale: "Surveillance of fracture healing and post-traumatic sequelae.", frequencyPerYear: 2, durationYears: 5, unitCost: 261 }),
    item({ category: "FUTURE_SURGERY", service: "Hardware removal", specialty: "Orthopedic Surgery", rationale: "Symptomatic hardware may require removal.", frequencyPerYear: 1, durationYears: 1, unitCost: 18000, probability: "POSSIBLE", evidenceStrength: CASE, defenseVulnerability: "MODERATE", confidence: 58 }),
    item({ category: "IMAGING", service: "Follow-up radiographs", specialty: "Radiology", rationale: "Monitoring of healing / post-traumatic arthritis.", frequencyPerYear: 1, durationYears: 5, unitCost: 250 }),
    item({ category: "PHYSICAL_THERAPY", service: "Physical therapy", specialty: "Physical Therapy", rationale: "Functional rehabilitation.", frequencyPerYear: 12, durationYears: 2, unitCost: 145 }),
  ],
  BURN: [
    item({ category: "FUTURE_SURGERY", service: "Reconstructive / scar-revision surgery", specialty: "Plastic Surgery", rationale: "Staged reconstruction and scar revision.", frequencyPerYear: 0.3, durationYears: 10, unitCost: 30000, probability: "POSSIBLE", evidenceStrength: CASE, defenseVulnerability: "MODERATE", confidence: 58 }),
    item({ category: "OCCUPATIONAL_THERAPY", service: "Burn rehabilitation therapy", specialty: "Occupational Therapy", rationale: "Contracture prevention and functional rehabilitation.", frequencyPerYear: 24, durationYears: 3, unitCost: 150 }),
    item({ category: "SUPPLIES", service: "Compression garments & wound-care supplies", specialty: "Burn Care", rationale: "Scar management supplies replaced periodically.", frequencyPerYear: 2, isLifetime: true, unitCost: 1200 }),
    item({ category: "PSYCH", service: "Psychological support", specialty: "Psychology", rationale: "Adjustment and trauma counseling.", frequencyPerYear: 12, durationYears: 2, unitCost: 210, probability: "POSSIBLE", confidence: 60 }),
  ],
};

// Baseline care every serious injury plan carries.
export const BASELINE_CARE: CareTemplate[] = [
  item({ category: "PRIMARY_CARE", service: "Primary care coordination visits", specialty: "Family Medicine", rationale: "Ongoing management of injury-related comorbidities and medication oversight.", frequencyPerYear: 2, isLifetime: true, unitCost: 195, confidence: 78 }),
  item({ category: "CASE_MANAGEMENT", service: "RN medical case management", specialty: "Nurse Case Manager", rationale: "Coordination of complex multi-provider care.", frequencyPerYear: 1, durationYears: 5, unitCost: 4800, probability: "POSSIBLE", evidenceStrength: CASE, defenseVulnerability: "MODERATE", confidence: 55, lowerCostAlternative: "Intermittent coordination via treating provider staff." }),
];

const KEYWORDS: Record<ConditionKey, RegExp> = {
  LUMBAR_SPINE: /\b(lumbar|low back|lower back|l[1-5]\b|l[45]-s1|s1|disc (herniat|protrus|bulg)|radiculopath|sciatic|spondylo|burst fracture)\b/i,
  CERVICAL_SPINE: /\b(cervical|neck|c[2-7]\b|acdf|whiplash)\b/i,
  SPINAL_CORD: /\b(spinal cord|\bsci\b|paraple|quadriple|tetraple|neurogenic (bladder|bowel)|myelopath)\b/i,
  TBI: /\b(traumatic brain|brain injury|\btbi\b|concussion|post-?concuss|cognitive|anoxic|intracranial|closed head)\b/i,
  HEADACHE: /\b(migraine|headache|cephalgia|post-?traumatic headache)\b/i,
  CHRONIC_PAIN: /\b(chronic pain|pain syndrome|myofascial|fibromyalg)\b/i,
  CRPS: /\b(crps|complex regional|causalgia|reflex sympathetic|dystrophy)\b/i,
  KNEE: /\b(knee|tibial plateau|meniscus|patell|\btka\b)\b/i,
  HIP: /\b(hip|acetabul|\btha\b|femoral neck)\b/i,
  SHOULDER: /\b(shoulder|rotator cuff|labral|glenohumeral)\b/i,
  AMPUTATION: /\b(amputat|transtibial|transfemoral|limb loss|below[- ]knee|above[- ]knee)\b/i,
  PSYCH: /\b(depress|anxiet|\bptsd\b|post-?traumatic stress|mood|adjustment disorder|insomnia|psychological)\b/i,
  SEIZURE: /\b(seizure|epilep|convuls)\b/i,
  NEUROPATHY: /\b(neuropath|nerve injury|nerve damage|peripheral nerve)\b/i,
  FRACTURE: /\b(fracture|orif|hardware|internal fixation|nonunion|malunion)\b/i,
  BURN: /\b(burn|scald|graft|contracture)\b/i,
};

/** Resolve free diagnosis text to the applicable condition keys. */
export function resolveConditionKeys(text: string | null | undefined): ConditionKey[] {
  if (!text) return [];
  const keys: ConditionKey[] = [];
  for (const [key, re] of Object.entries(KEYWORDS)) if (re.test(text)) keys.push(key as ConditionKey);
  return keys;
}
