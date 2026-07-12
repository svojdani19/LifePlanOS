// ─────────────────────────────────────────────────────────────────────────────
// Chart segmentation — the "deeper lever" for consolidated records.
//
// A single uploaded file is often a whole hospital chart (hundreds of pages
// spanning many dated encounters AND non-clinical pages: consent forms,
// facesheets, patient-rights and privacy notices, signature/registration
// pages). Parsing it as one blob makes date-anchored summaries land on
// administrative pages and surface empty "encounters."
//
// `segmentDocument` walks the chart at ingest and separates it into typed
// SUB-DOCUMENTS — one entry per dated section — each classified as either a
// CLINICAL encounter (with an extracted finding) or an ADMINISTRATIVE page
// (consent, facesheet, rights notice, …). Administrative pages that bear on the
// diagnosis or future-care plan (surgical consent, advance directive, DME /
// discharge planning, work-status, financial-responsibility) are KEPT and
// categorized; boilerplate that carries no clinical bearing is collapsed to a
// single count rather than dropped or shown as noise.
//
// Pure functions only (no DB / React), unit-tested directly. Persisted to
// Document.segments at ingest (and after OCR) and read by the Records panel.
// Reuses the parsing primitives from recordSummary.ts so date/provider/finding
// extraction has one source of truth.
// ─────────────────────────────────────────────────────────────────────────────

import { pageMarks, pageForOffset } from "@/lib/documents/meta";
import { classifyByContent } from "@/lib/documents/classify";
import {
  S,
  section,
  clinicalText,
  clinicalSentences,
  parseAnyDate,
  mmddyyyy,
  DATE_ANCHOR,
  NON_CLINICAL_BEFORE,
  segProvider,
  cleanFacility,
  cleanFinding,
} from "@/lib/documents/recordSummary";

export interface DocumentSegment {
  date: string | null; // ISO "YYYY-MM-DD"
  label: string; // display date, e.g. "10/21/2025"
  pageStart: number | null;
  pageEnd: number | null;
  kind: "clinical" | "administrative";
  /** Classified sub-document type (clinical) or the admin category (administrative). */
  type: string;
  /** Administrative category label; null for clinical encounters. */
  category: string | null;
  /** Does this bear on the diagnosis / future-care plan? Always true for clinical. */
  bearsOnCare: boolean;
  provider: string | null;
  facility: string | null;
  summary: string;
}

// Administrative page signatures, most specific first. `bears` marks pages that
// have real bearing on the diagnosis or the future-care plan (kept and shown);
// the rest is standard boilerplate (collapsed to a count in the UI).
// `preempt` marks a pure-form signature (consent, rights, privacy, facesheet,
// signature block, advance directive) that outranks a stray clinical cue — a
// surgical-consent page names the procedure but is still a consent, not an
// encounter. Care-relevant classes that usually carry real clinician text (DME,
// work status, financial) do NOT pre-empt, so a genuine instruction ("patient
// needs a bedside commode") is kept as clinical with its specifics.
const ADMIN_PATTERNS: { category: string; bears: boolean; preempt: boolean; re: RegExp; capture?: RegExp }[] = [
  {
    category: "Surgical / procedure consent",
    bears: true,
    preempt: true,
    re: /informed consent|consent (?:to|for) (?:the )?(?:surgery|operat|procedure|anesthes|transfusion|sedation|treatment)|surgical consent|operative consent|authorization (?:for|to perform)/i,
    capture: /consent (?:to|for)\s+(?:the\s+)?([a-z][a-z0-9 ,'\/-]{4,70}?)(?=[.\n]|\bwas\b|\bis\b|$)/i,
  },
  {
    category: "Advance directive / code status",
    bears: true,
    preempt: true,
    re: /advance directive|living will|do not resuscitate|\bDNR\b|health\s?care power of attorney|\bPOLST\b|code status/i,
  },
  {
    category: "DME / discharge planning",
    bears: true,
    preempt: false,
    re: /\bwalker\b|wheelchair|bedside commode|\bBSC\b|durable medical equipment|\bDME\b|home health|discharge planning|case management|transportation (?:to|home|arrang)/i,
  },
  {
    category: "Work status / disability",
    bears: true,
    preempt: false,
    re: /work status|return to work|\bFMLA\b|off\s?work|disability (?:form|note|status|paperwork)|light duty|work restriction/i,
  },
  {
    category: "Financial responsibility",
    bears: true,
    preempt: false,
    re: /financial responsibilit|assignment of benefits|estimate of charges|advance beneficiary notice|\bABN\b|self-?pay agreement/i,
  },
  { category: "Patient education / instructions", bears: false, preempt: true, re: /the doctor may order|how to care for (?:your|the)|call your (?:doctor|provider|nurse)|multiple dose vials|discard the (?:multiple|vial|unused)|when to call your|warning signs|home care instructions|medication guide|drug information sheet/i },
  { category: "Facesheet / demographics", bears: false, preempt: true, re: /face\s?sheet|account number.{0,40}med rec|guarantor|demographic|registration (?:form|record)/i },
  { category: "Patient rights & responsibilities", bears: false, preempt: true, re: /patient rights and responsibilit|rights and responsibilities/i },
  { category: "Privacy / HIPAA notice", bears: false, preempt: true, re: /notice of privacy practices|\bHIPAA\b|protected health information/i },
  { category: "Nondiscrimination notice", bears: false, preempt: true, re: /civil rights laws|does not discriminate|nondiscriminat|section 1557/i },
  { category: "Signature / acknowledgement", bears: false, preempt: true, re: /signature\s+date|representative'?s signature|patient signature|acknowledge?ment|witness signature/i },
];

// A candidate finding must carry a real clinical signal to count as a clinical
// encounter; otherwise the dated page is administrative/ancillary noise (consent
// checklists, patient-education leaflets, table headers, rights notices) that a
// naive sentence grab would otherwise mislabel as clinical on a messy OCR scan.
const CLINICAL_CUE =
  /\b(pain|fracture|arthroplasty|revision|post-?op|pre-?op|preoperative|postoperative|surger|surgical|diagnos|assess(?:ment|ed)|impression|exam(?:ination)?|tender|swelling|edema|effusion|range of motion|\bROM\b|gait|ambulat|weight-?bearing|therapy|rehab|\bMRI\b|\bCT\b|x-?ray|radiograph|imaging|infection|wound|incision|prosthes|loosening|neuro|motor|sensory|strength|deficit|complaint|symptom|admitt|admission|discharge(?:d)?|procedure|operative|anesthes|medication|prescrib|administered|\bdose\b|vital sign|blood pressure|follow-?up|plan of care|consult|evaluation|history of present|reports?\s|denies|complains?\s|presents?\s|underwent|status post|\bs\/p\b|commode|\bwalker\b|wheelchair|\bDME\b|durable medical equipment|home health|orthos|\bbrace\b|crutch|\bcane\b|hospital bed|dressing|mepilex)\b/i;

// Reject leads that mark boilerplate, patient-facing education, or table/scan
// fragments rather than clinician documentation.
const NOISE_LEAD =
  /^(?:or\b|to be\b|to file|to participate|i (?:can|will|understand|have the right)|please\b|you (?:have|may|can|will)|we (?:will|are)|your\b|this (?:notice|form|document|information|medication|will)|the (?:above|following) (?:information|consent)|what\b|do not\b|during pregnancy|taking this|@|®|«|»|•|\*|▪|·|-\s|days hours|diagnosis code|accession number|route\b|code (?:name|set)|total doses|med rec|account (?:number|no))/i;

// Recognizable non-clinical boilerplate classes that recur verbatim across a
// consolidated chart — privacy/rights notices, drug-information leaflets, OCR'd
// report headers, arbitration/authorization language, and template instructions.
// Matched anywhere in the candidate.
const NOISE_PHRASE =
  /to file a complaint|to participate in resolving|privacy officer|release of (?:necessary )?(?:medical )?information|authorize the release|agree arbitration|arbitration will|common brand name|this medication|medication discharge summary|\bUSER:|event acknowledged|order is entered and signed|for consistency in documentation|patient education|discharge instructions|about this topic|contact hicuity|office for civil rights|human services|this consent to receive|smallest effective dose|products that may interact|report pain and the results|check all (?:prescription|medicine)|undersigned understands|injection site may occur|properly stop the medication|different medication may be necessary|these include (?:a fever|swelling|redness|increased)|such reactions include|skin wheal may be injected|requires further clarification|will (?:verbalize|experience|demonstrate|maintain|tolerate|remain free|be able)|verbalize understanding|please specify|clinically undetermined|of critically ill patients|first day of icu|signs and symptoms of infection|medications work best|first signs of pain|this will help with|missed dose|next dose|skip the (?:missed|dose)|if it is near/i;

// Report headers, footers, routing lines, and empty templates — structure a
// chart repeats around real notes but that carry no clinical finding.
const NOISE_HEADER =
  /transcriptionist|\bTD\/TT\b|report\s*#|department\s*:|accession number|procedure\(s\)\s*:|\bcc\s*:\s*[A-Za-z]|meditech|attending dr\b|order source|discharge attending|dictated by|electronically signed|report status|\bMRN\b|highway \d+|order is entered|response\/?\s*assessment\.?\s*$|subj(?:ective)?\s+subjective|see also|teaching record|risk level|order\b.*\bsigned\b|surgical chart|chart page|\bPPHS\b/i;

// Medication-administration / order-sheet fragments and I/O tables — dense,
// abbreviation-heavy grids that OCR mangles into non-clinical noise.
const NOISE_MAR =
  /\.STK-MED|once\/prn|q\d+h\/prn|\bPRN\b.*\bPRN\b|as directed iv|high alert medication|not administered|cumulative (?:dose|intake)|container volume|infiltratn|dose ins|\bFSBS\b|sliding scale|\bNPO\b since|postop orders|level of consci|awake 2 alert/i;

// Garbled OCR: a candidate with too many vowel-less, mid-word-capitalized, or
// long all-caps tokens (e.g. "PERCOCET cxyOCDORE BCL/ACETRMIN") is unreadable.
function tooGarbled(s: string): boolean {
  const toks = s.match(/[A-Za-z][A-Za-z'-]+/g) ?? [];
  if (toks.length < 3) return false;
  let bad = 0;
  for (const w of toks) {
    if (!/[aeiou]/i.test(w) || /[a-z][A-Z]/.test(w) || /^[A-Z]{5,}$/.test(w)) bad++;
  }
  return bad / toks.length > 0.28;
}

// Patient-facing / legal-agreement voice: consent, education leaflets, rights
// notices, and arbitration agreements address the reader ("you/your", "I
// agree/understand"). Clinician documentation is third-person about the patient,
// so any of these anywhere in the candidate marks it as non-clinical prose.
const PATIENT_FACING =
  /\b(?:you|your|yourself)\b|\bi (?:can|will|understand|agree|have|may|should|acknowledge|consent|authorize)\b|wash your hands|call your (?:doctor|provider)|common brand name|warning:/i;

// Broadened clinical-finding extraction (improvement "B"): the labeled-section
// set covers nursing / therapy / case-management phrasing in addition to the
// classic SOAP labels; a free-sentence fallback is accepted ONLY when it carries
// a clinical cue and is not boilerplate/table noise.
const okFinding = (s: string | null): s is string =>
  !!s && !NOISE_LEAD.test(s) && !PATIENT_FACING.test(s) && !NOISE_PHRASE.test(s) && !NOISE_HEADER.test(s) && !NOISE_MAR.test(s) && !tooGarbled(s);

// The labeled clinical section — highest-precision signal, and the one that lets
// a real op note / H&P outrank a consent page that merely names the procedure.
function labeledClinical(seg: string): string | null {
  const labeled = cleanFinding(
    section(
      clinicalText(seg),
      S("chief complaint"),
      S("procedure performed"),
      S("impression"),
      S("clinical impression"),
      S("assessment"),
      S("plan of care"),
      S("reason for (?:visit|admission|referral|consult)"),
      S("findings"),
      S("history of present illness"),
      S("\\bhpi\\b"),
      S("interval history"),
      S("pre-?op(?:erative)? diagnos[ei]s"),
      S("post-?op(?:erative)? diagnos[ei]s"),
      S("diagnos[ei]s"),
      S("disposition"),
    ),
  );
  return okFinding(labeled) ? labeled : null;
}

// A free-sentence fallback, accepted only when clinician-voiced (a clinical cue,
// not boilerplate, not patient-facing) and substantive.
function sentenceClinical(seg: string): string | null {
  for (const raw of clinicalText(seg).split(/(?<=[.!?])\s+/)) {
    // A sentence whose RAW text begins lowercase (after leading punctuation) is
    // a mid-sentence fragment (", or requires…", "). * the…") — skip it. This is
    // checked before cleanFinding, which legitimately strips a leading label
    // ("Progress note: patient advancing…" → "patient advancing…").
    const rawTrim = raw.replace(/^[^A-Za-z0-9]+/, "");
    if (/^[a-z]/.test(rawTrim) && !/^(?:s\/p\b|pt\b)/i.test(rawTrim)) continue;
    const cand = cleanFinding(raw);
    if (okFinding(cand) && cand.length >= 25 && CLINICAL_CUE.test(cand)) return cand;
  }
  return null;
}

// Match a boilerplate signature; null when none applies (a catch-all is decided
// separately, so a genuine clinical page is never forced into "administrative").
function matchAdmin(seg: string): { category: string; bears: boolean; preempt: boolean; summary: string } | null {
  // A pre-empting form (consent, education, rights, facesheet) outranks a
  // non-pre-empting care-relevant match (DME/work/financial) even when the
  // latter appears earlier — an education leaflet mentioning "home health" is
  // still a leaflet, not a DME encounter.
  for (const p of [...ADMIN_PATTERNS].sort((a, b) => Number(b.preempt) - Number(a.preempt))) {
    if (p.re.test(seg)) {
      let summary = p.category;
      if (p.capture) {
        const m = seg.match(p.capture);
        const v = m?.[1]?.replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "");
        if (v && v.length > 3 && !/name|date|patient|sign|includ|authoriz|receiv|understand|perform|addition|any test|such|the (?:under|following)/i.test(v)) summary = `${p.category}: ${v}`;
      }
      return { category: p.category, bears: p.bears, preempt: p.preempt, summary };
    }
  }
  return null;
}

const CLINICAL_FALLBACK_TYPE = "MEDICAL_RECORD";

/**
 * Split a consolidated chart into typed sub-documents. Returns null when the
 * text is not consolidated (fewer than two distinct dated sections) — those
 * records render as a single narrative, unchanged.
 */
export function segmentDocument(text: string | null | undefined): DocumentSegment[] | null {
  const t = String(text || "");
  if (t.length < 80) return null;
  const marks = pageMarks(t);

  // Anchor every dated section (not merged by date: the same calendar date can
  // host both a clinical encounter and a consent page in a big chart).
  const anchors: { off: number; date: Date }[] = [];
  const re = new RegExp(DATE_ANCHOR.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (NON_CLINICAL_BEFORE.test(t.slice(Math.max(0, m.index - 14), m.index))) continue;
    const dt = parseAnyDate(m[1].trim());
    if (dt) anchors.push({ off: m.index, date: dt });
  }
  const distinctDates = new Set(anchors.map((a) => a.date.getTime()));
  if (anchors.length < 2 || distinctDates.size < 2) return null;

  // One raw segment per anchor: [anchor, next anchor).
  const raw: DocumentSegment[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const off = anchors[i].off;
    const end = i + 1 < anchors.length ? anchors[i + 1].off : t.length;
    const seg = t.slice(off, end);
    if (seg.length < 12) continue;
    const date = anchors[i].date;
    const pageStart = pageForOffset(off, marks);
    const pageEnd = pageForOffset(Math.max(off, end - 1), marks);

    const common = {
      date: date.toISOString().slice(0, 10),
      label: mmddyyyy(date),
      pageStart,
      pageEnd,
      facility: cleanFacility(seg.match(/\b(?:facility|location)\s*:?\s*([^\n]{3,80})/i)?.[1]),
    };
    const pushClinical = (finding: string) => {
      const cls = classifyByContent(seg);
      raw.push({
        ...common,
        kind: "clinical",
        type: cls.score > 0 ? cls.type : CLINICAL_FALLBACK_TYPE,
        category: null,
        bearsOnCare: true,
        provider: segProvider(seg),
        summary: `${finding[0].toUpperCase()}${finding.slice(1)}${/[.!?]$/.test(finding) ? "" : "."}`,
      });
    };
    const pushAdmin = (category: string, bears: boolean, summary: string) =>
      raw.push({ ...common, kind: "administrative", type: category, category, bearsOnCare: bears, provider: null, summary });

    // Decision order: a labeled clinical section wins (a real op note / H&P
    // beats a consent that names the procedure) → a pre-empting boilerplate form
    // (consent, rights, privacy, facesheet) → a clinician-voiced sentence → a
    // non-pre-empting care-relevant form (DME / work / financial) → catch-all.
    const labeled = labeledClinical(seg);
    const admin = matchAdmin(seg);
    if (labeled) {
      pushClinical(labeled);
    } else if (admin?.preempt) {
      pushAdmin(admin.category, admin.bears, admin.summary);
    } else {
      const sentence = sentenceClinical(seg);
      if (sentence) pushClinical(sentence);
      else if (admin) pushAdmin(admin.category, admin.bears, admin.summary);
      else if (CLINICAL_CUE.test(seg)) pushAdmin("Ancillary clinical page", false, "Ancillary clinical page");
      else pushAdmin("Administrative", false, "Administrative page");
    }
  }

  // Collapse consecutive sub-documents that are the same date + kind + category
  // + provider (a multi-page encounter or a repeated boilerplate block), merging
  // their page ranges and keeping the most informative summary.
  const out: DocumentSegment[] = [];
  for (const s of raw) {
    const prev = out[out.length - 1];
    const sameGroup =
      prev &&
      prev.date === s.date &&
      prev.kind === s.kind &&
      prev.category === s.category &&
      prev.provider === s.provider;
    if (sameGroup) {
      prev.pageEnd = s.pageEnd ?? prev.pageEnd;
      if (s.summary.length > prev.summary.length) prev.summary = s.summary;
      if (!prev.facility && s.facility) prev.facility = s.facility;
      continue;
    }
    out.push({ ...s });
  }

  // Drop near-duplicate clinical encounters on the same date (the same note
  // reprinted across pages), keyed by date + a normalized summary prefix.
  const seen = new Set<string>();
  const deduped = out.filter((s) => {
    if (s.kind !== "clinical") return true;
    const key = `${s.date}|${s.summary.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 45)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || (a.pageStart ?? 0) - (b.pageStart ?? 0));
  return deduped;
}
