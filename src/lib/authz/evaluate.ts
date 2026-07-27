import { flagEnabled } from "@/lib/flags";
import {
  getDefinition,
  resolveKey,
  type PermissionDefinition,
  type PermissionScopeType,
} from "./registry";
import { ALL_ROLE_TEMPLATES, LEGACY_ROLE_MAP } from "./roles";

// ─────────────────────────────────────────────────────────────────────────────
// Enterprise authorization — pure evaluation core (docs/26, Phase 1).
//
// `authorize()` implements the 11-step deterministic order from the design:
//   1 system prohibition → 2 tenant boundary → 3 feature flag → 4 credential
//   requirement → 5 explicit scoped DENY → 6 workflow-stage prohibition →
//   7 report-state prohibition → 8 assignment/resource scope → 9 explicit
//   scoped ALLOW → 10 role ALLOW → 11 default DENY.
//
// The function is PURE: every fact it needs (assignments, grants, credentials,
// firm features, the clock) arrives pre-loaded in `ctx`. No prisma, no I/O.
// Immutable prohibitions (steps 1–7) can never be rescued by a more specific
// allow. Explicit DENY at any applicable scope beats every allow.
// ─────────────────────────────────────────────────────────────────────────────

export type DenialCode =
  | "SYSTEM_PROHIBITION"
  | "TENANT_BOUNDARY"
  | "FEATURE_DISABLED"
  | "CREDENTIAL_REQUIRED"
  | "EXPLICIT_DENY"
  | "STAGE_LOCKED"
  | "REPORT_STATE"
  | "SCOPE_REQUIRED"
  | "NO_GRANT"
  | "UNKNOWN_PERMISSION";

export interface AuthzInput {
  userId: string;
  firmId: string;
  permission: string;
  officeId?: string;
  caseId?: string;
  reportType?: string;
  reportStatus?: string; // e.g. "DRAFT" | "FINAL"
  workflowStage?: string; // CaseStatus value, when evaluating in a case context
}

export interface CustomRolePermissionLike {
  permissionKey: string;
  effect: "ALLOW" | "DENY";
  scopeType: PermissionScopeType;
  scopeConfig?: { caseId?: string; officeId?: string; reportType?: string } | null;
}

export interface AuthzAssignment {
  builtInRole?: string | null;
  /** Snapshot of the assigned custom role's permission rows. */
  customRolePermissions?: CustomRolePermissionLike[] | null;
  officeId?: string | null;
  caseId?: string | null;
  status: string; // ACTIVE | SCHEDULED | REVOKED | EXPIRED
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
}

export interface AuthzGrant {
  scopeType: PermissionScopeType;
  scopeId?: string | null;
  permissions: string[];
  status: string; // ACTIVE | REVOKED | EXPIRED
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null; // temporary access always expires
}

export interface AuthzCredential {
  category?: string | null; // PHYSICIAN | RN | CLCP | VOCATIONAL | ECONOMIST | OTHER
  status: string; // SELF_REPORTED | ORG_VERIFIED | EXTERNALLY_VERIFIED | EXPIRED | SUSPENDED | PENDING
  expiresAt?: Date | null;
}

export interface AuthzContext {
  /** The firm the evaluated user belongs to. */
  userFirmId: string;
  /** Legacy User.role enum value — contributes its template at ORGANIZATION scope. */
  legacyRole?: string | null;
  assignments?: AuthzAssignment[];
  grants?: AuthzGrant[];
  credentials?: AuthzCredential[];
  /** Raw Firm.features Json (unknown/untrusted). */
  firmFeatures?: unknown;
  now: Date;
}

export interface AuthzResult {
  allowed: boolean;
  denialCode?: DenialCode;
  userSafeReason: string;
  matchedRoleAssignments: string[];
  matchedPermissions: string[];
  appliedRestrictions: string[];
  requiredConditions: string[];
  auditContext: {
    userId: string;
    firmId: string;
    permission: string;
    canonicalPermission: string;
    caseId?: string;
    officeId?: string;
    reportType?: string;
    decidedAtStep: string;
    evaluatedAt: string;
  };
}

// ── Stage / report-state policy ──────────────────────────────────────────────

/** Stages that freeze edit-class permissions (docs/26: FINAL/DELIVERED/ARCHIVED). */
const LOCKED_STAGES = new Set(["FINAL", "DELIVERED", "ARCHIVED"]);

/** Keys exempt from the stage lock: amendment/lifecycle paths stay open. */
const STAGE_LOCK_EXEMPT = new Set([
  "report.amend",
  "report.supersede",
  "workflow.unlock",
  "case.close",
  "case.archive",
  "case.reopen",
]);

const STAGE_LOCK_CATEGORIES = new Set(["CASES", "RECORDS", "CLINICAL", "COSTS"]);

/** Edit-class = a mutating key in the stage-locked categories. */
function isStageLockedKey(entry: PermissionDefinition): boolean {
  if (!STAGE_LOCK_CATEGORIES.has(entry.category)) return false;
  if (STAGE_LOCK_EXEMPT.has(entry.key)) return false;
  if (entry.key.endsWith(".view")) return false;
  if (entry.key === "pricing.lookup") return false; // read-only lookup
  return true;
}

/** Keys frozen once the targeted report is FINAL. */
const REPORT_FINAL_LOCKED = new Set(["report.edit", "report.delete_draft"]);

const VERIFIED_CREDENTIAL_STATUSES = new Set(["ORG_VERIFIED", "EXTERNALLY_VERIFIED"]);

// ── Internal aggregation ─────────────────────────────────────────────────────

const SCOPE_SPECIFICITY: Record<PermissionScopeType, number> = {
  ORGANIZATION: 0,
  OFFICE: 1,
  CASE: 2,
  REPORT: 3,
};

interface ScopedEntry {
  source: string; // human-readable origin, e.g. 'built-in:LIFE_CARE_PLANNER'
  effect: "ALLOW" | "DENY";
  scopeType: PermissionScopeType;
  /** Concrete resource the entry is pinned to; null = the whole scope type. */
  scopeId: string | null;
}

function withinWindow(now: Date, from?: Date | null, until?: Date | null): boolean {
  if (from && from.getTime() > now.getTime()) return false;
  if (until && until.getTime() <= now.getTime()) return false;
  return true;
}

/** Does a scoped entry apply to the resource in the input? */
function entryApplies(entry: ScopedEntry, input: AuthzInput): boolean {
  switch (entry.scopeType) {
    case "ORGANIZATION":
      return true;
    case "OFFICE":
      return entry.scopeId === null || (input.officeId !== undefined && entry.scopeId === input.officeId);
    case "CASE":
      return entry.scopeId === null || (input.caseId !== undefined && entry.scopeId === input.caseId);
    case "REPORT":
      return entry.scopeId === null || (input.reportType !== undefined && entry.scopeId === input.reportType);
  }
}

/**
 * Collect every ALLOW/DENY entry that names the canonical key, from the
 * legacy role, active assignments (built-in or custom), and active grants.
 * Time-window + status filtering happens here; scope matching happens later.
 */
function collectEntries(canonical: string, ctx: AuthzContext): ScopedEntry[] {
  const entries: ScopedEntry[] = [];

  // Legacy enum role → template, contributed at ORGANIZATION scope so existing
  // users keep working unchanged.
  if (ctx.legacyRole) {
    const templateKey = LEGACY_ROLE_MAP[ctx.legacyRole as keyof typeof LEGACY_ROLE_MAP];
    const tpl = templateKey ? ALL_ROLE_TEMPLATES[templateKey] : undefined;
    if (tpl && tpl.permissions.some((p) => resolveKey(p) === canonical)) {
      entries.push({
        source: `legacy:${ctx.legacyRole}→${tpl.key}`,
        effect: "ALLOW",
        scopeType: "ORGANIZATION",
        scopeId: null,
      });
    }
  }

  for (const a of ctx.assignments ?? []) {
    if (a.status !== "ACTIVE") continue;
    if (!withinWindow(ctx.now, a.effectiveFrom, a.effectiveUntil)) continue;

    if (a.builtInRole) {
      const tpl = ALL_ROLE_TEMPLATES[a.builtInRole];
      if (tpl && tpl.permissions.some((p) => resolveKey(p) === canonical)) {
        const scopeType: PermissionScopeType = a.caseId ? "CASE" : a.officeId ? "OFFICE" : "ORGANIZATION";
        entries.push({
          source: `built-in:${tpl.key}`,
          effect: "ALLOW",
          scopeType,
          scopeId: a.caseId ?? a.officeId ?? null,
        });
      }
    }

    for (const p of a.customRolePermissions ?? []) {
      if (resolveKey(p.permissionKey) !== canonical) continue;
      const scopeId =
        p.scopeType === "CASE"
          ? (p.scopeConfig?.caseId ?? a.caseId ?? null)
          : p.scopeType === "OFFICE"
            ? (p.scopeConfig?.officeId ?? a.officeId ?? null)
            : p.scopeType === "REPORT"
              ? (p.scopeConfig?.reportType ?? null)
              : null;
      entries.push({ source: "custom-role", effect: p.effect, scopeType: p.scopeType, scopeId });
    }
  }

  for (const g of ctx.grants ?? []) {
    if (g.status !== "ACTIVE") continue;
    if (!withinWindow(ctx.now, g.effectiveFrom, g.effectiveUntil)) continue;
    if (!g.permissions.some((p) => resolveKey(p) === canonical)) continue;
    entries.push({
      source: "access-grant",
      effect: "ALLOW",
      scopeType: g.scopeType,
      scopeId: g.scopeId ?? null,
    });
  }

  return entries;
}

// ── The evaluator ────────────────────────────────────────────────────────────

const REASONS: Record<DenialCode, string> = {
  SYSTEM_PROHIBITION: "This action is restricted to platform operators.",
  TENANT_BOUNDARY: "This resource belongs to a different organization.",
  FEATURE_DISABLED: "This feature is not enabled for your organization.",
  CREDENTIAL_REQUIRED: "A verified professional credential is required for this action.",
  EXPLICIT_DENY: "Your role configuration explicitly denies this action.",
  STAGE_LOCKED: "This case is locked at its current workflow stage.",
  REPORT_STATE: "This report is finalized and can no longer be modified.",
  SCOPE_REQUIRED: "Your access to this action is limited to specific cases or offices.",
  NO_GRANT: "You do not have permission to perform this action.",
  UNKNOWN_PERMISSION: "Unknown permission.",
};

export function authorize(input: AuthzInput, ctx: AuthzContext): AuthzResult {
  const canonical = resolveKey(input.permission);
  const entry = getDefinition(input.permission);

  const base = {
    matchedRoleAssignments: [] as string[],
    matchedPermissions: [] as string[],
    appliedRestrictions: [] as string[],
    requiredConditions: [] as string[],
  };

  const audit = (decidedAtStep: string) => ({
    userId: input.userId,
    firmId: input.firmId,
    permission: input.permission,
    canonicalPermission: canonical,
    ...(input.caseId !== undefined ? { caseId: input.caseId } : {}),
    ...(input.officeId !== undefined ? { officeId: input.officeId } : {}),
    ...(input.reportType !== undefined ? { reportType: input.reportType } : {}),
    decidedAtStep,
    evaluatedAt: ctx.now.toISOString(),
  });

  const deny = (
    denialCode: DenialCode,
    step: string,
    extras?: Partial<Pick<AuthzResult, "appliedRestrictions" | "requiredConditions" | "userSafeReason">>,
  ): AuthzResult => ({
    allowed: false,
    denialCode,
    userSafeReason: extras?.userSafeReason ?? REASONS[denialCode],
    ...base,
    appliedRestrictions: extras?.appliedRestrictions ?? base.appliedRestrictions,
    requiredConditions: extras?.requiredConditions ?? base.requiredConditions,
    auditContext: audit(step),
  });

  if (!entry) return deny("UNKNOWN_PERMISSION", "0-registry");

  // 1 — system prohibition. Platform-only keys are never available to firm
  // users; no role, custom allow, or grant can rescue them.
  if (entry.platformOnly) {
    return deny("SYSTEM_PROHIBITION", "1-system-prohibition", {
      appliedRestrictions: ["platform-only permission"],
    });
  }

  // 2 — tenant boundary.
  if (input.firmId !== ctx.userFirmId) {
    return deny("TENANT_BOUNDARY", "2-tenant-boundary", {
      appliedRestrictions: ["cross-tenant access is never permitted"],
    });
  }

  // 3 — feature flag.
  if (entry.featureFlag && !flagEnabled(ctx.firmFeatures, entry.featureFlag)) {
    return deny("FEATURE_DISABLED", "3-feature-flag", {
      appliedRestrictions: [`feature flag ${entry.featureFlag} is disabled`],
    });
  }

  // 4 — credential requirement. Needs an unexpired credential of the required
  // category whose status is ORG_VERIFIED or EXTERNALLY_VERIFIED
  // (SELF_REPORTED/PENDING/EXPIRED/SUSPENDED never qualify).
  if (entry.requiresCredential) {
    const ok = (ctx.credentials ?? []).some(
      (c) =>
        c.category === entry.requiresCredential &&
        VERIFIED_CREDENTIAL_STATUSES.has(c.status) &&
        (!c.expiresAt || c.expiresAt.getTime() > ctx.now.getTime()),
    );
    if (!ok) {
      return deny("CREDENTIAL_REQUIRED", "4-credential", {
        userSafeReason: `A verified ${entry.requiresCredential} credential is required for this action.`,
        requiredConditions: [`ACTIVE verified ${entry.requiresCredential} credential`],
      });
    }
    base.requiredConditions.push(`verified ${entry.requiresCredential} credential on file`);
  }

  const entries = collectEntries(canonical, ctx);

  // 5 — explicit scoped DENY. A deny that applies to the requested resource
  // wins over every allow: a broader deny (ORGANIZATION) blankets narrower
  // allows, and a narrower deny (CASE) carves out a broader allow. Sorted so
  // the most specific applicable deny is reported.
  const denies = entries
    .filter((e) => e.effect === "DENY" && entryApplies(e, input))
    .sort((a2, b2) => SCOPE_SPECIFICITY[b2.scopeType] - SCOPE_SPECIFICITY[a2.scopeType]);
  if (denies.length > 0) {
    const d = denies[0];
    return deny("EXPLICIT_DENY", "5-explicit-deny", {
      appliedRestrictions: [`explicit DENY at ${d.scopeType} scope (${d.source})`],
    });
  }

  // 6 — workflow-stage prohibition.
  if (input.workflowStage && LOCKED_STAGES.has(input.workflowStage) && isStageLockedKey(entry)) {
    return deny("STAGE_LOCKED", "6-workflow-stage", {
      appliedRestrictions: [`stage ${input.workflowStage} locks ${entry.category.toLowerCase()} edits`],
      requiredConditions: ["workflow.unlock (with reason) or report.amend/report.supersede"],
    });
  }

  // 7 — report-state prohibition.
  if (input.reportStatus === "FINAL" && REPORT_FINAL_LOCKED.has(canonical)) {
    return deny("REPORT_STATE", "7-report-state", {
      appliedRestrictions: ["report is FINAL; amend or supersede instead"],
    });
  }

  // 8/9/10 — assignment & resource scope, explicit scoped allows, role allows.
  const allows = entries.filter((e) => e.effect === "ALLOW");
  const applicable = allows.filter((e) => entryApplies(e, input));

  if (applicable.length > 0) {
    const sources = [...new Set(applicable.map((e) => e.source))];
    const scopes = [...new Set(applicable.map((e) => e.scopeType))];
    return {
      allowed: true,
      userSafeReason: "Allowed.",
      matchedRoleAssignments: sources,
      matchedPermissions: [...new Set([input.permission, canonical])],
      appliedRestrictions: scopes.every((s) => s === "ORGANIZATION")
        ? []
        : [`granted at ${scopes.join("/")} scope`],
      requiredConditions: base.requiredConditions,
      auditContext: audit("9/10-allow"),
    };
  }

  // Allows exist but none reach this resource → the caller must supply (or the
  // user must obtain) a matching case/office assignment.
  if (allows.length > 0) {
    return deny("SCOPE_REQUIRED", "8-scope", {
      appliedRestrictions: allows.map((e) => `${e.source} allow limited to ${e.scopeType} scope`),
      requiredConditions: ["an assignment or grant covering this case/office"],
    });
  }

  // 11 — default deny.
  return deny("NO_GRANT", "11-default-deny");
}

// ── User-safe explanation ────────────────────────────────────────────────────

/**
 * Render a result as user-safe bullets (per the brief's ALLOWED/DENIED
 * examples). Never exposes internals beyond role names and scope words.
 */
export function explain(result: AuthzResult): string[] {
  const perm = result.auditContext.permission;
  if (result.allowed) {
    const lines = [`ALLOWED — ${perm}`];
    if (result.matchedRoleAssignments.length > 0) {
      lines.push(`Granted by: ${result.matchedRoleAssignments.join(", ")}`);
    }
    for (const c of result.requiredConditions) lines.push(`Condition verified: ${c}`);
    for (const r of result.appliedRestrictions) lines.push(`Note: ${r}`);
    return lines;
  }
  const lines = [`DENIED — ${perm}`, result.userSafeReason];
  for (const c of result.requiredConditions) lines.push(`Needed: ${c}`);
  return lines;
}
