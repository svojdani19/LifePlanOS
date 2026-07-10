// De-identified finalized LCPs for the firm precedent library. Realistic
// metadata drives the "likeness" match; the body text supports full-text search
// and the in-app viewer. (No PHI — these are synthetic exemplars.)
export interface SamplePrecedent {
  title: string;
  clientRef: string;
  diagnosis: string;
  icd10Code: string;
  injurySpecialty: string;
  jurisdiction: string;
  mechanism: string;
  age: number;
  sex: string;
  lifeExpectancyYears: number;
  lifetimeCost: number;
  presentValue: number;
  careCategories: string[];
  outcome: string;
  filename: string;
  text: string;
}

const SPINE_CARE = ["PHYSICIAN_VISIT", "SPECIALIST_VISIT", "PAIN_MANAGEMENT", "NEUROSURGERY", "INJECTION", "PHYSICAL_THERAPY", "IMAGING", "MEDICATION", "DME", "MOBILITY_AID", "HOME_MODIFICATION", "CASE_MANAGEMENT"];

export const SAMPLE_PRECEDENTS: SamplePrecedent[] = [
  {
    title: "L1 Burst Fracture with Incomplete SCI — CA (2023)",
    clientRef: "LCP-ARCHIVE-2023-041",
    diagnosis: "L1 burst fracture with incomplete spinal cord injury",
    icd10Code: "S32.010A",
    injurySpecialty: "SPINE",
    jurisdiction: "CA — Los Angeles County",
    mechanism: "Motor vehicle collision",
    age: 44,
    sex: "MALE",
    lifeExpectancyYears: 33.5,
    lifetimeCost: 7420000,
    presentValue: 4585000,
    careCategories: SPINE_CARE,
    outcome: "Resolved — confidential settlement following mediation.",
    filename: "Precedent_L1_Burst_SCI_2023.pdf",
    text: `LIFE CARE PLAN — L1 burst fracture with incomplete spinal cord injury. Mechanism: motor vehicle collision. Jurisdiction: California. Future care includes neurosurgical follow-up, pain management with periodic injections, lifelong physical therapy, durable medical equipment, mobility aids, home modifications, and case management. Present value of future medical damages $4,585,000.`,
  },
  {
    title: "L2–L3 Compression Fracture — CA (2022)",
    clientRef: "LCP-ARCHIVE-2022-118",
    diagnosis: "L2 and L3 vertebral compression fractures with chronic mechanical low back pain",
    icd10Code: "S32.020A",
    injurySpecialty: "SPINE",
    jurisdiction: "CA — Orange County",
    mechanism: "Fall from height",
    age: 52,
    sex: "FEMALE",
    lifeExpectancyYears: 30.2,
    lifetimeCost: 4180000,
    presentValue: 2870000,
    careCategories: ["PHYSICIAN_VISIT", "PAIN_MANAGEMENT", "INJECTION", "PHYSICAL_THERAPY", "IMAGING", "MEDICATION", "DME", "CASE_MANAGEMENT"],
    outcome: "Resolved — pre-trial settlement.",
    filename: "Precedent_L2L3_Compression_2022.pdf",
    text: `LIFE CARE PLAN — L2 and L3 compression fractures. Jurisdiction: California, Orange County. Chronic mechanical low back pain managed with orthopedic and pain-management follow-up, epidural steroid injections, physical therapy, imaging surveillance, medications, and durable medical equipment. Present value $2,870,000.`,
  },
  {
    title: "Cervical Fusion C5–C6 — NV (2023)",
    clientRef: "LCP-ARCHIVE-2023-073",
    diagnosis: "C5–C6 disc herniation with radiculopathy, status post anterior cervical discectomy and fusion",
    icd10Code: "S12.500A",
    injurySpecialty: "SPINE",
    jurisdiction: "NV — Clark County",
    mechanism: "Motor vehicle collision",
    age: 39,
    sex: "MALE",
    lifeExpectancyYears: 39.0,
    lifetimeCost: 5210000,
    presentValue: 3480000,
    careCategories: ["PHYSICIAN_VISIT", "NEUROSURGERY", "PAIN_MANAGEMENT", "INJECTION", "PHYSICAL_THERAPY", "IMAGING", "MEDICATION"],
    outcome: "Tried to verdict — plaintiff award.",
    filename: "Precedent_ACDF_C5C6_2023.pdf",
    text: `LIFE CARE PLAN — C5–C6 herniation with radiculopathy, status post ACDF. Mechanism: motor vehicle collision. Jurisdiction: Nevada. Anticipated adjacent-segment surveillance, potential revision surgery, pain management, and therapy. Present value $3,480,000.`,
  },
  {
    title: "Severe Traumatic Brain Injury — CA (2021)",
    clientRef: "LCP-ARCHIVE-2021-009",
    diagnosis: "Severe traumatic brain injury with spastic quadriparesis",
    icd10Code: "S06.2X9A",
    injurySpecialty: "TBI",
    jurisdiction: "CA — San Diego County",
    mechanism: "Fall from height",
    age: 30,
    sex: "FEMALE",
    lifeExpectancyYears: 41.0,
    lifetimeCost: 14800000,
    presentValue: 8240000,
    careCategories: ["PHYSICIAN_VISIT", "NEUROLOGY", "COGNITIVE_THERAPY", "OCCUPATIONAL_THERAPY", "ATTENDANT_CARE", "SKILLED_NURSING", "MEDICATION", "DME", "HOME_MODIFICATION"],
    outcome: "Resolved — structured settlement.",
    filename: "Precedent_TBI_Quadriparesis_2021.pdf",
    text: `LIFE CARE PLAN — severe traumatic brain injury with spastic quadriparesis. 24-hour attendant care, skilled nursing, neurology, cognitive and occupational therapy, home modifications. Present value $8,240,000.`,
  },
  {
    title: "Transtibial Amputation — NV (2022)",
    clientRef: "LCP-ARCHIVE-2022-054",
    diagnosis: "Traumatic transtibial (below-knee) amputation, left lower extremity",
    icd10Code: "S88.112A",
    injurySpecialty: "AMPUTATION",
    jurisdiction: "NV — Clark County",
    mechanism: "Industrial machinery",
    age: 41,
    sex: "MALE",
    lifeExpectancyYears: 36.4,
    lifetimeCost: 6900000,
    presentValue: 5120000,
    careCategories: ["PHYSICIAN_VISIT", "ORTHOTICS_PROSTHETICS", "PHYSICAL_THERAPY", "PAIN_MANAGEMENT", "MEDICATION", "DME", "VEHICLE_MODIFICATION"],
    outcome: "Resolved — settlement.",
    filename: "Precedent_BKA_2022.pdf",
    text: `LIFE CARE PLAN — traumatic below-knee amputation. Lifetime prosthetic replacement and maintenance, therapy, pain management, and vehicle modifications. Present value $5,120,000.`,
  },
  {
    title: "Post-Traumatic Total Knee Arthroplasty — CA (2023)",
    clientRef: "LCP-ARCHIVE-2023-101",
    diagnosis: "Right total knee arthroplasty for post-traumatic osteoarthritis",
    icd10Code: "M17.11",
    injurySpecialty: "KNEE_ARTHROPLASTY",
    jurisdiction: "CA — WCAB",
    mechanism: "Fall from height",
    age: 55,
    sex: "FEMALE",
    lifeExpectancyYears: 27.8,
    lifetimeCost: 2050000,
    presentValue: 1430000,
    careCategories: ["PHYSICIAN_VISIT", "ORTHOPEDIC_SURGERY", "REVISION_SURGERY", "PHYSICAL_THERAPY", "IMAGING", "MEDICATION", "DME"],
    outcome: "Resolved — workers' compensation stipulation.",
    filename: "Precedent_TKA_2023.pdf",
    text: `LIFE CARE PLAN — right total knee arthroplasty for post-traumatic arthritis. Anticipated revision arthroplasty, therapy, imaging, and durable medical equipment. Present value $1,430,000.`,
  },
];
