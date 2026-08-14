// Shared between the publisher (server) and the workspace (client), so it
// carries no imports: the client bundle must not drag in the build machinery.

/**
 * The staleReason stamped on a legacy review during the one-time provenance
 * upgrade: a chronology event reviewed before content fingerprinting existed
 * cannot prove it still matches the source, so it is staled ONCE beside a
 * fresh draft instead of silently suppressing corrections forever. The UI
 * matches on this exact string to show the one-time explanation, so it is a
 * constant, not prose composed at a call site.
 */
export const PROVENANCE_UPGRADE_STALE_REASON =
  "One-time provenance upgrade: this event was reviewed before content fingerprinting existed, so its content cannot be verified against the current records build. Nothing was deleted — compare with the fresh draft beside it, then re-review or reject.";
