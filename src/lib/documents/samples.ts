// Demo record set. Filenames are deliberately GENERIC (Uploaded_Document_NN) so
// the "Add sample record set" action proves classification comes from the
// document body, not the title. Each `text` is a representative excerpt carrying
// the content signatures the classifier keys on.
export interface SampleDoc {
  filename: string;
  text: string;
}

export const SAMPLE_DOCS: SampleDoc[] = [
  {
    filename: "Uploaded_Document_01.pdf",
    text: `OPERATIVE REPORT
PREOPERATIVE DIAGNOSIS: Displaced tibial plateau fracture, left knee.
POSTOPERATIVE DIAGNOSIS: Same.
PROCEDURE PERFORMED: Open reduction internal fixation, left tibial plateau.
SURGEON: J. Ortho, MD.  ANESTHESIA: General.
ESTIMATED BLOOD LOSS: 150 mL. The fracture was reduced and fixed with a lateral locking plate. Closure in layers.`,
  },
  {
    filename: "Uploaded_Document_02.pdf",
    text: `MRI OF THE LUMBAR SPINE WITHOUT CONTRAST
TECHNIQUE: Multiplanar multisequence imaging of the lumbar spine.
COMPARISON: None.
FINDINGS: L1 burst fracture with retropulsion and canal compromise. No cord signal abnormality.
IMPRESSION: Acute L1 burst fracture as above. Radiologist: A. Reader, MD.`,
  },
  {
    filename: "Uploaded_Document_03.pdf",
    text: `PHYSICAL THERAPY PROGRESS NOTE
Patient tolerated therapeutic exercise. Range of motion improving. Gait training with rolling walker.
PLAN OF CARE: Continue 2x/week. SHORT-TERM GOALS: independent transfers. Home exercise program reviewed.`,
  },
  {
    filename: "Uploaded_Document_04.pdf",
    text: `EXPLANATION OF BENEFITS
DATE OF SERVICE: 03/14/2025.  CPT 27447.  TOTAL CHARGES: $42,000.00.
Adjustments: $12,300.00.  Amount billed to patient. BALANCE DUE: $1,240.00. Patient responsibility applies.`,
  },
  {
    filename: "Uploaded_Document_05.pdf",
    text: `IN THE SUPERIOR COURT OF THE STATE
DEPOSITION OF DAVID CHEN
The witness, being first duly sworn, testified as follows. EXAMINATION BY MR. SMITH:
Q. Please state your name for the court reporter.
A. David Chen.
APPEARANCES: counsel for plaintiff and defendant noted. Reporter's certificate attached.`,
  },
  {
    filename: "Uploaded_Document_06.pdf",
    text: `INDEPENDENT MEDICAL EXAMINATION
This report follows a record review and examination. History of present injury summarized below.
The claimant has reached maximum medical improvement. An impairment rating is provided within a reasonable degree of medical certainty.`,
  },
  {
    filename: "Uploaded_Document_07.pdf",
    text: `PHARMACY PRINTOUT
Prescription: Gabapentin 300 mg. SIG: take one tablet three times daily. Days supply: 30. Refills: 2.
NDC listed. Dispense as written. Pharmacy record of fills below.`,
  },
  {
    filename: "Uploaded_Document_08.pdf",
    text: `NEUROPSYCHOLOGICAL EVALUATION
A comprehensive test battery was administered including the Wechsler Adult Intelligence Scale.
Cognitive functioning and memory index scores are reported. Validity indicators were within acceptable limits.`,
  },
  {
    filename: "Uploaded_Document_09.pdf",
    text: `EMERGENCY DEPARTMENT RECORD
CHIEF COMPLAINT: Back pain after motor vehicle collision. TRIAGE level 2. Mode of arrival: ambulance.
DISPOSITION: Admitted to trauma service. Time of arrival documented.`,
  },
  {
    filename: "Uploaded_Document_10.pdf",
    text: `LABORATORY REPORT
Specimen collected. Hemoglobin 11.2 (REFERENCE RANGE 13.5-17.5) — result flag LOW.
White blood cell count within reference interval. Values reported in mg/dL where applicable.`,
  },
  {
    filename: "Uploaded_Document_11.pdf",
    // Sparse/uninformative — mimics a scanned page with almost no text layer.
    text: `Page 1 of 1. [illegible handwriting]`,
  },
];
