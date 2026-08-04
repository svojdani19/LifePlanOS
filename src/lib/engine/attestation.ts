// ─────────────────────────────────────────────────────────────────────────────
// Electronic attestation engine (EPIC-005 completion). Everything that gives a
// signature its evidentiary weight is computed here, pure and tested:
//
//   scope     — exactly which recommendation VERSIONS the physician covered,
//               pinned by lineage + version + the material fields, so any
//               later drift is detectable without reference to mutable rows
//   statement — the first-person attestation language actually signed; it
//               covers only physician-approved items and never claims more
//   hash      — a canonical sha-256 over statement + scope for tamper evidence
//   verify    — whether an attestation still holds against the CURRENT plan:
//               a material change to any covered item invalidates it
//
// The persistence layer never edits or deletes an attestation: re-signing
// supersedes, drift invalidates (with the reasons recorded and audited).
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto";

export interface AttestableItem {
  id: string;
  lineageId: string;
  version: number;
  service: string;
  category: string;
  probability: string;
  frequencyPerYear: number;
  durationYears: number | null;
  isLifetime: boolean;
  unitCost: number;
  presentValue: number;
  physicianStatus: string;
  supersededAt?: Date | string | null;
}

/** One pinned entry of an attestation's scope — the material fields frozen at
 *  signing. Field list mirrors the P2.R1 material-change definition.
 *  `clinicalFingerprint` (versioned, cfp-1) additionally pins the exact
 *  clinical evidence reviewed for the item — see engine/attestationBinding.ts.
 *  It is stored alongside the pinned fields but deliberately EXCLUDED from
 *  attestationContentHash so legacy rows keep verifying byte-for-byte. */
export interface AttestationScopeEntry {
  lineageId: string;
  itemId: string;
  version: number;
  service: string;
  category: string;
  probability: string;
  frequencyPerYear: number;
  durationYears: number | null;
  isLifetime: boolean;
  unitCost: number;
  presentValue: number;
  physicianStatus: string;
  /** Per-recommendation clinical binding fingerprint captured at signing
   *  (cfp-1). Absent/null on legacy attestations. */
  clinicalFingerprint?: string | null;
}

const ATTESTABLE = new Set(["APPROVED", "MODIFIED"]);

/** The items a signature can cover: current (non-superseded) recommendations
 *  the physician has actually acted on. Pending or rejected items are never
 *  silently swept into an attestation. */
export function buildAttestationScope(items: AttestableItem[]): AttestationScopeEntry[] {
  return items
    .filter((it) => !it.supersededAt && ATTESTABLE.has(it.physicianStatus))
    .map((it) => ({
      lineageId: it.lineageId,
      itemId: it.id,
      version: it.version,
      service: it.service,
      category: it.category,
      probability: it.probability,
      frequencyPerYear: it.frequencyPerYear,
      durationYears: it.durationYears,
      isLifetime: it.isLifetime,
      unitCost: it.unitCost,
      presentValue: it.presentValue,
      physicianStatus: it.physicianStatus,
    }))
    .sort((a, b) => a.service.localeCompare(b.service));
}

/** The first-person statement the physician signs. States exactly what was
 *  reviewed and approved — counts, modified items disclosed — and no more. */
export function attestationStatement(opts: {
  physicianName: string;
  credentialSummary: string | null;
  clientName: string;
  caseNumber: string;
  scope: AttestationScopeEntry[];
  totalPresentValue: number;
}): string {
  const { physicianName, credentialSummary, clientName, caseNumber, scope, totalPresentValue } = opts;
  const approved = scope.filter((s) => s.physicianStatus === "APPROVED").length;
  const modified = scope.filter((s) => s.physicianStatus === "MODIFIED").length;
  const money = "$" + Math.round(totalPresentValue).toLocaleString("en-US");
  const parts: string[] = [];
  parts.push(
    `I, ${physicianName}${credentialSummary ? `, ${credentialSummary}` : ""}, attest that I have personally reviewed the medical records, diagnoses, and future-care recommendations in the Life Care Plan for ${clientName} (matter ${caseNumber}).`,
  );
  parts.push(
    `I have individually reviewed each of the ${scope.length} recommendation${scope.length === 1 ? "" : "s"} covered by this attestation${modified ? ` — ${approved} approved as proposed and ${modified} approved as modified by me, with each modification recorded in the plan's review ledger` : ""} — and it is my opinion, held to a reasonable degree of medical probability, that each covered recommendation is medically necessary as a result of the injuries at issue, at the stated frequency and duration.`,
  );
  parts.push(
    `The covered recommendations carry a combined present value of ${money}. This attestation applies to the specific recommendation versions itemized in its scope; any material change to a covered recommendation after signing invalidates this attestation and requires my re-review.`,
  );
  return parts.join(" ");
}

/** Canonical, key-ordered hash over the signed content — tamper evidence. */
export function attestationContentHash(statementText: string, scope: AttestationScopeEntry[]): string {
  const canonical = JSON.stringify({
    statement: statementText,
    scope: scope.map((s) => [
      s.lineageId,
      s.version,
      s.service,
      s.category,
      s.probability,
      s.frequencyPerYear,
      s.durationYears,
      s.isLifetime,
      s.unitCost,
      s.presentValue,
      s.physicianStatus,
    ]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface AttestationDrift {
  service: string;
  reason: string;
}

export interface AttestationVerification {
  valid: boolean;
  drift: AttestationDrift[];
}

/** Material fields compared against the CURRENT item of each covered lineage.
 *  Wording/rationale edits do not appear here — they never invalidate. */
const MATERIAL_FIELDS: [keyof AttestationScopeEntry, string][] = [
  ["service", "service identity"],
  ["category", "care category"],
  ["probability", "medical probability"],
  ["frequencyPerYear", "frequency"],
  ["durationYears", "duration"],
  ["isLifetime", "lifetime status"],
  ["unitCost", "unit cost"],
];

/**
 * Does the attestation still hold against the current plan? Each covered
 * lineage must still exist as a current item whose material fields match the
 * pinned scope and whose physician status has not regressed. New items ADDED
 * after signing do not invalidate — they are simply not covered.
 */
export function verifyAttestation(scope: AttestationScopeEntry[], currentItems: AttestableItem[]): AttestationVerification {
  const currentByLineage = new Map(currentItems.filter((it) => !it.supersededAt).map((it) => [it.lineageId, it]));
  const drift: AttestationDrift[] = [];
  for (const pinned of scope) {
    const cur = currentByLineage.get(pinned.lineageId);
    if (!cur) {
      drift.push({ service: pinned.service, reason: "the covered recommendation no longer exists in the current plan" });
      continue;
    }
    if (!ATTESTABLE.has(cur.physicianStatus)) {
      drift.push({ service: pinned.service, reason: `physician status regressed to ${cur.physicianStatus.toLowerCase()} after signing` });
      continue;
    }
    const changed = MATERIAL_FIELDS.filter(([k]) => {
      const a = pinned[k];
      const b = cur[k as keyof AttestableItem];
      return typeof a === "number" && typeof b === "number" ? Math.abs(a - b) > 1e-9 : a !== (b as typeof a);
    }).map(([, label]) => label);
    if (changed.length) {
      drift.push({ service: pinned.service, reason: `material change after signing: ${changed.join(", ")}` });
    }
  }
  return { valid: drift.length === 0, drift };
}
