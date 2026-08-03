// Attorney-side readiness: the inputs a retaining attorney must provide before
// any report can be prepared. Deliberately excludes clinical work (physician
// review, citations, item integrity) — those belong to the clinical team and
// are never presented to the attorney as their blockers.

export interface AttorneyCaseInputs {
  dateOfBirth?: string | Date | null;
  dateOfInjury?: string | Date | null;
  diagnosis?: string | null;
  jurisdiction?: string | null;
  specialty?: string | null;
  documentCount: number;
}

export interface AttorneyItemNeeded {
  label: string;
  /** Case-workspace tab that fixes it (deep-linkable via /cases/{id}?tab=…). */
  tab: string;
  action: string;
}

export function attorneyItemsNeeded(c: AttorneyCaseInputs): AttorneyItemNeeded[] {
  const items: AttorneyItemNeeded[] = [];
  if (!c.dateOfBirth) items.push({ label: "Client date of birth is missing.", tab: "overview", action: "Complete intake" });
  if (!c.dateOfInjury) items.push({ label: "Date of injury is missing.", tab: "overview", action: "Complete intake" });
  if (!c.diagnosis) items.push({ label: "Primary diagnosis is missing.", tab: "overview", action: "Complete intake" });
  if (!c.jurisdiction) items.push({ label: "Jurisdiction is missing.", tab: "overview", action: "Complete intake" });
  if (!c.specialty) items.push({ label: "Specialty for review has not been selected.", tab: "overview", action: "Complete intake" });
  if (c.documentCount === 0) items.push({ label: "No medical records have been uploaded.", tab: "records", action: "Upload records" });
  return items;
}
