// ─────────────────────────────────────────────────────────────────────────────
// Which named person or entity is the TREATING clinician.
//
// Derived from adjudicated contradictions on a real case — six provider
// errors, each a role confusion rather than a misread name:
//
//   • a records custodian on a transmittal affidavit;
//   • an organization ("… HOSPITAL SYSTEMS, LLC") in a person's place;
//   • a letterhead name with a practice address and no authorship evidence;
//   • the technologist, where no interpreting radiologist was named;
//   • a signature carried across a note boundary (cervical signature on
//     lumbar content);
//   • a CMS-1500 rendering provider in Box 31 that was missed entirely.
//
// The rule is NOT a blacklist. A custodian, an organization and a technologist
// are all real, useful attributions — they are simply not "the clinician who
// treated this patient at this encounter". So each is classified into the role
// the document actually supports, and `provider` keeps its narrow meaning.
// Where the record names nobody, the absence is preserved: an unattributed
// entry is honest, an invented author is not.
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderRole =
  | "TREATING_CLINICIAN"
  | "RENDERING_PROVIDER"
  | "INTERPRETING_PHYSICIAN"
  | "TECHNOLOGIST"
  | "RECORDS_CUSTODIAN"
  | "ORGANIZATION"
  | "LETTERHEAD_ONLY"
  | "UNKNOWN";

export type ProviderRejection =
  | "RECORDS_CUSTODIAN"
  | "ORGANIZATION_NOT_PERSON"
  | "LETTERHEAD_WITHOUT_AUTHORSHIP"
  | "TECHNOLOGIST_NOT_INTERPRETER"
  | "SIGNATURE_OUTSIDE_NOTE";

const CUSTODIAN_RE = /\bcustodian\s+of\s+(?:the\s+)?records?\b|\brecords?\s+custodian\b|\baffiant\b|\bdeponent\s+custodian\b/i;
const ORGANIZATION_RE =
  /\b(?:LLC|L\.L\.C\.|INC\.?|CORP\.?|CORPORATION|COMPANY|CO\.|PLLC|P\.A\.|LLP|LTD|HOSPITAL|HEALTH\s+SYSTEMS?|MEDICAL\s+CENTER|CLINIC|CENTERS?|LABORATORIES|LABS?|IMAGING\s+CENTERS?|GROUP|ASSOCIATES|PARTNERS)\b/i;
const TECHNOLOGIST_RE = /\b(?:technologist|technician|rad\.?\s*tech|R\.?T\.?\s*\((?:R|CT|MR)\)|CNMT|sonographer)\b/i;
/**
 * A named interpretation, not the mere word "radiologist" — a report that says
 * "no interpreting radiologist is named" was matching this and cancelling the
 * technologist rule it exists to trigger.
 */
const INTERPRETER_RE = /\b(?:interpreted\s+by|read\s+by|dictated\s+by|electronically\s+signed\s+by)\s+\S/i;
/** Authorship inside the note: a signature, an attestation, or a role line. */
const AUTHORSHIP_RE =
  /\b(?:signed|signature|electronically\s+signed|dictated\s+by|authored\s+by|attending|treating\s+(?:physician|provider)|examined\s+by|performed\s+by|seen\s+by|provider:)\b/i;
/** A letterhead block: a name sitting with contact details rather than content. */
const LETTERHEAD_RE = /\b(?:phone|tel|fax|suite|ste\.?|p\.?o\.?\s*box|www\.|\.com|street|avenue|blvd|boulevard|drive|road|zip)\b/i;
/** CMS-1500 rendering provider: box 31 and the NPI beside it. */
const CMS1500_RENDERING_RE = /\b(?:box\s*31|31\.?\s*signature\s+of\s+physician|rendering\s+provider)\b/i;
const NPI_RE = /\bNPI\s*#?\s*\d{10}\b|\b\d{10}\b(?=[^\d]*NPI)/i;

export interface ProviderEvidence {
  /** The name the extractor proposes as provider. */
  value: string;
  /** The excerpt cited for it. */
  excerpt: string;
  /** The note/segment the citation must live inside. */
  noteText: string;
  /** Document kind, which decides which roles are even possible. */
  analysisClass?: string | null;
}

export interface ProviderVerdict {
  /** True when the name may stand in the narrow `provider` field. */
  ok: boolean;
  role: ProviderRole;
  reason?: ProviderRejection;
  detail?: string;
}

const near = (haystack: string, needle: string, window = 120): string => {
  if (!needle) return "";
  const at = haystack.indexOf(needle);
  if (at < 0) return needle;
  return haystack.slice(Math.max(0, at - window), at + needle.length + window);
};

/**
 * Classify a proposed provider by the role the document actually supports.
 *
 * `ok: false` never deletes the fact — the caller records the name under the
 * role returned here, so a custodian remains a custodian rather than becoming
 * either a clinician or nothing at all.
 */
export function judgeProviderEvidence(input: ProviderEvidence): ProviderVerdict {
  const context = near(input.noteText || input.excerpt, input.excerpt);

  if (CUSTODIAN_RE.test(context)) {
    return {
      ok: false,
      role: "RECORDS_CUSTODIAN",
      reason: "RECORDS_CUSTODIAN",
      detail: "The cited text identifies this name as the custodian of records transmitting the file, not as a clinician who treated the patient.",
    };
  }

  // CMS-1500 rendering provider is a real, valuable attribution — recognised
  // BEFORE the organization rule, since these forms name both.
  if (CMS1500_RENDERING_RE.test(context) || NPI_RE.test(context)) {
    return { ok: true, role: "RENDERING_PROVIDER", detail: "Named as the rendering provider on a billing form." };
  }

  // A person's name never carries a corporate suffix; when the VALUE itself is
  // the organization, it belongs in facility, not provider.
  if (ORGANIZATION_RE.test(input.value)) {
    return {
      ok: false,
      role: "ORGANIZATION",
      reason: "ORGANIZATION_NOT_PERSON",
      detail: "The cited name is an organization or facility rather than a person, so it is recorded as the facility.",
    };
  }

  if (TECHNOLOGIST_RE.test(context) && !INTERPRETER_RE.test(context)) {
    return {
      ok: false,
      role: "TECHNOLOGIST",
      reason: "TECHNOLOGIST_NOT_INTERPRETER",
      detail: "The cited text names the technologist who performed the study; no interpreting physician is named here, and the absence is preserved rather than filled in.",
    };
  }

  // A name that appears only among addresses and phone numbers is letterhead.
  if (LETTERHEAD_RE.test(context) && !AUTHORSHIP_RE.test(context)) {
    return {
      ok: false,
      role: "LETTERHEAD_ONLY",
      reason: "LETTERHEAD_WITHOUT_AUTHORSHIP",
      detail: "The cited name appears in a letterhead or address block with no signature or authorship statement, which is not evidence of who treated the patient.",
    };
  }

  // The citation must live inside the note it is being attributed to; a
  // signature belonging to an adjacent section is not this note's author.
  if (input.noteText && input.excerpt && !input.noteText.includes(input.excerpt)) {
    return {
      ok: false,
      role: "UNKNOWN",
      reason: "SIGNATURE_OUTSIDE_NOTE",
      detail: "The cited authorship text does not appear within this note, so it belongs to an adjacent section rather than to this entry.",
    };
  }

  return { ok: true, role: "TREATING_CLINICIAN" };
}
