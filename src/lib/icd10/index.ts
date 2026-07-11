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
  // Cervical / whiplash / disc / radiculopathy
  { code: "S13.4XXA", description: "Sprain of ligaments of cervical spine (whiplash), initial encounter" },
  { code: "M50.20", description: "Other cervical disc displacement, unspecified cervical region (herniated cervical disc)" },
  { code: "M50.10", description: "Cervical disc disorder with radiculopathy, unspecified cervical region" },
  { code: "M54.12", description: "Radiculopathy, cervical region" },
  { code: "M54.16", description: "Radiculopathy, lumbar region (sciatica-type)" },
  { code: "M54.2", description: "Cervicalgia (neck pain)" },
  { code: "M48.06", description: "Spinal stenosis, lumbar region" },
  { code: "M25.561", description: "Pain in right knee" },
  // Shoulder / upper extremity
  { code: "S43.421A", description: "Sprain of right rotator cuff capsule, initial encounter" },
  { code: "M75.101", description: "Unspecified rotator cuff tear or rupture of right shoulder, not traumatic" },
  { code: "S42.001A", description: "Fracture of unspecified part of right clavicle, initial encounter" },
  { code: "S62.001A", description: "Unspecified fracture of navicular bone of right wrist, initial encounter" },
  // Lower extremity
  { code: "S82.831A", description: "Displaced fracture of medial malleolus of right tibia, initial encounter" },
  { code: "S82.6XXA", description: "Fracture of lateral malleolus, initial encounter (ankle fracture)" },
  { code: "S83.511A", description: "Sprain of anterior cruciate ligament of right knee (ACL tear), initial encounter" },
  { code: "S83.241A", description: "Other tear of medial meniscus, current injury, right knee, initial encounter" },
  // Peripheral nerve injury
  { code: "S44.01XA", description: "Injury of ulnar nerve at upper arm level, right arm, initial encounter" },
  { code: "S54.02XA", description: "Injury of ulnar nerve at forearm level, left arm, initial encounter" },
  { code: "G56.01", description: "Carpal tunnel syndrome, right upper limb" },
  // Polytrauma / other
  { code: "T07", description: "Unspecified multiple injuries" },
  { code: "S06.0X0A", description: "Concussion without loss of consciousness, initial encounter" },
  { code: "M96.1", description: "Postlaminectomy syndrome, not elsewhere classified" },
];

// Lay-term → formal ICD-verbiage expansion so keyword searches surface the right
// codes even when the user doesn't know the clinical wording. Keys are matched
// as whole words (or phrases); their terms are added to the search.
const SYNONYMS: Record<string, string[]> = {
  broken: ["fracture"], break: ["fracture"], fractured: ["fracture"], cracked: ["fracture"],
  "broken back": ["fracture vertebra spine"], "broken neck": ["fracture cervical vertebra"],
  back: ["vertebra lumbar spine dorsopathy"], neck: ["cervical"], spine: ["vertebra spinal"],
  "slipped disc": ["intervertebral disc displacement"], "herniated disc": ["intervertebral disc displacement herniation"],
  "bulging disc": ["intervertebral disc displacement"], herniated: ["displacement"], disc: ["intervertebral disc"], disk: ["intervertebral disc"],
  "pinched nerve": ["radiculopathy"], sciatica: ["radiculopathy lumbar"], whiplash: ["sprain cervical"],
  "knee replacement": ["knee arthroplasty osteoarthritis prosthesis"], "hip replacement": ["hip arthroplasty osteoarthritis prosthesis"],
  replacement: ["arthroplasty prosthesis"], arthritis: ["osteoarthritis"],
  "torn acl": ["sprain anterior cruciate ligament"], acl: ["anterior cruciate ligament"], "torn meniscus": ["tear meniscus"], meniscus: ["meniscus"],
  "rotator cuff": ["rotator cuff"], "torn rotator cuff": ["rotator cuff tear"],
  "brain injury": ["traumatic brain injury intracranial"], "head injury": ["intracranial traumatic brain injury"],
  tbi: ["traumatic brain injury"], concussion: ["concussion"], "anoxic brain": ["anoxic brain damage"],
  paralysis: ["paraplegia quadriplegia tetraplegia plegia"], paralyzed: ["paraplegia quadriplegia"],
  paraplegic: ["paraplegia"], quadriplegic: ["quadriplegia tetraplegia"], quadriplegia: ["quadriplegia tetraplegia"],
  "spinal cord injury": ["injury spinal cord"], sci: ["spinal cord"], "cord injury": ["injury spinal cord"],
  "nerve damage": ["nerve injury neuropathy mononeuropathy"], "nerve injury": ["injury nerve"], neuropathy: ["neuropathy mononeuropathy"],
  amputation: ["amputation absence"], "below knee amputation": ["amputation lower leg between knee ankle"],
  "above knee amputation": ["amputation between hip knee"], bka: ["amputation lower leg"], aka: ["amputation hip knee"],
  ptsd: ["post-traumatic stress"], depression: ["depressive"], anxiety: ["anxiety"],
  crps: ["complex regional pain"], rsd: ["complex regional pain"], "chronic pain": ["chronic pain"],
  burn: ["burn"], "neurogenic bladder": ["neuromuscular dysfunction bladder"],
  arm: ["humerus radius ulna forearm"], leg: ["femur tibia fibula"], thigh: ["femur"], shin: ["tibia"],
  shoulder: ["humerus shoulder rotator"], hip: ["hip femur acetabulum"], wrist: ["radius wrist carpal"],
  ankle: ["ankle malleolus"], collarbone: ["clavicle"], kneecap: ["patella"],
};

const QUERY_STOP = new Set(["the", "and", "with", "for", "due", "of", "to", "at", "in", "on", "a", "an", "or", "left", "right"]);

function expandTerms(q: string): string[] {
  const lower = ` ${q.toLowerCase()} `;
  const extra: string[] = [];
  for (const [key, syns] of Object.entries(SYNONYMS)) {
    const hit = key.includes(" ") ? lower.includes(` ${key} `) || lower.includes(`${key} `) || lower.includes(` ${key}`) : new RegExp(`\\b${key}\\b`).test(lower);
    if (hit) extra.push(...syns);
  }
  return extra;
}

// Distinct meaningful search tokens = the query plus its synonym expansion.
function queryTokens(q: string): string[] {
  const raw = `${q} ${expandTerms(q).join(" ")}`.toLowerCase();
  return [...new Set((raw.match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !QUERY_STOP.has(t)))];
}

function scoreEntry(r: Icd10Result, tokens: string[]): number {
  const hay = `${r.code} ${r.description}`.toLowerCase();
  let s = 0;
  for (const t of tokens) if (hay.includes(t)) s++;
  return s;
}

// Full relevance: keyword overlap dominates, then encounter-type shaping so the
// acute/primary diagnosis outranks a "history of", "sequela", "screening", or
// "birth injury" variant that happens to share the same words.
function rank(r: Icd10Result, tokens: string[]): number {
  const overlap = scoreEntry(r, tokens);
  if (overlap === 0) return -Infinity;
  const d = r.description.toLowerCase();
  let adj = 0;
  if (/initial encounter/.test(d)) adj += 3;
  if (/, sequela\b/.test(d)) adj -= 5;
  if (/subsequent encounter/.test(d)) adj -= 3;
  if (/history of|screening|personal history/.test(d)) adj -= 6;
  if (/\bbirth\b|newborn|perinatal/.test(d)) adj -= 5;
  return overlap * 10 + adj;
}

function searchLocal(query: string, tokens: string[], limit: number): Icd10Result[] {
  if (!tokens.length) return [];
  return LOCAL_ICD10.map((r) => ({ r, s: rank(r, tokens) }))
    .filter((x) => x.s > -Infinity)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);
}

async function fetchNih(term: string, limit: number): Promise<Icd10Result[] | null> {
  const url = `${NIH_URL}?terms=${encodeURIComponent(term)}&sf=code,name&df=code,name&maxList=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) return null;
  const data = (await res.json()) as [number, string[], unknown, [string, string][]];
  const rows = Array.isArray(data?.[3]) ? data[3] : [];
  return rows.map(([code, description]) => ({ code, description }));
}

/**
 * Keyword ICD-10-CM search. Expands lay terms to formal verbiage, queries the
 * NIH Clinical Tables API (original + expanded phrasing), always folds in the
 * curated offline set, de-duplicates, and re-ranks by relevance to the search
 * keywords — so codes surface even without the exact clinical wording, online
 * or offline.
 */
export async function searchIcd10(query: string, limit = 12): Promise<{ results: Icd10Result[]; source: "nih" | "local" }> {
  const q = query.trim();
  if (q.length < 2) return { results: [], source: "local" };

  const tokens = queryTokens(q);
  const expanded = [...new Set(expandTerms(q))].join(" ");
  const nihTerms = [q, ...(expanded && expanded.toLowerCase() !== q.toLowerCase() ? [expanded] : [])];

  const nih: Icd10Result[] = [];
  let nihOk = false;
  const settled = await Promise.allSettled(nihTerms.map((t) => fetchNih(t, limit)));
  for (const s of settled) if (s.status === "fulfilled" && s.value) { nih.push(...s.value); nihOk = true; }

  const local = searchLocal(q, tokens, limit);

  // Merge (NIH breadth + curated guarantees), de-dupe by code, rank by keyword
  // relevance so the on-point code isn't buried under loose NIH matches.
  const byCode = new Map<string, Icd10Result>();
  for (const r of [...nih, ...local]) if (r.code && !byCode.has(r.code)) byCode.set(r.code, r);
  const results = [...byCode.values()]
    .map((r) => ({ r, s: rank(r, tokens) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);

  return { results, source: nihOk ? "nih" : "local" };
}
