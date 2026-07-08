// ─────────────────────────────────────────────────────────────────────────────
// ICD-10-CM diagnosis lookup. Primary source is the NIH Clinical Tables
// ICD-10-CM API (public, no key). If it's unreachable (offline / sandboxed),
// we fall back to a curated set of diagnoses common in life-care-planning /
// injury litigation so the search still returns useful results.
// ─────────────────────────────────────────────────────────────────────────────

export interface Icd10Result {
  code: string;
  description: string;
}

const NIH_URL = "https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search";

// Curated fallback — high-frequency LCP / catastrophic-injury diagnoses.
export const LOCAL_ICD10: Icd10Result[] = [
  // Spine
  { code: "S32.010A", description: "Wedge compression fracture of first lumbar vertebra, initial encounter" },
  { code: "S32.019A", description: "Unspecified fracture of first lumbar vertebra, initial encounter" },
  { code: "S22.009A", description: "Unspecified fracture of thoracic vertebra, initial encounter" },
  { code: "S12.9XXA", description: "Fracture of neck, unspecified, initial encounter" },
  { code: "M51.26", description: "Other intervertebral disc displacement, lumbar region" },
  { code: "M54.5", description: "Low back pain" },
  { code: "T91.1", description: "Sequelae of fracture of spine" },
  // Spinal cord injury
  { code: "S14.109A", description: "Unspecified injury at unspecified level of cervical spinal cord, initial encounter" },
  { code: "S34.109A", description: "Unspecified injury to unspecified level of lumbar spinal cord, initial encounter" },
  { code: "G82.20", description: "Paraplegia, unspecified" },
  { code: "G82.50", description: "Quadriplegia, unspecified" },
  { code: "N31.9", description: "Neuromuscular dysfunction of bladder, unspecified (neurogenic bladder)" },
  // TBI
  { code: "S06.2X9A", description: "Diffuse traumatic brain injury with LOC of unspecified duration, initial encounter" },
  { code: "S06.309A", description: "Unspecified focal traumatic brain injury, initial encounter" },
  { code: "S06.9X9A", description: "Unspecified intracranial injury, initial encounter" },
  { code: "G93.1", description: "Anoxic brain damage, not elsewhere classified" },
  { code: "F07.81", description: "Postconcussional syndrome" },
  { code: "G40.909", description: "Epilepsy, unspecified, not intractable, without status epilepticus" },
  // Lower extremity / ortho
  { code: "S72.001A", description: "Fracture of unspecified part of neck of right femur, initial encounter" },
  { code: "S72.301A", description: "Unspecified fracture of shaft of right femur, initial encounter" },
  { code: "S82.101A", description: "Unspecified fracture of upper end of right tibia, initial encounter" },
  { code: "S82.201A", description: "Unspecified fracture of shaft of right tibia, initial encounter" },
  { code: "S42.201A", description: "Unspecified fracture of upper end of right humerus, initial encounter" },
  { code: "S52.501A", description: "Unspecified fracture of the lower end of right radius, initial encounter" },
  // Arthritis / arthroplasty
  { code: "M17.11", description: "Unilateral primary osteoarthritis, right knee" },
  { code: "M17.12", description: "Unilateral primary osteoarthritis, left knee" },
  { code: "M16.11", description: "Unilateral primary osteoarthritis, right hip" },
  { code: "M19.90", description: "Unspecified osteoarthritis, unspecified site" },
  { code: "Z96.651", description: "Presence of right artificial knee joint" },
  { code: "Z96.641", description: "Presence of right artificial hip joint" },
  { code: "T84.53XA", description: "Infection and inflammatory reaction due to internal right knee prosthesis, initial encounter" },
  // Amputation
  { code: "S88.111A", description: "Complete traumatic amputation at level between knee and ankle, right lower leg, initial encounter" },
  { code: "S78.111A", description: "Complete traumatic amputation at level between hip and knee, right, initial encounter" },
  { code: "Z89.511", description: "Acquired absence of right leg below knee" },
  // Pain / CRPS
  { code: "G90.50", description: "Complex regional pain syndrome I, unspecified" },
  { code: "G89.21", description: "Chronic pain due to trauma" },
  { code: "G89.4", description: "Chronic pain syndrome" },
  { code: "G58.9", description: "Mononeuropathy, unspecified (nerve injury)" },
  // Burns
  { code: "T21.30XA", description: "Burn of third degree of unspecified site of trunk, initial encounter" },
  { code: "T31.30", description: "Burns involving 30-39% of body surface with 0-9% third degree burns" },
  // Psychiatric sequelae
  { code: "F43.10", description: "Post-traumatic stress disorder, unspecified" },
  { code: "F32.9", description: "Major depressive disorder, single episode, unspecified" },
  { code: "F41.1", description: "Generalized anxiety disorder" },
  // Polytrauma / other
  { code: "T07", description: "Unspecified multiple injuries" },
  { code: "S06.0X0A", description: "Concussion without loss of consciousness, initial encounter" },
  { code: "M96.1", description: "Postlaminectomy syndrome, not elsewhere classified" },
];

function searchLocal(query: string, limit: number): Icd10Result[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/);
  return LOCAL_ICD10.filter((r) => {
    const hay = `${r.code} ${r.description}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  }).slice(0, limit);
}

export async function searchIcd10(query: string, limit = 12): Promise<{ results: Icd10Result[]; source: "nih" | "local" }> {
  const q = query.trim();
  if (q.length < 2) return { results: [], source: "local" };

  try {
    const url = `${NIH_URL}?terms=${encodeURIComponent(q)}&sf=code,name&df=code,name&maxList=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      // Response: [total, [codes], extra, [[code, name], ...]]
      const data = (await res.json()) as [number, string[], unknown, [string, string][]];
      const rows = Array.isArray(data?.[3]) ? data[3] : [];
      const results = rows.map(([code, description]) => ({ code, description }));
      if (results.length > 0) return { results, source: "nih" };
    }
  } catch {
    // fall through to local
  }

  return { results: searchLocal(q, limit), source: "local" };
}
