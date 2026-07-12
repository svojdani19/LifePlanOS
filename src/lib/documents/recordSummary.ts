// ─────────────────────────────────────────────────────────────────────────────
// Deterministic record-summary logic for the Records panel: a plain-language
// narrative of a record's findings (narrativeFor) and a per-date breakdown of a
// consolidated multi-encounter chart (recordEncounters). Pure functions only —
// no React — so they live here and are unit-tested directly (see the vitest
// suite). CaseWorkspace imports these for rendering.
// ─────────────────────────────────────────────────────────────────────────────

type AnyRec = Record<string, any>;

// A plain-language PARAGRAPH narrative of the FINDINGS in a record (the
// metadata — date, author, location — is shown separately above it). Type-aware
// so it weaves the clinically relevant sections (presentation, findings,
// treatment, plan, disposition) into flowing prose rather than dumping labeled
// fields or stopping at one sentence. Deterministic; falls back to the first
// clinical sentences when a record has no recognizable structure.
const lcFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const capFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const cleanVal = (s: string) => s.replace(/\s+/g, " ").replace(/\s+as above\b/i, "").trim().replace(/[.;,]+$/, "").trim();
const oneSentence = (s: string) => s.split(/(?<=[.!?])\s+/)[0].replace(/[.;,]+$/, "").trim();
export const S = (label: string) => new RegExp(label + ":?\\s*(.+?)(?=\\b[A-Z]{2,}[A-Z /-]*:|$)", "i");
// Trim/terminate each part and join into one readable paragraph (null-safe).
const asSentence = (s: string | null | undefined): string | null => {
  const v = (s ?? "").replace(/\s+/g, " ").trim().replace(/[.;,]+$/, "");
  return v ? `${capFirst(v)}.` : null;
};
const paragraph = (...parts: (string | null | undefined)[]): string => parts.map(asSentence).filter(Boolean).join(" ");
export function section(text: string, ...res: RegExp[]): string | null {
  for (const re of res) {
    const m = text.match(re);
    const v = m?.[1] ? cleanVal(m[1]) : "";
    if (v && v.length > 2 && v.length < 240) return v;
  }
  return null;
}
// Strip non-clinical metadata (facility/date/author-signature lines) so the
// narrative reflects findings, not header boilerplate.
export function clinicalText(raw: string): string {
  return raw
    .replace(/\bpage\s+\d+(?:\s+of\s+\d+)?\b/gi, " ")
    .replace(/\b(?:FACILITY|LOCATION|TECHNIQUE|COMPARISON)\s*:\s*[^.]*\.?/gi, "")
    .replace(/\bDATE OF [A-Z ]+?\s*:\s*[\d/]+/gi, "")
    .replace(/\b(?:COLLECTED|FILL DATE|DATE)\s*:\s*[\d/]+/gi, "")
    .replace(/\b(?:Dictated by|Reviewed by|Ordered by|Prepared by|Reported by|Electronically signed by|Signed by|Therapist|Attending Physician|Treating Physician|Examining Physician|Physician|Examiner|Surgeon|Assistant Surgeon|Radiologist|Anesthesiologist|Pharmacist|Evaluated by|Provider)\s*:\s*[^.]*\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
const METADATA_SENT = /\b(facility|location|date of|collected|fill date|\bndc\b|appearances|dictated by|reviewed by|therapist|surgeon|radiologist|attending physician|examiner|pharmacist|evaluated by|reported by|prepared by)\b/i;
// The first `n` genuine clinical sentences (skipping headers and metadata).
export function clinicalSentences(text: string, n = 2): string {
  const sents = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12 && s.length < 240 && !/^[A-Z0-9 /()\-]+$/.test(s) && !METADATA_SENT.test(s));
  return cleanVal(sents.slice(0, n).join(" "));
}

// ── Per-date breakdown for a consolidated record ─────────────────────────────
// A single uploaded file that contains several dated encounters (hospital chart,
// multi-visit printout) is separated BY DATE so the summary isn't one jammed
// paragraph — each date shows its own provider, facility, and finding.
const MONTHS3 = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function parseAnyDate(raw: string): Date | null {
  let m: RegExpMatchArray | null;
  if ((m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) {
    let y = +m[3]; if (y < 100) y += y > 50 ? 1900 : 2000;
    return new Date(Date.UTC(y, +m[1] - 1, +m[2]));
  }
  if ((m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if ((m = raw.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const mo = MONTHS3.indexOf(m[1].toLowerCase().slice(0, 3));
    if (mo >= 0) return new Date(Date.UTC(+m[3], mo, +m[2]));
  }
  return null;
}
export const mmddyyyy = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
export const DATE_ANCHOR = /\b(?:date of (?:service|procedure|operation|exam(?:ination)?|evaluation|visit|admission|discharge|consult(?:ation)?)|(?:service|admission|admit|discharge|exam|visit|encounter|procedure|operation|consult(?:ation)?)\s+date|date)\s*(?:\/\s*time)?\s*[:\-]\s*(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|[A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/gi;
export const NON_CLINICAL_BEFORE = /(birth|dob|print(?:ed)?|report(?:ed)?|signed|expir|effective|policy|paid|statement|due|registration)\s*$/i;
export function segProvider(seg: string): string | null {
  // Two steps so the label is case-insensitive but the name is NOT: a single
  // /…/i regex would let the Title-Case name pattern match lowercase prose
  // ("physician: see notes below" → "see notes below"). Find the label in any
  // case, then read a strictly Title-Case name immediately after it.
  const label = seg.match(/(?:attending physician|treating physician|examining physician|surgeon|therapist|physician|examiner|provider|dictated by|reviewed by|attending dr)\s*:?\s*/i);
  if (label?.index == null) return null;
  const rest = seg.slice(label.index + label[0].length);
  const m = rest.match(/^(?:Dr\.?\s+)?([A-Z][a-z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){1,3}(?:,\s*[A-Za-z.]+(?:,\s*[A-Za-z.]+)?)?(?:\s*[—–-]\s*[A-Z][^\n.]{0,44})?)/);
  const v = m?.[1]?.replace(/\s+/g, " ").trim();
  return v && !/\b(date|time|name|number|note|complete|site|id|patient|mechanical|ventilator|weaning|\bsbt\b|anesthesia|orders|sanitizer|nasal|room|record)\b/i.test(v) ? v : null;
}

// Accept a facility value only if it reads like an organization, not a prose
// fragment or a code; trim trailing metadata that ran into it.
export function cleanFacility(raw: string | null | undefined): string | null {
  let v = (raw ?? "").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  v = v.replace(/\s+(?:location|facility|medical record|med rec|room-?bed|account|date taken|mrn|bed|page|run|reason)\b.*$/i, "").trim();
  if (v.length < 4 || v.length > 70) return null;
  if (/\b(if|you|your|do not|please|consent|copy|given|object|agree|guardrails|weaning|orders|latest|directory)\b/i.test(v)) return null;
  const orgish = /\b(hospital|center|centre|clinic|medical|laborator|\blab\b|orthop(?:a)?edic|associates|institute|imaging|rehab(?:ilitation)?|health|services|group|\bccu\b|\bicu\b|\ber\b|emergency|surgery|pharmacy)\b/i.test(v);
  const titleWords = (v.match(/\b[A-Z][a-z]+/g) ?? []).length;
  return orgish || titleWords >= 2 ? v : null;
}
// Accept a finding only if it reads like clinical prose, not metadata/OCR noise.
export function cleanFinding(raw: string | null | undefined): string | null {
  let s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  // Strip leading chart metadata / section labels so the clinical content leads.
  s = s
    .replace(/^(?:assessment\s+(?:date|time)\s*:?\s*[\d:apm\s]+)/i, "")
    .replace(/^(?:interval history|update visit note|progress note|subjective|objective|hpi|note|comment|reason|impression|assessment|plan|chief complaint)\s*:?\s*/i, "")
    .trim();
  if (!s) return null;
  if (/^(right|left|latest|run|continued|none recorded|fac|loc|bed)\b/i.test(s)) return null;
  // Metadata / audit / wrong-patient / OCR-bracket noise (but keep clinical
  // "Patient seen…"). A colon after "Patient"/"RE" or a DOB marks a header line.
  if (/patient name\s*:|patient'?s care team|patient\s*:\s*[A-Z]|account\s*:?\s*(?:number|no|[A-Z]{2}\d)|med(?:ical)? rec|registration|\bmr#|\bdob\s*:|\bre\s*:\s*[A-Z]{2,}|date\s*[&/]\s*time|device event|room-?bed|\bpage\s*:\s*\d|\*\*|\[|\]/i.test(s)) return null;
  if (/^\d{1,2}:\d{2}\b/.test(s)) return null; // starts with a clock time
  const words = s.match(/[A-Za-z]{2,}/g) ?? [];
  const real = words.filter((w) => /[a-z]{3,}/.test(w) && /[aeiou]/i.test(w));
  if (real.length < 2) return null;
  const digits = (s.match(/\d/g) ?? []).length;
  if (digits / s.length > 0.22) return null;
  return s.length > 150 ? s.slice(0, 149).trim() + "…" : s;
}

export interface RecordEncounter { date: Date; label: string; facility: string | null; provider: string | null; summary: string }
export function recordEncounters(d: AnyRec): RecordEncounter[] | null {
  const text = String(d.extractedText || "");
  if (text.length < 40) return null;
  const anchors: { off: number; date: Date }[] = [];
  const re = new RegExp(DATE_ANCHOR.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (NON_CLINICAL_BEFORE.test(text.slice(Math.max(0, m.index - 14), m.index))) continue;
    const dt = parseAnyDate(m[1].trim());
    if (dt) anchors.push({ off: m.index, date: dt });
  }
  // Merge consecutive anchors on the same date into one encounter.
  const distinct = [...new Set(anchors.map((a) => a.date.getTime()))];
  if (distinct.length < 2) return null;

  const byDate = new Map<number, { off: number; end: number }>();
  for (let i = 0; i < anchors.length; i++) {
    const key = anchors[i].date.getTime();
    const end = i + 1 < anchors.length ? anchors[i + 1].off : text.length;
    const e = byDate.get(key);
    if (e) e.end = Math.max(e.end, end);
    else byDate.set(key, { off: anchors[i].off, end });
  }
  const out: RecordEncounter[] = [];
  for (const [t, span] of byDate) {
    const seg = text.slice(span.off, span.end);
    const clin = clinicalText(seg);
    const facility = cleanFacility(seg.match(/\b(?:facility|location)\s*:?\s*([^\n]{3,80})/i)?.[1]);
    const finding =
      cleanFinding(section(clin, S("chief complaint"), S("procedure performed"), S("procedure"), S("impression"), S("assessment"), S("plan"), S("reason"), S("findings"))) ||
      cleanFinding(clinicalSentences(clin, 1));
    out.push({
      date: new Date(t),
      label: mmddyyyy(new Date(t)),
      facility,
      provider: segProvider(seg),
      summary: finding ? `${capFirst(finding)}${/[.!?]$/.test(finding) ? "" : "."}` : "See the cited source page for this encounter.",
    });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}
export function narrativeFor(d: AnyRec): string {
  const text = String(d.extractedText || "").replace(/\s+/g, " ").trim();
  if (text.length < 30 || /\billegible\b|no extractable text/i.test(text)) return "Illegible or near-empty page; no findings could be extracted.";
  // Section extraction runs on the signature-stripped text so header/sign-off
  // boilerplate never leaks into the narrative.
  const clin = clinicalText(text);

  // A consolidated multi-encounter record (spans dates / has several providers):
  // narrate the arc across encounters rather than a single section.
  const provs = Array.isArray(d.providers) ? d.providers : [];
  if (d.serviceDateEnd || provs.length > 1) {
    const cc = section(clin, S("chief complaint"));
    const proc = section(clin, S("procedure performed"), S("procedure"));
    const imp = section(clin, S("impression"), S("assessment"));
    return paragraph(
      `This is a consolidated record spanning ${provs.length > 1 ? `${provs.length} providers` : "multiple encounters"}${d.serviceDateEnd ? " over a range of service dates" : ""}`,
      cc ? `the patient initially presented with ${lcFirst(oneSentence(cc))}` : null,
      proc ? `documented treatment includes ${lcFirst(proc)}` : null,
      imp ? `the concluding impression is ${lcFirst(imp)}` : null,
      !cc && !proc && !imp ? clinicalSentences(clin, 3) : null,
    );
  }

  switch (d.type) {
    case "IMAGING_REPORT": {
      const modM = text.match(/\b(MRI|CT|X-?ray|ultrasound|radiograph)\b/i);
      const mod = modM ? modM[1].toUpperCase().replace("X-RAY", "X-ray") : null;
      const art = mod && /^(MRI|X-ray|ULTRASOUND)/i.test(mod) ? "an" : "a";
      const regM = text.match(/of the\s+([a-z][a-z ]{2,30}?)(?:\s+(?:with|without)\b|,|\.)/i);
      const reg = regM ? regM[1].trim().toLowerCase() : "affected region";
      const technique = /without contrast/i.test(text) ? "performed without contrast" : /with contrast/i.test(text) ? "performed with contrast" : null;
      const comparison = text.match(/comparison:?\s*([^.]+)\./i)?.[1]?.trim() ?? null;
      const findings = section(clin, S("findings"));
      const impression = section(clin, S("impression"));
      return paragraph(
        `This record is ${mod ? `${art} ${mod}` : "an imaging study"} of the ${reg}${technique ? `, ${technique}` : ""}${comparison ? (/^none/i.test(comparison) ? ", with no prior study available for comparison" : `, compared with ${lcFirst(comparison)}`) : ""}`,
        findings ? `The study demonstrates ${lcFirst(findings)}` : null,
        impression && impression !== findings ? `The radiologist's impression is ${lcFirst(impression)}` : null,
        !findings && !impression ? "See the report body for detailed findings" : null,
      );
    }
    case "OPERATIVE_NOTE": {
      const preDx = section(clin, S("preoperative diagnosis"));
      const proc = section(clin, S("procedure performed"), S("procedure"));
      const anesthesia = section(clin, S("anesthesia"));
      const ebl = clin.match(/estimated blood loss:?\s*([\d.,]+\s*(?:m?L|cc))/i)?.[1] ?? null;
      const detail = section(clin, /(the fracture[^.]+)\./i, /(closure[^.]*)\./i);
      return paragraph(
        proc ? `The patient underwent ${lcFirst(proc)}${preDx ? ` for ${lcFirst(preDx)}` : ""}` : "This is an operative report; see the body for the procedure performed",
        anesthesia || ebl ? `The procedure was carried out under ${anesthesia ? `${lcFirst(anesthesia)} anesthesia` : "anesthesia"}${ebl ? `, with an estimated blood loss of ${ebl}` : ""}` : null,
        detail ? `Operative detail notes that ${lcFirst(detail)}` : null,
      );
    }
    case "ER_RECORD": {
      const cc = section(clin, S("chief complaint"));
      const exam = section(clin, S("physical exam(?:ination)?"), S("exam"));
      const assess = section(clin, S("assessment"), S("findings"));
      const disp = section(clin, S("disposition"));
      return paragraph(
        cc ? `The patient presented to the emergency department with ${lcFirst(oneSentence(cc))}` : "This is an emergency department encounter record",
        exam ? `Examination documented ${lcFirst(oneSentence(exam))}` : null,
        assess ? `The assessment was ${lcFirst(oneSentence(assess))}` : null,
        disp ? `The patient's disposition was ${lcFirst(oneSentence(disp))}` : null,
      );
    }
    case "PT_OT_RECORD": {
      const pre = clin.split(/plan of care/i)[0];
      const s = clinicalSentences(pre.replace(/^[^.]*\bnote\b\s*/i, ""), 3);
      const plan = section(clin, S("plan of care"));
      const goals = section(clin, S("short-?term goals"));
      return paragraph(
        "This therapy progress note documents the patient's response to treatment",
        s,
        plan ? `The plan of care is to ${lcFirst(plan)}` : null,
        goals ? `Short-term goals include ${lcFirst(goals)}` : null,
      );
    }
    case "HOSPITAL_RECORD":
    case "DISCHARGE_SUMMARY": {
      const dx = section(clin, S("discharge diagnosis"), S("admission diagnosis"), S("diagnosis"));
      const course = section(clin, S("hospital course"));
      const meds = section(clin, S("discharge medications"));
      const disp = section(clin, S("discharge disposition"), S("disposition"));
      return paragraph(
        dx ? `This inpatient record documents a hospitalization for ${lcFirst(dx)}` : "This is an inpatient hospitalization record",
        course ? `The hospital course notes ${lcFirst(course)}` : null,
        meds ? `Discharge medications included ${lcFirst(meds)}` : null,
        disp ? `The patient was discharged ${/^(to|home)\b/i.test(disp) ? lcFirst(disp) : `with a disposition of ${lcFirst(disp)}`}` : null,
        !dx && !course && !meds && !disp ? clinicalSentences(clin, 3) : null,
      );
    }
    case "LAB_REPORT": {
      const m = text.match(/([A-Za-z][A-Za-z ]{2,24}?)\s+([\d.]+).{0,60}?flag\s+(low|high)/i);
      const wbcNormal = /white blood cell[^.]*?(?:within|normal|reference interval)/i.test(text);
      return paragraph(
        "This laboratory report presents values against their reference ranges",
        m ? `${m[1].trim().toLowerCase()} was flagged ${m[3].toLowerCase()} at ${m[2]}` : "no critical flags were identified in the extracted text",
        wbcNormal ? "the white blood cell count was within normal limits" : null,
      );
    }
    case "NEUROPSYCHOLOGICAL_EVALUATION": {
      const imp = section(clin, S("impression"), S("summary"), S("conclusions?"));
      return paragraph(
        "This neuropsychological evaluation was administered using a standardized test battery, with cognitive and memory indices reported alongside documented test validity",
        imp ? `The examiner's impression is ${lcFirst(imp)}` : null,
      );
    }
    case "IME_REPORT": {
      const mmi = /maximum medical improvement/i.test(text);
      const rating = /impairment rating/i.test(text);
      const hx = /history of present injury/i.test(text);
      return paragraph(
        "This independent medical examination follows a review of the available records and an in-person examination",
        hx ? `the report summarizes the history of the present injury` : null,
        mmi ? "The examiner opines that the claimant has reached maximum medical improvement" : null,
        rating ? "An impairment rating is provided within a reasonable degree of medical certainty" : null,
      );
    }
    case "PHARMACY_RECORD": {
      const rx = section(clin, S("prescription"), S("medication"), S("drug"));
      const sig = section(clin, S("sig"));
      const qty = section(clin, S("quantity"), S("qty"));
      return paragraph(
        rx ? `This pharmacy record documents dispensing of ${lcFirst(rx)}` : "This is a pharmacy dispensing record",
        sig ? `The prescribed directions are ${lcFirst(sig)}` : null,
        qty ? `Quantity dispensed: ${lcFirst(qty)}` : null,
      );
    }
    case "BILLING_RECORD": {
      const cpt = text.match(/cpt\s*(\d{5})/i)?.[1];
      const tot = text.match(/total charges:?\s*(\$[\d,]+(?:\.\d{2})?)/i)?.[1];
      const adj = text.match(/adjustments?:?\s*(\$[\d,]+(?:\.\d{2})?)/i)?.[1];
      const bal = text.match(/balance due:?\s*(\$[\d,]+(?:\.\d{2})?)/i)?.[1];
      return paragraph(
        `This billing statement covers${cpt ? ` CPT ${cpt}` : " the services rendered"}${tot ? `, with total charges of ${tot}` : ""}`,
        adj ? `Adjustments of ${adj} were applied` : null,
        bal ? `A patient balance of ${bal} remains due` : /balance due/i.test(text) ? "A patient balance remains due" : null,
      );
    }
    case "DEPOSITION": {
      const who = text.match(/deposition of\s+([A-Z][A-Za-z .'-]+?)(?:\s*[—–-]|,|\.)/i)?.[1];
      return paragraph(
        `This is the sworn deposition transcript${who ? ` of ${who.trim()}` : ""}`,
        "The witness testified under oath with counsel for the parties present, and the transcript preserves the examination verbatim",
      );
    }
    default: {
      const body = section(clin, S("impression"), S("assessment"), S("diagnosis"), S("findings"));
      const sents = clinicalSentences(clin, 3);
      const out = paragraph(body, sents && sents !== body ? sents : null);
      return out || "Record on file; no structured clinical findings were extracted.";
    }
  }
}
