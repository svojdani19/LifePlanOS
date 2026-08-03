import type { UserRole } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Built-in role templates (docs/26, Phase 1). Protected constants defined in
// code — a firm can clone them into CustomRoles but can never edit these.
//
// CRITICAL COMPAT RULE: for each legacy UserRole enum value, the mapped
// template's permissions projected onto the legacy 14-key space (through
// registry ALIASES) must EXACTLY equal rbac.ts ROLE_PERMISSIONS for that role,
// so shadow mode starts divergence-free. Templates may add non-legacy keys
// freely (legacy routes never check them), but must not add or drop a legacy
// key. Note: FIRM_ADMINISTRATOR therefore keeps `physician.review` (legacy
// ADMIN holds it) — the brief's "admin cannot approve/attest" intent is
// enforced at evaluation time by the PHYSICIAN credential requirement on that
// key, not by removing it from the set.
// ─────────────────────────────────────────────────────────────────────────────

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  /** Canonical registry keys (never aliases). */
  permissions: string[];
  defaultScope: "ORGANIZATION" | "CASE";
  externalFacing: boolean;
}

function template(
  key: string,
  name: string,
  description: string,
  permissions: string[],
  defaultScope: "ORGANIZATION" | "CASE",
  externalFacing: boolean,
): RoleTemplate {
  return { key, name, description, permissions, defaultScope, externalFacing };
}

export const PLATFORM_SYSTEM_ADMINISTRATOR = template(
  "PLATFORM_SYSTEM_ADMINISTRATOR",
  "Platform System Administrator",
  "LifePlanOS operator. Manages tenants, feature flags, and integrations. Never assignable to firm users; every key here is platform-only.",
  ["featureflags.manage", "integrations.manage", "organizations.manage", "organizations.impersonate", "platform.audit"],
  "ORGANIZATION",
  false,
);

export const FIRM_ADMINISTRATOR = template(
  "FIRM_ADMINISTRATOR",
  "Firm Administrator",
  "Firm owner/administrator: team, roles, billing, settings, offices, audit, and full case operations. Cannot attest reports or vocational/economic conclusions; physician sign-off remains credential-gated.",
  [
    // Legacy ADMIN = ALL 14 (compat rule).
    "case.view",
    "case.create",
    "case.edit",
    "case.delete",
    "records.upload",
    "chronology.edit",
    "futurecare.edit",
    "physician.review",
    "report.export",
    "team.manage",
    "billing.manage",
    "firm.settings",
    "precedents.manage",
    "audit.view",
    // Cases / records / clinical (non-legacy).
    "case.assign",
    "case.close",
    "case.reopen",
    "case.archive",
    "intake.edit",
    "records.view",
    "records.delete",
    "records.classify",
    "chronology.view",
    "provider.manage",
    "interview.record",
    "futurecare.view",
    "causation.view",
    "causation.edit",
    "reasoning.view",
    "reasoning.recompute",
    "workflow.advance",
    "workflow.unlock",
    // Costs.
    "costs.view",
    "costs.edit",
    "pricing.lookup",
    "assumptions.edit",
    // Reports (no report.approve / report.attest — those are expert acts).
    "report.view",
    "report.generate",
    "report.edit",
    "report.delete_draft",
    "report.download",
    "report.share",
    "report.amend",
    "report.supersede",
    "attestation.view",
    "attestation.invalidate",
    // Feature-gated views.
    "vocational.view",
    "economic.view",
    // Review / precedents.
    "review.defense",
    "review.completeness",
    "qa.review",
    "attention.manage",
    "precedents.view",
    // Team / roles / access.
    "users.view",
    "access.grant",
    "access.revoke",
    "roles.view",
    "roles.create",
    "roles.edit",
    "roles.assign",
    "roles.archive",
    // Org / billing / audit / credentials.
    "billing.view",
    "offices.manage",
    "audit.export",
    "credentials.view",
    "credentials.upload",
    "credentials.verify",
  ],
  "ORGANIZATION",
  false,
);

export const CASE_MANAGER = template(
  "CASE_MANAGER",
  "Case Manager",
  "Intake and record wrangling: opens cases, uploads and organizes records, curates chronology and providers. No clinical authoring, costs editing, or exports.",
  [
    // Legacy PARALEGAL set (compat rule).
    "case.view",
    "case.create",
    "case.edit",
    "records.upload",
    "chronology.edit",
    // Non-legacy operations.
    "intake.edit",
    "case.assign",
    "records.view",
    "records.classify",
    "chronology.view",
    "provider.manage",
    "interview.record",
    "futurecare.view",
    "causation.view",
    "costs.view",
    "report.view",
    "attention.manage",
    "precedents.view",
    "workflow.advance",
  ],
  "ORGANIZATION",
  false,
);

export const MEDICAL_RECORD_ANALYST = template(
  "MEDICAL_RECORD_ANALYST",
  "Medical Record Analyst",
  "Records specialist: uploads, classifies, and summarizes records and builds the chronology. Read-only on the clinical plan.",
  [
    "case.view",
    "records.view",
    "records.upload",
    "records.classify",
    "chronology.view",
    "chronology.edit",
    "provider.manage",
    "futurecare.view",
    "causation.view",
    "attention.manage",
  ],
  "ORGANIZATION",
  false,
);

export const LIFE_CARE_PLANNER = template(
  "LIFE_CARE_PLANNER",
  "Life Care Planner",
  "Core authoring seat: builds the chronology, causation map, future-care plan, and cost projections, and produces reports. Cannot sign physician approvals or manage the firm.",
  [
    // Legacy PLANNER set (compat rule).
    "case.view",
    "case.create",
    "case.edit",
    "records.upload",
    "chronology.edit",
    "futurecare.edit",
    "report.export",
    "precedents.manage",
    // Non-legacy authoring surface.
    "intake.edit",
    "records.view",
    "records.classify",
    "chronology.view",
    "provider.manage",
    "interview.record",
    "futurecare.view",
    "causation.view",
    "causation.edit",
    "reasoning.view",
    "reasoning.recompute",
    "workflow.advance",
    "costs.view",
    "costs.edit",
    "pricing.lookup",
    "assumptions.edit",
    "report.view",
    "report.generate",
    "report.edit",
    "report.delete_draft",
    "report.download",
    "review.defense",
    "review.completeness",
    "attention.manage",
    "precedents.view",
    "vocational.view",
    // Planners may collect sourced intake; vocational.attest remains exclusive
    // to the credentialed vocational expert template.
    "vocational.edit",
    "attestation.view",
    "credentials.upload",
  ],
  "ORGANIZATION",
  false,
);

export const PHYSICIAN_REVIEWER_TEMPLATE = template(
  "PHYSICIAN_REVIEWER",
  "Physician Reviewer",
  "Physician sign-off on medical necessity, report approval, and report attestation. Approval/attestation keys require an ACTIVE verified PHYSICIAN credential at evaluation time.",
  [
    // Legacy PHYSICIAN_REVIEWER set (compat rule).
    "case.view",
    "physician.review",
    "report.export",
    // Non-legacy review surface.
    "records.view",
    "chronology.view",
    "futurecare.view",
    "causation.view",
    "reasoning.view",
    "costs.view",
    "interview.record",
    "report.view",
    "report.download",
    "report.approve",
    "report.attest",
    "attestation.view",
    "credentials.upload",
  ],
  "ORGANIZATION",
  false,
);

export const VOCATIONAL_EXPERT = template(
  "VOCATIONAL_EXPERT",
  "Vocational Expert",
  "Vocational assessment authoring and attestation for engaged cases. Attestation requires a verified VOCATIONAL credential; the domain is feature-flag gated.",
  [
    "case.view",
    "records.view",
    "chronology.view",
    "futurecare.view",
    "costs.view",
    "vocational.view",
    "vocational.edit",
    "vocational.attest",
    "report.view",
    "report.download",
    "attestation.view",
    "credentials.upload",
  ],
  "CASE",
  false,
);

export const FORENSIC_ECONOMIST = template(
  "FORENSIC_ECONOMIST",
  "Forensic Economist",
  "Economic-loss analysis and attestation for engaged cases. Attestation requires a verified ECONOMIST credential; the domain is feature-flag gated.",
  [
    "case.view",
    "records.view",
    "costs.view",
    "pricing.lookup",
    "vocational.view",
    "economic.view",
    "economic.edit",
    "economic.attest",
    "report.view",
    "report.download",
    "attestation.view",
    "credentials.upload",
  ],
  "CASE",
  false,
);

export const QUALITY_ASSURANCE_REVIEWER = template(
  "QUALITY_ASSURANCE_REVIEWER",
  "Quality Assurance Reviewer",
  "Reads everything, signs QA findings, runs defense/completeness critiques, and triages attention items. Never edits clinical content or approves it.",
  [
    "case.view",
    "records.view",
    "chronology.view",
    "futurecare.view",
    "causation.view",
    "costs.view",
    "reasoning.view",
    "report.view",
    "report.download",
    "qa.review",
    "review.defense",
    "review.completeness",
    "attention.manage",
    "attestation.view",
    "precedents.view",
  ],
  "ORGANIZATION",
  false,
);

export const EXTERNAL_EXPERT = template(
  "EXTERNAL_EXPERT",
  "External Expert",
  "Outside consulting expert engaged case-by-case: reads the engaged case and its work product, uploads own credentials. Every key is externally assignable; scope defaults to CASE.",
  [
    "case.view",
    "records.view",
    "chronology.view",
    "futurecare.view",
    "reasoning.view",
    "costs.view",
    "report.view",
    "report.download",
    "attestation.view",
    "credentials.upload",
  ],
  "CASE",
  true,
);

export const ATTORNEY_CLIENT = template(
  "ATTORNEY_CLIENT",
  "Attorney Client",
  "Retaining/defense attorney: reads the case posture and exports deliverables. No editing.",
  [
    // Legacy ATTORNEY_REVIEWER set (compat rule).
    "case.view",
    "report.export",
    // Non-legacy read surface.
    "chronology.view",
    "futurecare.view",
    "costs.view",
    "report.view",
    "report.download",
    "attestation.view",
  ],
  "CASE",
  true,
);

export const INSURANCE_CLIENT = template(
  "INSURANCE_CLIENT",
  "Insurance Client",
  "Carrier/adjuster seat: reads delivered reports and cost posture for the engaged case. No records access, no editing.",
  ["case.view", "costs.view", "report.view", "report.download"],
  "CASE",
  true,
);

export const READ_ONLY_OBSERVER = template(
  "READ_ONLY_OBSERVER",
  "Read-Only Observer",
  "Internal observer: reads cases, records, plans, costs, and reports. No mutations, exports, or administration.",
  [
    "case.view",
    "records.view",
    "chronology.view",
    "futurecare.view",
    "causation.view",
    "reasoning.view",
    "costs.view",
    "report.view",
    "attestation.view",
  ],
  "ORGANIZATION",
  false,
);

/**
 * Legacy-only template backing the BILLING_USER enum value. Legacy
 * BILLING_USER holds exactly `billing.manage` — an observer-with-billing
 * template would ADD legacy keys (case.view) and break shadow equivalence, so
 * this template carries billing keys only. Not part of the 13-role roster.
 */
export const LEGACY_BILLING = template(
  "LEGACY_BILLING",
  "Billing (legacy)",
  "Billing/subscription management only. Exists to back the legacy BILLING_USER enum value divergence-free.",
  ["billing.manage", "billing.view"],
  "ORGANIZATION",
  false,
);

/** The 13 assignable built-in templates (the brief's roster). */
export const BUILT_IN_ROLES: Record<string, RoleTemplate> = {
  PLATFORM_SYSTEM_ADMINISTRATOR,
  FIRM_ADMINISTRATOR,
  CASE_MANAGER,
  MEDICAL_RECORD_ANALYST,
  LIFE_CARE_PLANNER,
  PHYSICIAN_REVIEWER: PHYSICIAN_REVIEWER_TEMPLATE,
  VOCATIONAL_EXPERT,
  FORENSIC_ECONOMIST,
  QUALITY_ASSURANCE_REVIEWER,
  EXTERNAL_EXPERT,
  ATTORNEY_CLIENT,
  INSURANCE_CLIENT,
  READ_ONLY_OBSERVER,
};

/** All templates resolvable by key, including legacy-only ones. */
export const ALL_ROLE_TEMPLATES: Record<string, RoleTemplate> = {
  ...BUILT_IN_ROLES,
  LEGACY_BILLING,
};

/** Legacy UserRole enum value → built-in template key. */
export const LEGACY_ROLE_MAP: Record<UserRole, string> = {
  ADMIN: "FIRM_ADMINISTRATOR",
  PLANNER: "LIFE_CARE_PLANNER",
  PHYSICIAN_REVIEWER: "PHYSICIAN_REVIEWER",
  ATTORNEY_REVIEWER: "ATTORNEY_CLIENT",
  PARALEGAL: "CASE_MANAGER",
  BILLING_USER: "LEGACY_BILLING",
};

/** Template for a template key, or undefined. */
export function getRoleTemplate(key: string): RoleTemplate | undefined {
  return ALL_ROLE_TEMPLATES[key];
}
