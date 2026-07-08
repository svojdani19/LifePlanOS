import type { UserRole } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Role-based access control. Permissions are a flat, explicit matrix so every
// grant is auditable in one place. Checked server-side in the tenant guard and
// surfaced in the UI to hide controls a role cannot use.
// ─────────────────────────────────────────────────────────────────────────────

export type Permission =
  | "case.view"
  | "case.create"
  | "case.edit"
  | "case.delete"
  | "records.upload"
  | "chronology.edit"
  | "futurecare.edit"
  | "physician.review" // sign off on medical necessity
  | "report.export"
  | "team.manage" // invite / suspend / change roles
  | "billing.manage" // subscription + payment
  | "firm.settings" // branding, templates, retention
  | "audit.view";

const ALL: Permission[] = [
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
  "audit.view",
];

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  ADMIN: ALL,
  PLANNER: [
    "case.view",
    "case.create",
    "case.edit",
    "records.upload",
    "chronology.edit",
    "futurecare.edit",
    "report.export",
  ],
  PHYSICIAN_REVIEWER: ["case.view", "physician.review", "report.export"],
  ATTORNEY_REVIEWER: ["case.view", "report.export"],
  PARALEGAL: ["case.view", "case.create", "case.edit", "records.upload", "chronology.edit"],
  BILLING_USER: ["billing.manage"],
};

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: "Administrator",
  PLANNER: "Life Care Planner",
  PHYSICIAN_REVIEWER: "Physician Reviewer",
  ATTORNEY_REVIEWER: "Attorney Reviewer",
  PARALEGAL: "Paralegal",
  BILLING_USER: "Billing",
};

export function can(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
