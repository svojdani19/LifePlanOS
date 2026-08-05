import type { ReportFlagKey } from "@/lib/flags";

// ─────────────────────────────────────────────────────────────────────────────
// Enterprise authorization — permission catalog (docs/26, Phase 1).
//
// The legacy 14 keys in src/lib/rbac.ts stay CANONICAL where a concept already
// exists (e.g. "futurecare.edit" remains canonical; the brief's
// "recommendation.edit" is an ALIAS of it). One meaning ⇒ exactly one canonical
// key; aliases only ever point at a canonical key and are never themselves in
// the registry. Pure module — no DB, no env, no side effects.
// ─────────────────────────────────────────────────────────────────────────────

export type PermissionRisk = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

export type PermissionScopeType = "ORGANIZATION" | "OFFICE" | "CASE" | "REPORT";

export type CredentialCategory = "PHYSICIAN" | "VOCATIONAL" | "ECONOMIST" | "CLCP" | "RN";

export type PermissionCategory =
  | "CASES"
  | "RECORDS"
  | "CLINICAL"
  | "WORKFLOW"
  | "COSTS"
  | "REPORTS"
  | "VOCATIONAL"
  | "ECONOMIC"
  | "REVIEW"
  | "PRECEDENTS"
  | "TEAM"
  | "ROLES"
  | "BILLING"
  | "ORGANIZATION"
  | "AUDIT"
  | "CREDENTIALS"
  | "PLATFORM";

export interface PermissionDefinition {
  key: string;
  name: string;
  description: string;
  category: PermissionCategory;
  risk: PermissionRisk;
  /** May a role editor grant this key onward (delegation ceiling)? */
  delegable: boolean;
  /** Scope types this key may be granted at. */
  scopes: PermissionScopeType[];
  /** Verified credential category required at evaluation time (step 4). */
  requiresCredential?: CredentialCategory;
  /** May this key appear on an external-facing role (client/expert)? */
  externalAssignable: boolean;
  /** May this key appear in a firm-authored custom role? */
  customRoleAssignable: boolean;
  /** Feature flag (src/lib/flags.ts REPORT_FLAGS) gating this key (step 3). */
  featureFlag?: ReportFlagKey;
  /** Platform-operator only — always denied for firm users (step 1). */
  platformOnly: boolean;
  /** High-consequence action: extra audit weight, never silently granted. */
  privileged: boolean;
}

interface DefOptions {
  delegable?: boolean;
  scopes?: PermissionScopeType[];
  requiresCredential?: CredentialCategory;
  externalAssignable?: boolean;
  customRoleAssignable?: boolean;
  featureFlag?: ReportFlagKey;
  platformOnly?: boolean;
  privileged?: boolean;
}

const DEFAULT_SCOPES: PermissionScopeType[] = ["ORGANIZATION", "OFFICE", "CASE"];
const ORG_ONLY: PermissionScopeType[] = ["ORGANIZATION"];
const WITH_REPORT: PermissionScopeType[] = ["ORGANIZATION", "OFFICE", "CASE", "REPORT"];

function def(
  key: string,
  name: string,
  description: string,
  category: PermissionCategory,
  risk: PermissionRisk,
  opts: DefOptions = {},
): PermissionDefinition {
  const platformOnly = opts.platformOnly ?? false;
  return {
    key,
    name,
    description,
    category,
    risk,
    // Platform-only keys are never delegable, never external, never custom.
    delegable: platformOnly ? false : (opts.delegable ?? true),
    scopes: opts.scopes ?? DEFAULT_SCOPES,
    ...(opts.requiresCredential ? { requiresCredential: opts.requiresCredential } : {}),
    externalAssignable: platformOnly ? false : (opts.externalAssignable ?? false),
    customRoleAssignable: platformOnly ? false : (opts.customRoleAssignable ?? true),
    ...(opts.featureFlag ? { featureFlag: opts.featureFlag } : {}),
    platformOnly,
    privileged: opts.privileged ?? false,
  };
}

const DEFINITIONS: PermissionDefinition[] = [
  // ── CASES ──────────────────────────────────────────────────────────────────
  def("case.view", "View cases", "See case details, intake data, and status.", "CASES", "LOW", {
    externalAssignable: true,
  }),
  def("case.create", "Create cases", "Open a new case for the firm.", "CASES", "MODERATE"),
  def("case.edit", "Edit cases", "Modify intake, demographics, and case-level assumptions.", "CASES", "MODERATE"),
  def("case.delete", "Delete cases", "Permanently remove a case and its contents.", "CASES", "HIGH", {
    delegable: false,
    privileged: true,
  }),
  def("case.assign", "Assign case team", "Attach or remove team members on a case.", "CASES", "MODERATE"),
  def("case.close", "Close cases", "Mark a case closed after delivery.", "CASES", "MODERATE"),
  def("case.reopen", "Reopen cases", "Reopen a closed or archived case.", "CASES", "MODERATE", { privileged: true }),
  def("case.archive", "Archive cases", "Move a case to the archive.", "CASES", "MODERATE"),
  def("intake.edit", "Edit intake", "Edit structured intake fields (diagnoses, history, work status).", "CASES", "MODERATE"),

  // ── RECORDS ────────────────────────────────────────────────────────────────
  def("records.view", "View records", "Read uploaded medical records and extracted text.", "RECORDS", "LOW", {
    externalAssignable: true,
  }),
  def("records.upload", "Upload records", "Upload medical-legal documents to a case.", "RECORDS", "MODERATE"),
  def("records.delete", "Delete records", "Remove an uploaded document from a case.", "RECORDS", "HIGH", {
    privileged: true,
  }),
  def("records.classify", "Classify records", "Reassign document type/taxonomy labels.", "RECORDS", "LOW"),
  // Factual record review: confirming, correcting, or rejecting AI-extracted
  // record facts. This is a FACTUAL act, not a medical opinion — it does not
  // require a physician credential, and platform/super-admin status alone
  // never grants it (only the firm role templates below carry it).
  def("records.verify", "Verify record extraction", "Confirm, correct, supplement, or reject AI-extracted record facts and chronology entries.", "RECORDS", "MODERATE"),
  def("chronology.view", "View chronology", "Read the medical chronology timeline.", "RECORDS", "LOW", {
    externalAssignable: true,
  }),
  def("chronology.edit", "Edit chronology", "Create/edit chronology events.", "RECORDS", "MODERATE"),
  def("provider.manage", "Manage treating providers", "Confirm, dismiss, and edit the treating-provider roster.", "RECORDS", "LOW"),
  def("interview.record", "Record interviews", "Enter patient/provider interview findings.", "RECORDS", "MODERATE"),

  // ── CLINICAL ───────────────────────────────────────────────────────────────
  def("futurecare.view", "View future care plan", "Read future-care recommendations and rationale.", "CLINICAL", "LOW", {
    externalAssignable: true,
  }),
  def("futurecare.edit", "Edit future care plan", "Author and modify future-care recommendations.", "CLINICAL", "HIGH"),
  def("causation.view", "View causation analysis", "Read the causation/apportionment map.", "CLINICAL", "LOW"),
  def("causation.edit", "Edit causation analysis", "Edit condition relatedness and causation reasoning.", "CLINICAL", "HIGH"),
  def(
    "physician.review",
    "Physician sign-off",
    "Approve, modify, or reject recommendations on medical necessity (aliased by recommendation.approve).",
    "CLINICAL",
    "CRITICAL",
    { requiresCredential: "PHYSICIAN", privileged: true, delegable: false },
  ),
  def("reasoning.view", "View clinical reasoning", "Read clinical reasoning assessments and evidence chains.", "CLINICAL", "LOW", {
    externalAssignable: true,
  }),
  def("reasoning.recompute", "Recompute reasoning", "Re-run the clinical reasoning pipeline for a recommendation.", "CLINICAL", "MODERATE"),

  // ── WORKFLOW ───────────────────────────────────────────────────────────────
  def("workflow.advance", "Advance workflow", "Move a case forward through workflow stages.", "WORKFLOW", "MODERATE"),
  def(
    "workflow.unlock",
    "Unlock workflow stage",
    "Unlock a stage-locked case for correction (reason required; attestations invalidate).",
    "WORKFLOW",
    "HIGH",
    { privileged: true, delegable: false },
  ),

  // ── COSTS ──────────────────────────────────────────────────────────────────
  def("costs.view", "View cost projections", "Read unit/annual/lifetime costs and present values.", "COSTS", "LOW", {
    externalAssignable: true,
  }),
  def("costs.edit", "Edit cost projections", "Modify pricing, frequency, and duration inputs.", "COSTS", "HIGH"),
  def("pricing.lookup", "Run pricing lookups", "Query live/benchmark pricing sources.", "COSTS", "LOW"),
  def("assumptions.edit", "Edit economic assumptions", "Change discount rate, inflation, life expectancy, and geographic factors.", "COSTS", "HIGH"),

  // ── REPORTS ────────────────────────────────────────────────────────────────
  def("report.view", "View reports", "Read generated reports and version history.", "REPORTS", "LOW", {
    scopes: WITH_REPORT,
    externalAssignable: true,
  }),
  def("report.generate", "Generate reports", "Produce report drafts from case data.", "REPORTS", "MODERATE", { scopes: WITH_REPORT }),
  def("report.edit", "Edit reports", "Edit report configuration and draft content.", "REPORTS", "MODERATE", { scopes: WITH_REPORT }),
  def("report.delete_draft", "Delete report drafts", "Discard an unfinalized report draft.", "REPORTS", "MODERATE", { scopes: WITH_REPORT }),
  def("report.export", "Export reports", "Export/finalize reports to DOCX/PDF/XLSX.", "REPORTS", "MODERATE", {
    scopes: WITH_REPORT,
    externalAssignable: true,
  }),
  def("report.download", "Download reports", "Download stored report files.", "REPORTS", "LOW", {
    scopes: WITH_REPORT,
    externalAssignable: true,
  }),
  def("report.share", "Share reports", "Share a report with external parties.", "REPORTS", "HIGH", {
    scopes: WITH_REPORT,
    privileged: true,
  }),
  def(
    "report.approve",
    "Approve reports",
    "Record a professional approval of a report's content.",
    "REPORTS",
    "HIGH",
    { scopes: WITH_REPORT, requiresCredential: "PHYSICIAN", privileged: true, delegable: false },
  ),
  def(
    "report.attest",
    "Attest reports",
    "Sign a report-level attestation binding to the exported content.",
    "REPORTS",
    "CRITICAL",
    {
      scopes: WITH_REPORT,
      requiresCredential: "PHYSICIAN",
      privileged: true,
      delegable: false,
      externalAssignable: true,
      featureFlag: "report.report_level_attestation",
    },
  ),
  def("report.amend", "Amend final reports", "Issue an amended successor to a finalized report.", "REPORTS", "HIGH", {
    scopes: WITH_REPORT,
    privileged: true,
    delegable: false,
  }),
  def("report.supersede", "Supersede final reports", "Replace a finalized report with a corrected version.", "REPORTS", "HIGH", {
    scopes: WITH_REPORT,
    privileged: true,
    delegable: false,
  }),
  def("attestation.view", "View attestations", "Read attestation records and their status.", "REPORTS", "LOW", {
    scopes: WITH_REPORT,
    externalAssignable: true,
  }),
  def("attestation.invalidate", "Invalidate attestations", "Mark an attestation invalidated with a recorded reason.", "REPORTS", "CRITICAL", {
    scopes: WITH_REPORT,
    privileged: true,
    delegable: false,
  }),

  // ── VOCATIONAL ─────────────────────────────────────────────────────────────
  def("vocational.view", "View vocational data", "Read vocational entries and scenarios.", "VOCATIONAL", "LOW", {
    externalAssignable: true,
    featureFlag: "report.vocational_assessment",
  }),
  def("vocational.edit", "Edit vocational data", "Enter and revise vocational findings.", "VOCATIONAL", "MODERATE", {
    externalAssignable: true,
    featureFlag: "report.vocational_assessment",
  }),
  def(
    "vocational.attest",
    "Attest vocational conclusions",
    "Sign vocational conclusions as the responsible expert.",
    "VOCATIONAL",
    "CRITICAL",
    {
      requiresCredential: "VOCATIONAL",
      privileged: true,
      delegable: false,
      externalAssignable: true,
      featureFlag: "report.vocational_assessment",
    },
  ),

  // ── ECONOMIC ───────────────────────────────────────────────────────────────
  def("economic.view", "View economic analysis", "Read economic assumptions and scenarios.", "ECONOMIC", "LOW", {
    externalAssignable: true,
    featureFlag: "report.forensic_economist",
  }),
  def("economic.edit", "Edit economic analysis", "Enter and revise economic assumptions and scenarios.", "ECONOMIC", "MODERATE", {
    externalAssignable: true,
    featureFlag: "report.forensic_economist",
  }),
  def(
    "economic.attest",
    "Attest economic conclusions",
    "Sign forensic-economic conclusions as the responsible expert.",
    "ECONOMIC",
    "CRITICAL",
    {
      requiresCredential: "ECONOMIST",
      privileged: true,
      delegable: false,
      externalAssignable: true,
      featureFlag: "report.forensic_economist",
    },
  ),

  // ── REVIEW / QA ────────────────────────────────────────────────────────────
  def("review.defense", "Run defense review", "Run/read the defense-vulnerability critique.", "REVIEW", "MODERATE"),
  def("review.completeness", "Run completeness review", "Run/read the plaintiff completeness check.", "REVIEW", "MODERATE"),
  def("qa.review", "QA review", "Perform quality-assurance review passes and sign QA findings.", "REVIEW", "MODERATE"),
  def("attention.manage", "Triage attention items", "Assign, resolve, defer, and dismiss attention items.", "REVIEW", "LOW"),

  // ── PRECEDENTS ─────────────────────────────────────────────────────────────
  def("precedents.view", "View precedent library", "Browse the firm's precedent LCP library.", "PRECEDENTS", "LOW"),
  def("precedents.manage", "Manage precedent library", "Upload and curate the firm precedent library.", "PRECEDENTS", "MODERATE", {
    scopes: ORG_ONLY,
  }),

  // ── TEAM ───────────────────────────────────────────────────────────────────
  def("team.manage", "Manage team", "Invite, suspend, and change roles for firm seats (aliased by users.manage).", "TEAM", "HIGH", {
    scopes: ORG_ONLY,
    delegable: false,
    privileged: true,
  }),
  def("users.view", "View team", "See firm seats and their roles.", "TEAM", "LOW", { scopes: ORG_ONLY }),
  def("access.grant", "Grant temporary access", "Create time-boxed access grants for a user.", "TEAM", "HIGH", {
    delegable: false,
    privileged: true,
  }),
  def("access.revoke", "Revoke access", "Revoke assignments and temporary grants.", "TEAM", "MODERATE", { delegable: false }),

  // ── ROLES ──────────────────────────────────────────────────────────────────
  def("roles.view", "View roles", "See built-in and custom role definitions.", "ROLES", "LOW", { scopes: ORG_ONLY }),
  def("roles.create", "Create custom roles", "Author new custom roles (delegation ceiling applies).", "ROLES", "HIGH", {
    scopes: ORG_ONLY,
    delegable: false,
    customRoleAssignable: false,
    privileged: true,
  }),
  def("roles.edit", "Edit custom roles", "Modify custom role permissions (delegation ceiling applies).", "ROLES", "HIGH", {
    scopes: ORG_ONLY,
    delegable: false,
    customRoleAssignable: false,
    privileged: true,
  }),
  def("roles.assign", "Assign roles", "Assign or remove roles for users (never self-escalating).", "ROLES", "HIGH", {
    scopes: ORG_ONLY,
    delegable: false,
    customRoleAssignable: false,
    privileged: true,
  }),
  def("roles.archive", "Archive custom roles", "Archive a custom role (archive-not-delete when assigned).", "ROLES", "MODERATE", {
    scopes: ORG_ONLY,
    delegable: false,
    customRoleAssignable: false,
  }),

  // ── BILLING ────────────────────────────────────────────────────────────────
  def("billing.view", "View billing", "See subscription status, seats, and usage.", "BILLING", "LOW", { scopes: ORG_ONLY }),
  def("billing.manage", "Manage billing", "Change subscription, seats, and payment.", "BILLING", "HIGH", {
    scopes: ORG_ONLY,
    delegable: false,
    privileged: true,
  }),

  // ── ORGANIZATION ───────────────────────────────────────────────────────────
  def("firm.settings", "Firm settings", "Branding, templates, retention policy (aliased by org.settings).", "ORGANIZATION", "HIGH", {
    scopes: ORG_ONLY,
    delegable: false,
    privileged: true,
  }),
  def("offices.manage", "Manage offices", "Create, rename, and archive firm offices.", "ORGANIZATION", "MODERATE", {
    scopes: ORG_ONLY,
    delegable: false,
  }),

  // ── AUDIT ──────────────────────────────────────────────────────────────────
  def("audit.view", "View audit trail", "Read the firm audit log.", "AUDIT", "MODERATE", { scopes: ORG_ONLY }),
  def("audit.export", "Export audit trail", "Export audit history for compliance review.", "AUDIT", "HIGH", {
    scopes: ORG_ONLY,
    privileged: true,
  }),

  // ── CREDENTIALS ────────────────────────────────────────────────────────────
  def("credentials.view", "View credentials", "See credential documents and verification status.", "CREDENTIALS", "LOW", {
    scopes: ORG_ONLY,
  }),
  def("credentials.upload", "Upload credentials", "Upload one's own credential documents.", "CREDENTIALS", "LOW", {
    scopes: ORG_ONLY,
    externalAssignable: true,
  }),
  def("credentials.verify", "Verify credentials", "Mark a credential ORG_VERIFIED after review.", "CREDENTIALS", "HIGH", {
    scopes: ORG_ONLY,
    delegable: false,
    privileged: true,
  }),

  // ── PLATFORM (operator-only; step 1 denies these for every firm user) ──────
  def("featureflags.manage", "Manage feature flags", "Change platform/firm feature-flag posture.", "PLATFORM", "CRITICAL", {
    scopes: ORG_ONLY,
    platformOnly: true,
    privileged: true,
  }),
  def("integrations.manage", "Manage integrations", "Configure platform integrations and webhooks.", "PLATFORM", "CRITICAL", {
    scopes: ORG_ONLY,
    platformOnly: true,
    privileged: true,
  }),
  def("organizations.manage", "Manage organizations", "Create, suspend, and configure tenant firms.", "PLATFORM", "CRITICAL", {
    scopes: ORG_ONLY,
    platformOnly: true,
    privileged: true,
  }),
  def("organizations.impersonate", "Impersonate organizations", "Operate inside a tenant for support (fully audited).", "PLATFORM", "CRITICAL", {
    scopes: ORG_ONLY,
    platformOnly: true,
    privileged: true,
  }),
  def("platform.audit", "Platform audit", "Read cross-tenant platform audit data.", "PLATFORM", "CRITICAL", {
    scopes: ORG_ONLY,
    platformOnly: true,
    privileged: true,
  }),
];

/** The permission catalog, keyed by canonical permission key. */
export const PERMISSION_REGISTRY: Record<string, PermissionDefinition> = Object.fromEntries(
  DEFINITIONS.map((d) => [d.key, d]),
);

/**
 * Alias → canonical. The legacy rbac.ts keys stay canonical; the enterprise
 * brief's names for the same concepts resolve here. An alias never appears in
 * PERMISSION_REGISTRY itself (one meaning ⇒ one canonical key).
 */
export const ALIASES: Record<string, string> = {
  "recommendation.view": "futurecare.view",
  "recommendation.edit": "futurecare.edit",
  "recommendation.approve": "physician.review",
  "users.manage": "team.manage",
  "org.settings": "firm.settings",
  "library.manage": "precedents.manage",
};

/** Resolve a (possibly aliased) key to its canonical registry key. */
export function resolveKey(key: string): string {
  return ALIASES[key] ?? key;
}

/** Is this a known permission key (canonical or alias)? */
export function isValidKey(key: string): boolean {
  return resolveKey(key) in PERMISSION_REGISTRY;
}

/** Registry entry for a (possibly aliased) key, or undefined. */
export function getDefinition(key: string): PermissionDefinition | undefined {
  return PERMISSION_REGISTRY[resolveKey(key)];
}

/** All canonical keys. */
export const ALL_PERMISSION_KEYS: string[] = DEFINITIONS.map((d) => d.key);
