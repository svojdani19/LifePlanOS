// ─────────────────────────────────────────────────────────────────────────────
// Indication checklists — per-service clinical prerequisites.
//
// A recommendation is only as defensible as its documented indication. Each
// rule names what the record must show BEFORE the service is clinically
// indicated; unmet rules become advisory validation findings — the item is
// never silently removed (physician authority), it is flagged for review.
// Deterministic regex predicates evaluated against the case's documented
// corpus (diagnoses + evidence quotes + chronology).
// ─────────────────────────────────────────────────────────────────────────────

export interface IndicationRule {
  service: RegExp;
  requires: RegExp;
  requirement: string; // human-readable prerequisite, used in the finding
}

export const INDICATION_RULES: IndicationRule[] = [
  {
    service: /revision\s.*(arthroplasty|replacement)/i,
    requires: /\b(arthroplasty|joint replacement|TKA|THA|TSA|prosthes[ie]s|implant)\b/i,
    requirement: "an index arthroplasty/implant (revision presupposes a primary)",
  },
  {
    service: /\b(total|partial)\s.*(arthroplasty|replacement)\b/i,
    requires: /\b(osteoarthritis|arthrosis|degenerative joint|post-?traumatic arthritis|avascular necrosis|articular (surface|cartilage)|intra-?articular fracture|joint space narrowing|chondral)\b/i,
    requirement: "documented articular pathology (arthritis, articular fracture, AVN, or cartilage loss)",
  },
  {
    service: /injection/i,
    requires: /\b(pain|arthritis|arthrosis|inflammat|synovitis|radiculopath|effusion)\b/i,
    requirement: "documented pain or inflammatory/degenerative pathology",
  },
  {
    service: /attendant care|home health aide|caregiver/i,
    requires: /\b(assist(ance|ed)?|dependen(t|ce)|unable to|requires help|ADL|activities of daily living|transfers?|mobility (aid|impairment)|fall risk|supervision)\b/i,
    requirement: "documented functional dependence or assistance needs",
  },
  {
    service: /EMG|nerve conduction/i,
    requires: /\b(radiculopath|neuropath|paresthesi|numbness|tingling|weakness|nerve)\b/i,
    requirement: "documented neurologic symptoms or suspected nerve involvement",
  },
  {
    service: /psycholog|psychiatr|counseling|mental health/i,
    requires: /\b(depress|anxiet|PTSD|post-?traumatic stress|adjustment disorder|mood|psychiatric|psychological|insomnia|cognitive|traumatic brain)\b/i,
    requirement: "documented psychological symptoms or diagnosis",
  },
  {
    service: /wheelchair|power mobility|scooter/i,
    requires: /\b(non-?ambulat|unable to (walk|ambulate)|paraplegi|quadriplegi|tetraplegi|spinal cord injur|severe (gait|mobility)|amputat)\b/i,
    requirement: "documented severe ambulatory impairment",
  },
  {
    service: /spine surgery|fusion|laminectomy|discectomy|decompression/i,
    requires: /\b(stenosis|herniat|radiculopath|myelopath|instability|spondylolisthes|retropulsion|cord|nerve root|fracture)\b/i,
    requirement: "documented structural spine pathology with neural involvement or instability",
  },
];

export interface IndicationResult {
  met: boolean;
  requirement: string;
}

/**
 * Check a service against its indication rule (first matching rule wins).
 * Returns null when no checklist is defined for the service — absence of a
 * rule is not evidence of anything. Pure.
 */
export function checkIndication(service: string, corpus: string): IndicationResult | null {
  const rule = INDICATION_RULES.find((r) => r.service.test(service));
  if (!rule) return null;
  return { met: rule.requires.test(corpus), requirement: rule.requirement };
}
