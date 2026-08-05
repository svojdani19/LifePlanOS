// ─────────────────────────────────────────────────────────────────────────────
// Verified-content hashing.
//
// A human verifies a specific set of facts, not an abstract "encounter". If
// the claims or the summary change afterwards, the verification no longer
// describes what would be exported. Hashing exactly what was verified — and
// re-checking that hash at export — is what makes "this was verified" a
// statement about the bytes rather than about a database flag.
//
// The hash covers only content that changes MEANING. Review metadata,
// timestamps and ids are excluded, so re-reviewing without editing does not
// invalidate a verification.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

export interface HashableClaim {
  field: string;
  claimType?: string | null;
  value: string;
  excerpt: string;
  page: number | null;
}

export interface HashableEncounter {
  dateStatus: string;
  encounterDate: string | Date | null;
  provider: string | null;
  facility: string | null;
  encounterType: string | null;
  factualSummary: string;
  synthesis?: string | null;
  claims: unknown;
}

const iso = (d: string | Date | null) => (d == null ? null : typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));

function normalizeClaims(claims: unknown): HashableClaim[] {
  const arr = Array.isArray(claims) ? (claims as Record<string, unknown>[]) : [];
  return arr
    .map((c) => ({
      field: String(c.field ?? ""),
      claimType: c.claimType == null ? null : String(c.claimType),
      value: String(c.value ?? ""),
      excerpt: String(c.excerpt ?? ""),
      page: c.page == null ? null : Number(c.page),
    }))
    // Order must not affect identity: two renderings of the same facts are the
    // same facts.
    .sort((a, b) => `${a.field}|${a.value}|${a.page}`.localeCompare(`${b.field}|${b.value}|${b.page}`));
}

/**
 * Stable hash of the MEANING of an encounter: its dating, attribution, summary
 * and full cited claim set.
 */
export function encounterContentHash(e: HashableEncounter): string {
  const payload = JSON.stringify({
    dateStatus: e.dateStatus,
    encounterDate: iso(e.encounterDate),
    provider: e.provider ?? null,
    facility: e.facility ?? null,
    encounterType: e.encounterType ?? null,
    factualSummary: e.factualSummary,
    synthesis: e.synthesis ?? null,
    claims: normalizeClaims(e.claims),
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export interface VerificationDrift {
  drifted: boolean;
  /** Encounters whose current content no longer matches what was verified. */
  changed: number;
  /** Encounters marked verified with no recorded hash (legacy rows). */
  unhashed: number;
}

/**
 * Compare each verified encounter's current content against the hash captured
 * at verification. A mismatch means the export would contain something no one
 * approved.
 *
 * A legacy verified row with no stored hash is reported separately: it is not
 * evidence of drift, but it is also not proof of its absence, so it cannot
 * support a final export either.
 */
export function detectVerificationDrift(
  encounters: (HashableEncounter & { status: string; verifiedContentHash?: string | null })[],
): VerificationDrift {
  let changed = 0;
  let unhashed = 0;
  for (const e of encounters) {
    if (e.status !== "VERIFIED") continue;
    if (!e.verifiedContentHash) {
      unhashed++;
      continue;
    }
    if (encounterContentHash(e) !== e.verifiedContentHash) changed++;
  }
  return { drifted: changed > 0 || unhashed > 0, changed, unhashed };
}
