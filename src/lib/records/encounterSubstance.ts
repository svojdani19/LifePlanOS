// ─────────────────────────────────────────────────────────────────────────────
// Substance classification: is this encounter CLINICAL CARE, supporting
// ANCILLARY data, or pure ADMINISTRATIVE paperwork?
//
// The chronology is a story of the patient's care. A registration form, a
// pharmacist's interaction-check log, or a vaccine administration slip is part
// of the RECORD but not part of the CARE — putting it on the timeline buries
// the surgery between two consent forms.
//
// Three rules keep this honest:
//   1. Classification is DETERMINISTIC, computed from the validated claims —
//      re-runnable for free, never a model's mood.
//   2. Nothing is deleted. Excluded encounters stay on the Records page with
//      the reason for their exclusion, and a reviewer can promote them.
//   3. Doubt resolves toward CLINICAL. Misplacing a consent form on the
//      timeline is noise; hiding a real encounter is a missing fact. Any
//      genuinely clinical claim — an exam finding, a diagnosis, a functional
//      limitation — makes the whole encounter clinical, which is why an
//      ambulance record stating "bed confined" stays on the timeline while a
//      plain transport invoice does not.
// ─────────────────────────────────────────────────────────────────────────────

import { NON_CLINICAL_CLASSES, MEDICAL_TIMELINE_CLASSES } from "@/lib/documents/analysisClass";

export type SubstanceClass = "CLINICAL" | "ANCILLARY" | "ADMINISTRATIVE";

export interface SubstanceVerdict {
  class: SubstanceClass;
  /** Human-readable, reviewable reason — shown wherever the encounter is excluded. */
  reason: string;
}

interface ClassifiableClaim {
  field?: string;
  claimType?: string | null;
  value?: string;
}

interface ClassifiableEncounter {
  /** The kind of document this came from; null on legacy rows. */
  analysisClass?: string | null;
  encounterType?: string | null;
  factualSummary?: string;
  claims: unknown;
}

/** Claim FIELDS that assert clinical substance on their own. */
const CLINICAL_FIELDS = new Set([
  "assessment",
  "objectiveFindings",
  "diagnosticStudies",
  "procedure",
  "treatment",
  "responseToTreatment",
  "functionalStatus",
  "workStatus",
  "restrictions",
  "contradictions",
]);

/** Claim TYPES that assert clinical substance regardless of field. */
const CLINICAL_TYPES = new Set([
  "DIAGNOSIS",
  "PROCEDURE_PERFORMED",
  "COMPLETED_TREATMENT",
  "IMAGING_FINDING",
  "LAB_FINDING",
  "PROVIDER_OPINION",
  "NEGATIVE_FINDING",
  "FUNCTIONAL_STATUS",
  "WORK_STATUS",
  "RECOMMENDED_TREATMENT",
  "PLANNED_TREATMENT",
]);

/** Encounter-type/summary patterns that are paperwork, not care. */
const ADMIN_RE =
  /\b(?:registration|consent|authorization|records? request|billing|insurance (?:card|verification)|claim form|statement of account|intake form|demographic|hipaa|release of information|signature page|face ?sheet|cover ?sheet|affidavit|notary)\b/i;

/** Ancillary patterns: real data, not an episode of care. */
const ANCILLARY_RE =
  /\b(?:immunization|vaccin(?:e|ation)|medication (?:list|reconciliation|dispens\w*|discharge summary)|pharmacy (?:log|record|review)|rph aware|interaction (?:viewed|check(?:ed)?)|refill|prescription pickup|dispensed|drug utilization|dur review|non-?emergency (?:ambulance|transport)|transport(?:ation)? (?:record|invoice|log)\b)/i;

/** Clinical signal inside free text, used when claims alone are ambiguous. */
const CLINICAL_TEXT_RE =
  /\b(?:diagnos\w+|assessment|impression|exam(?:ination)?|surgery|surgical|operative|procedure performed|therapy|imaging|mri|x-?ray|fracture|laceration|radiculopathy|stenosis|effusion|pain|injur\w+|symptom|prognosis|treatment plan)\b/i;

function claimsOf(e: ClassifiableEncounter): ClassifiableClaim[] {
  return Array.isArray(e.claims) ? (e.claims as ClassifiableClaim[]) : [];
}

/**
 * Classify one encounter from its validated claims. Deterministic: identical
 * input always yields the identical verdict.
 */
export function classifyEncounterSubstance(e: ClassifiableEncounter): SubstanceVerdict {
  const claims = claimsOf(e);
  const label = `${e.encounterType ?? ""} ${e.factualSummary ?? ""}`;

  // 0. The document's KIND decides first, because a field name is a weak
  //    proxy for what a document is. Testimony about a shoulder mentions the
  //    same anatomy a clinic note does; only the kind separates them, and
  //    guessing from field names is what let non-clinical material onto the
  //    medical timeline in the first place.
  const klass = e.analysisClass ?? null;
  if (klass === "UNKNOWN") {
    return {
      class: "ADMINISTRATIVE",
      reason: "The kind of this document could not be established; it requires human classification before any clinical use.",
    };
  }
  if (klass && NON_CLINICAL_CLASSES.has(klass as never)) {
    return {
      class: "ANCILLARY",
      reason: `${KIND_LABEL[klass] ?? "Non-clinical"} material — retained and attributed in the records, but it is not treating medical care and does not enter the medical chronology.`,
    };
  }
  if (klass === "EXPERT_OPINION") {
    return {
      class: "ANCILLARY",
      reason: "Expert evaluation — presented as an attributed opinion, never as a treating clinical fact.",
    };
  }

  // 0b. Nothing extracted: whatever this material is, it documents no care.
  if (claims.length === 0) {
    return { class: "ADMINISTRATIVE", reason: "No validated claims were extracted from this material." };
  }

  // 1. Any genuinely clinical claim makes the whole encounter clinical — an
  //    admin-looking record carrying a real finding is a record OF care. A
  //    claim whose own content is administration-of-supplies (a vaccine given,
  //    a medication dispensed) does not count toward this, even when it
  //    arrived filed under `procedure` or `treatment`.
  const clinical = claims.some(
    (c) => (CLINICAL_FIELDS.has(c.field ?? "") || CLINICAL_TYPES.has(c.claimType ?? "")) && !ANCILLARY_RE.test(c.value ?? ""),
  );
  if (clinical) {
    return { class: "CLINICAL", reason: "Documents clinical findings, care, or patient status." };
  }

  // 2. Pure paperwork.
  if (ADMIN_RE.test(label) || claims.every((c) => (c.claimType ?? "") === "ADMINISTRATIVE")) {
    return {
      class: "ADMINISTRATIVE",
      reason: "Administrative paperwork (registration, consent, billing, or records handling) — no clinical findings documented.",
    };
  }

  // 3. Supporting data: medication logs, immunizations, transport slips.
  if (ANCILLARY_RE.test(label) || claims.every((c) => c.field === "medications" || ANCILLARY_RE.test(c.value ?? ""))) {
    return {
      class: "ANCILLARY",
      reason: "Supporting data (medication dispensing, immunization, or transport log) — retained for the record and medication history, not an episode of clinical care.",
    };
  }

  // 4. Nothing admin-flagged and nothing clearly clinical: doubt resolves
  //    toward the timeline, where a human reviewer will see it.
  return { class: "CLINICAL", reason: "Content is not identifiable as paperwork; retained as clinical pending review." };
}

/** Classes admitted to the medical chronology timeline. */
export function isTimelineClass(cls: string | null | undefined): boolean {
  return !cls || cls === "CLINICAL";
}

/**
 * May this row appear on the MEDICAL chronology at all?
 *
 * Driven by the document kind that produced it, not by a field-name fallback.
 * A legacy row with no recorded class is admitted only if its substance class
 * says CLINICAL — the pre-existing behaviour — so nothing already reviewed
 * silently disappears.
 */
export function admissibleToMedicalTimeline(e: { analysisClass?: string | null; substanceClass?: string | null }): boolean {
  const klass = e.analysisClass ?? null;
  if (!klass) return isTimelineClass(e.substanceClass);
  if (!MEDICAL_TIMELINE_CLASSES.has(klass as never)) return false;
  return isTimelineClass(e.substanceClass);
}

/** Human-facing name for a document kind, for reviewer-visible reasons. */
export const KIND_LABEL: Record<string, string> = {
  CLINICAL_ENCOUNTER: "Clinical encounter",
  THERAPY_COURSE: "Therapy",
  OPERATIVE: "Operative",
  ANESTHESIA: "Anesthesia",
  PATHOLOGY_DIAGNOSTIC: "Pathology",
  DEVICE_OR_IMPLANT: "Device / implant",
  DIAGNOSTIC_STUDY: "Diagnostic study",
  TESTIMONY: "Sworn testimony",
  EXPERT_OPINION: "Expert opinion",
  INCIDENT: "Incident / prehospital",
  FINANCIAL: "Billing",
  EMPLOYMENT_ECONOMIC: "Employment / economic",
  INSURANCE_ADMINISTRATIVE: "Insurance / administrative",
  LEGAL: "Legal",
  CORRESPONDENCE_OR_GENERIC_EVIDENCE: "Correspondence",
  UNKNOWN: "Unclassified",
};
