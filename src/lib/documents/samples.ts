// Demo record set. Filenames are deliberately GENERIC (Uploaded_Document_NN) so
// the "Add sample record set" action proves classification comes from the
// document body, not the title. Each `text` is a representative excerpt carrying
// the content signatures the classifier keys on, plus the descriptors every
// reviewed record should carry: a documented date, the documenting individual
// (name + credentials + role), and the facility/location of the episode.
export interface SampleDoc {
  filename: string;
  text: string;
}

export const SAMPLE_DOCS: SampleDoc[] = [
  {
    filename: "Uploaded_Document_01.pdf",
    text: `OPERATIVE REPORT
FACILITY: St. Jude Medical Center, Fullerton, CA.
DATE OF PROCEDURE: 06/12/2024
PREOPERATIVE DIAGNOSIS: Displaced tibial plateau fracture, left knee.
POSTOPERATIVE DIAGNOSIS: Same.
PROCEDURE PERFORMED: Open reduction internal fixation, left tibial plateau.
SURGEON: Jason Ortho, MD — Orthopedic Trauma Surgery.
ANESTHESIA: General.
ESTIMATED BLOOD LOSS: 150 mL. The fracture was reduced and fixed with a lateral locking plate. Closure in layers.`,
  },
  {
    filename: "Uploaded_Document_02.pdf",
    text: `MRI OF THE LUMBAR SPINE WITHOUT CONTRAST
FACILITY: Orange Coast Imaging Center, Costa Mesa, CA.
DATE OF EXAM: 06/09/2024
TECHNIQUE: Multiplanar multisequence imaging of the lumbar spine.
COMPARISON: None.
FINDINGS: L1 burst fracture with retropulsion and canal compromise. No cord signal abnormality.
IMPRESSION: Acute L1 burst fracture as above.
Dictated by: Alan Reader, MD — Diagnostic Radiology.`,
  },
  {
    filename: "Uploaded_Document_03.pdf",
    text: `PHYSICAL THERAPY PROGRESS NOTE
FACILITY: Meridian Rehabilitation Services, Irvine, CA.
DATE OF SERVICE: 08/20/2024
Patient tolerated therapeutic exercise. Range of motion improving. Gait training with rolling walker.
PLAN OF CARE: Continue 2x/week. SHORT-TERM GOALS: independent transfers. Home exercise program reviewed.
Therapist: Priya Nair, PT, DPT — Physical Therapy.`,
  },
  {
    filename: "Uploaded_Document_04.pdf",
    text: `EXPLANATION OF BENEFITS
FACILITY: Pacific Health Plan, Claims Administration.
DATE OF SERVICE: 03/14/2025.  CPT 27447.  TOTAL CHARGES: $42,000.00.
Adjustments: $12,300.00.  Amount billed to patient. BALANCE DUE: $1,240.00. Patient responsibility applies.
Prepared by: Marcus Vale — Claims Adjuster.`,
  },
  {
    filename: "Uploaded_Document_05.pdf",
    text: `IN THE SUPERIOR COURT OF THE STATE
FACILITY: Superior Court of California, County of Orange.
DEPOSITION OF DAVID CHEN — DATE: 02/03/2025
The witness, being first duly sworn, testified as follows. EXAMINATION BY MR. SMITH:
Q. Please state your name for the court reporter.
A. David Chen.
APPEARANCES: counsel for plaintiff and defendant noted.
Reported by: Dana Cole, CSR 12345 — Certified Shorthand Reporter.`,
  },
  {
    filename: "Uploaded_Document_06.pdf",
    text: `INDEPENDENT MEDICAL EXAMINATION
FACILITY: Vance Medical-Legal Associates, Santa Ana, CA.
DATE OF EXAMINATION: 01/15/2025
This report follows a record review and examination. History of present injury summarized below.
The claimant has reached maximum medical improvement. An impairment rating is provided within a reasonable degree of medical certainty.
Examiner: Robert Vance, MD — Independent Medical Examiner, Orthopedic Surgery.`,
  },
  {
    filename: "Uploaded_Document_07.pdf",
    text: `PHARMACY PRINTOUT
FACILITY: Wellness Pharmacy #204, Anaheim, CA.
FILL DATE: 07/01/2024
Prescription: Gabapentin 300 mg. SIG: take one tablet three times daily. Days supply: 30. Refills: 2.
NDC listed. Dispense as written. Pharmacy record of fills below.
Pharmacist: Linda Osei, PharmD — Dispensing Pharmacist.`,
  },
  {
    filename: "Uploaded_Document_08.pdf",
    text: `NEUROPSYCHOLOGICAL EVALUATION
FACILITY: Cognitive Health Institute, Newport Beach, CA.
DATE OF EVALUATION: 11/05/2024
A comprehensive test battery was administered including the Wechsler Adult Intelligence Scale.
Cognitive functioning and memory index scores are reported. Validity indicators were within acceptable limits.
Evaluated by: Miriam Katz, PhD — Clinical Neuropsychologist.`,
  },
  {
    filename: "Uploaded_Document_09.pdf",
    text: `EMERGENCY DEPARTMENT RECORD
FACILITY: Fountain Valley Regional Hospital, Fountain Valley, CA.
DATE OF SERVICE: 06/08/2024
CHIEF COMPLAINT: Back pain after motor vehicle collision. TRIAGE level 2. Mode of arrival: ambulance.
PAST MEDICAL HISTORY: Hypertension, type 2 diabetes mellitus, degenerative disc disease, and chronic low back pain. Former tobacco use.
DISPOSITION: Admitted to trauma service. Time of arrival documented.
Attending Physician: Omar Haddad, MD — Emergency Medicine.`,
  },
  {
    filename: "Uploaded_Document_10.pdf",
    text: `LABORATORY REPORT
FACILITY: Fountain Valley Regional Hospital Laboratory.
COLLECTED: 06/08/2024
Specimen collected. Hemoglobin 11.2 (REFERENCE RANGE 13.5-17.5) — result flag LOW.
White blood cell count within reference interval. Values reported in mg/dL where applicable.
Reviewed by: Susan Pyle, MD — Clinical Pathology.`,
  },
  {
    filename: "Uploaded_Document_11.pdf",
    // Sparse/uninformative — mimics a scanned page with almost no text layer.
    text: `Page 1 of 1. [illegible handwriting]`,
  },
];
