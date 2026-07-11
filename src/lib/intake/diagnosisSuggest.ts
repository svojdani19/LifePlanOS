// ─────────────────────────────────────────────────────────────────────────────
// Diagnosis suggestions from the ingested records. Scans the CONTENT of every
// record (clinical sections only — past-medical-history is stripped so prior
// conditions are not proposed as injury diagnoses) for diagnoses that could be
// added to the intake, each mapped to its ICD-10-CM code. Suggestions the user
// approves are written to the case and flow into the AI pipeline via the
// diagnosis corpus on the next run.
// ─────────────────────────────────────────────────────────────────────────────

export interface DiagnosisSuggestion {
  diagnosis: string;
  icd10Code: string;
  /** filenames of the records the diagnosis was found in */
  sources: string[];
}

// Curated content-pattern → diagnosis map (initial encounter codes where the
// injury context implies it). Patterns run against clinical text only.
const DIAGNOSIS_PATTERNS: { re: RegExp; diagnosis: string; icd10: string }[] = [
  { re: /\bl1\b[^.]{0,40}burst fracture|burst fracture[^.]{0,40}\bl1\b/i, diagnosis: "Burst fracture of first lumbar vertebra", icd10: "S32.012A" },
  { re: /\b(l[2-5])\b[^.]{0,40}(compression|burst) fracture|(compression|burst) fracture[^.]{0,40}\bl[2-5]\b/i, diagnosis: "Fracture of lumbar vertebra", icd10: "S32.009A" },
  { re: /tibial plateau fracture/i, diagnosis: "Fracture of tibial plateau", icd10: "S82.101A" },
  { re: /spinal cord injur|\bincomplete sci\b|cord (syndrome|contusion)/i, diagnosis: "Incomplete spinal cord injury, lumbar", icd10: "S34.129A" },
  { re: /cervical[^.]{0,30}(herniat|radiculopath)|radiculopath[^.]{0,30}cervical/i, diagnosis: "Cervical disc disorder with radiculopathy", icd10: "M50.10" },
  { re: /lumbar[^.]{0,30}radiculopath|radiculopath[^.]{0,30}lumbar|\bsciatica\b/i, diagnosis: "Lumbar radiculopathy", icd10: "M54.16" },
  { re: /lumbar (spinal )?stenosis|neurogenic claudication/i, diagnosis: "Lumbar spinal stenosis with neurogenic claudication", icd10: "M48.062" },
  { re: /\bconcussion\b|closed head injur|traumatic brain injur|\btbi\b|postconcuss/i, diagnosis: "Concussion / mild traumatic brain injury", icd10: "S06.0X0A" },
  { re: /post-?traumatic headache|\bmigraine\b|status migrainosus/i, diagnosis: "Post-traumatic headache", icd10: "G44.309" },
  { re: /rotator cuff (tear|repair|rupture)/i, diagnosis: "Rotator cuff tear, right shoulder", icd10: "S46.011A" },
  { re: /shoulder impingement/i, diagnosis: "Shoulder impingement syndrome", icd10: "M75.40" },
  { re: /total knee arthroplasty|\btka\b|knee replacement/i, diagnosis: "Post-traumatic osteoarthritis of knee, status post arthroplasty", icd10: "M17.31" },
  { re: /\bcrps\b|complex regional pain/i, diagnosis: "Complex regional pain syndrome, lower limb", icd10: "G90.529" },
  { re: /transtibial amputation|below[- ]knee amputation|\bbka\b/i, diagnosis: "Traumatic transtibial amputation", icd10: "S88.111A" },
  { re: /\bptsd\b|post-?traumatic stress/i, diagnosis: "Post-traumatic stress disorder", icd10: "F43.10" },
  { re: /neurogenic bladder/i, diagnosis: "Neurogenic bladder", icd10: "N31.9" },
  { re: /peripheral neuropath|polyneuropath/i, diagnosis: "Post-traumatic peripheral neuropathy", icd10: "G62.9" },
  { re: /chronic pain syndrome/i, diagnosis: "Chronic pain syndrome", icd10: "G89.4" },
  { re: /(vertigo|vestibular)[^.]{0,40}(post-?traumatic|injur)|(post-?traumatic|injur)[^.]{0,40}vertigo/i, diagnosis: "Post-traumatic vertigo", icd10: "H81.90" },
  { re: /adjustment disorder|major depressive|\banxiety disorder\b/i, diagnosis: "Adjustment disorder with anxiety and depressed mood", icd10: "F43.23" },
];

// Strip past-medical-history sections so prior conditions are not suggested as
// injury diagnoses (mirrors the pre-existing detector's scoping).
function clinicalOnly(text: string): string {
  return text.replace(
    /(past\s+medical(?:\s*\/?\s*surgical)?\s+history|past\s+surgical\s+history|previous\s+medical\s+history|\bpmhx?\b)\s*[:\-]?[\s\S]{0,500}?(?=\n\s*\n|\b[A-Z][A-Z /]{3,}:|$)/gi,
    " ",
  );
}

const tokens = (s: string) => new Set((s.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((t) => !["with", "the", "and", "post", "status", "initial", "right", "left"].includes(t)));
function overlaps(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return false;
  const inter = [...ta].filter((x) => tb.has(x)).length;
  // Same diagnosis when they share ≥2 significant terms covering half the shorter name.
  return inter >= 2 && inter / Math.min(ta.size, tb.size) >= 0.5;
}

/**
 * Diagnoses supported by the record content that are not already on the case.
 * `existing` = current primary + additional diagnoses (text + codes).
 */
export function suggestDiagnoses(
  docs: { filename: string; extractedText?: string | null }[],
  existing: { diagnosis?: string | null; icd10Code?: string | null }[],
): DiagnosisSuggestion[] {
  const found = new Map<string, DiagnosisSuggestion>();
  for (const d of docs) {
    const text = clinicalOnly(String(d.extractedText ?? ""));
    if (text.length < 30) continue;
    for (const p of DIAGNOSIS_PATTERNS) {
      if (!p.re.test(text)) continue;
      const e = found.get(p.icd10) ?? { diagnosis: p.diagnosis, icd10Code: p.icd10, sources: [] };
      if (!e.sources.includes(d.filename)) e.sources.push(d.filename);
      found.set(p.icd10, e);
    }
  }
  return [...found.values()].filter(
    (s) =>
      !existing.some(
        (e) => (e.icd10Code && e.icd10Code.toUpperCase() === s.icd10Code.toUpperCase()) || (e.diagnosis && overlaps(e.diagnosis, s.diagnosis)),
      ),
  );
}
