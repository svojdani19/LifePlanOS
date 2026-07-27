import { describe, it, expect, beforeEach } from "vitest";
import { ROLE_PERMISSIONS, type Permission } from "@/lib/rbac";
import { REPORT_FLAGS } from "@/lib/flags";
import {
  PERMISSION_REGISTRY,
  ALIASES,
  ALL_PERMISSION_KEYS,
  resolveKey,
  isValidKey,
  getDefinition,
} from "./registry";
import {
  BUILT_IN_ROLES,
  ALL_ROLE_TEMPLATES,
  LEGACY_ROLE_MAP,
  LEGACY_BILLING,
  FIRM_ADMINISTRATOR,
  EXTERNAL_EXPERT,
} from "./roles";
import { authorize, explain, type AuthzContext, type AuthzInput } from "./evaluate";
import { shadowCompare, divergenceReport, resetShadowCounters } from "./shadow";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-01T12:00:00Z");
const FIRM = "firm-1";
const USER = "user-1";

function ctx(overrides: Partial<AuthzContext> = {}): AuthzContext {
  return { userFirmId: FIRM, now: NOW, ...overrides };
}

function input(permission: string, overrides: Partial<AuthzInput> = {}): AuthzInput {
  return { userId: USER, firmId: FIRM, permission, ...overrides };
}

const DAY = 86_400_000;
const past = new Date(NOW.getTime() - 30 * DAY);
const future = new Date(NOW.getTime() + 30 * DAY);

/** All 14 legacy canonical keys. */
const LEGACY_KEYS = new Set<string>(
  Object.values(ROLE_PERMISSIONS)
    .flat()
    .map((k) => k as string),
);

// ─── Registry invariants ─────────────────────────────────────────────────────

describe("authz registry — invariants", () => {
  it("defines ~70 keys, each with complete metadata", () => {
    expect(ALL_PERMISSION_KEYS.length).toBeGreaterThanOrEqual(65);
    for (const key of ALL_PERMISSION_KEYS) {
      const d = PERMISSION_REGISTRY[key];
      expect(d.key).toBe(key);
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(0);
      expect(["LOW", "MODERATE", "HIGH", "CRITICAL"]).toContain(d.risk);
      expect(d.scopes.length).toBeGreaterThan(0);
      expect(typeof d.delegable).toBe("boolean");
      expect(typeof d.externalAssignable).toBe("boolean");
      expect(typeof d.customRoleAssignable).toBe("boolean");
      expect(typeof d.platformOnly).toBe("boolean");
      expect(typeof d.privileged).toBe("boolean");
    }
  });

  it("keeps every legacy rbac key canonical in the registry", () => {
    for (const key of LEGACY_KEYS) {
      expect(PERMISSION_REGISTRY[key], `legacy key ${key} must stay canonical`).toBeDefined();
      expect(ALIASES[key], `legacy key ${key} must not be an alias`).toBeUndefined();
    }
  });

  it("has no duplicate canonical meanings: aliases are not registry keys and resolve to canonical keys", () => {
    for (const [alias, canonical] of Object.entries(ALIASES)) {
      expect(PERMISSION_REGISTRY[alias]).toBeUndefined();
      expect(PERMISSION_REGISTRY[canonical]).toBeDefined();
      expect(ALIASES[canonical]).toBeUndefined(); // no alias chains
    }
  });

  it("resolveKey/isValidKey handle canonical, alias, and unknown keys", () => {
    expect(resolveKey("recommendation.edit")).toBe("futurecare.edit");
    expect(resolveKey("recommendation.approve")).toBe("physician.review");
    expect(resolveKey("futurecare.edit")).toBe("futurecare.edit");
    expect(isValidKey("users.manage")).toBe(true);
    expect(isValidKey("case.view")).toBe(true);
    expect(isValidKey("not.a.permission")).toBe(false);
    expect(getDefinition("recommendation.edit")?.key).toBe("futurecare.edit");
  });

  it("marks every requiresCredential key privileged with HIGH/CRITICAL risk", () => {
    const credentialed = ALL_PERMISSION_KEYS.filter((k) => PERMISSION_REGISTRY[k].requiresCredential);
    expect(credentialed.length).toBeGreaterThanOrEqual(5);
    for (const key of credentialed) {
      const d = PERMISSION_REGISTRY[key];
      expect(d.privileged, `${key} must be privileged`).toBe(true);
      expect(["HIGH", "CRITICAL"], `${key} risk`).toContain(d.risk);
      expect(d.delegable, `${key} must not be delegable`).toBe(false);
    }
  });

  it("marks attestation/approval keys with the right credential categories", () => {
    expect(PERMISSION_REGISTRY["physician.review"].requiresCredential).toBe("PHYSICIAN");
    expect(PERMISSION_REGISTRY["report.approve"].requiresCredential).toBe("PHYSICIAN");
    expect(PERMISSION_REGISTRY["report.attest"].requiresCredential).toBe("PHYSICIAN");
    expect(PERMISSION_REGISTRY["vocational.attest"].requiresCredential).toBe("VOCATIONAL");
    expect(PERMISSION_REGISTRY["economic.attest"].requiresCredential).toBe("ECONOMIST");
  });

  it("platform-only keys are never delegable, external, or custom-role assignable", () => {
    const platform = ALL_PERMISSION_KEYS.filter((k) => PERMISSION_REGISTRY[k].platformOnly);
    expect(platform).toEqual(
      expect.arrayContaining(["featureflags.manage", "integrations.manage", "organizations.manage"]),
    );
    for (const key of platform) {
      const d = PERMISSION_REGISTRY[key];
      expect(d.delegable).toBe(false);
      expect(d.externalAssignable).toBe(false);
      expect(d.customRoleAssignable).toBe(false);
      expect(d.privileged).toBe(true);
    }
  });

  it("restricts roles.* mutation keys: not delegable, not custom-role assignable", () => {
    for (const key of ["roles.create", "roles.edit", "roles.assign", "roles.archive"]) {
      expect(PERMISSION_REGISTRY[key].delegable).toBe(false);
      expect(PERMISSION_REGISTRY[key].customRoleAssignable).toBe(false);
    }
    expect(PERMISSION_REGISTRY["roles.view"].delegable).toBe(true);
  });

  it("uses only real REPORT_FLAGS keys as feature flags", () => {
    for (const key of ALL_PERMISSION_KEYS) {
      const flag = PERMISSION_REGISTRY[key].featureFlag;
      if (flag) expect(flag in REPORT_FLAGS, `${key} flag ${flag}`).toBe(true);
    }
    expect(PERMISSION_REGISTRY["vocational.edit"].featureFlag).toBe("report.vocational_assessment");
    expect(PERMISSION_REGISTRY["economic.attest"].featureFlag).toBe("report.forensic_economist");
  });
});

// ─── Role templates ──────────────────────────────────────────────────────────

describe("authz roles — built-in templates", () => {
  it("defines the 13-role roster", () => {
    expect(Object.keys(BUILT_IN_ROLES).sort()).toEqual(
      [
        "ATTORNEY_CLIENT",
        "CASE_MANAGER",
        "EXTERNAL_EXPERT",
        "FIRM_ADMINISTRATOR",
        "FORENSIC_ECONOMIST",
        "INSURANCE_CLIENT",
        "LIFE_CARE_PLANNER",
        "MEDICAL_RECORD_ANALYST",
        "PHYSICIAN_REVIEWER",
        "PLATFORM_SYSTEM_ADMINISTRATOR",
        "QUALITY_ASSURANCE_REVIEWER",
        "READ_ONLY_OBSERVER",
        "VOCATIONAL_EXPERT",
      ].sort(),
    );
  });

  it("references only valid registry keys, canonical form, no duplicates", () => {
    for (const tpl of Object.values(ALL_ROLE_TEMPLATES)) {
      expect(new Set(tpl.permissions).size).toBe(tpl.permissions.length);
      for (const key of tpl.permissions) {
        expect(isValidKey(key), `${tpl.key} → ${key}`).toBe(true);
        expect(resolveKey(key), `${tpl.key} should use canonical keys`).toBe(key);
      }
    }
  });

  // The CRITICAL compat rule: template permissions projected onto the legacy
  // 14-key space (through ALIASES) must exactly equal ROLE_PERMISSIONS.
  it.each(Object.entries(LEGACY_ROLE_MAP))(
    "legacy %s maps to a template whose legacy-key projection is exactly equivalent",
    (legacyRole, templateKey) => {
      const tpl = ALL_ROLE_TEMPLATES[templateKey];
      expect(tpl, `template ${templateKey}`).toBeDefined();
      const projection = new Set(
        tpl.permissions.map((k) => resolveKey(k)).filter((k) => LEGACY_KEYS.has(k)),
      );
      const expected = new Set(ROLE_PERMISSIONS[legacyRole as keyof typeof ROLE_PERMISSIONS] as Permission[]);
      expect([...projection].sort()).toEqual([...expected].sort());
    },
  );

  it("gives FIRM_ADMINISTRATOR roles/users/org keys but no expert attestation keys", () => {
    const perms = new Set(FIRM_ADMINISTRATOR.permissions);
    for (const k of ["roles.create", "roles.edit", "roles.assign", "team.manage", "firm.settings", "offices.manage"]) {
      expect(perms.has(k), k).toBe(true);
    }
    for (const k of ["report.approve", "report.attest", "vocational.attest", "economic.attest", "vocational.edit", "economic.edit"]) {
      expect(perms.has(k), `admin must not hold ${k}`).toBe(false);
    }
    // physician.review is retained purely for legacy-ADMIN set equivalence and
    // stays credential-gated at evaluation time.
    expect(perms.has("physician.review")).toBe(true);
  });

  it("external-facing templates use CASE default scope and only externalAssignable keys", () => {
    const external = Object.values(BUILT_IN_ROLES).filter((t) => t.externalFacing);
    expect(external.map((t) => t.key).sort()).toEqual(["ATTORNEY_CLIENT", "EXTERNAL_EXPERT", "INSURANCE_CLIENT"]);
    for (const tpl of external) {
      expect(tpl.defaultScope).toBe("CASE");
      for (const key of tpl.permissions) {
        expect(PERMISSION_REGISTRY[key].externalAssignable, `${tpl.key} → ${key}`).toBe(true);
      }
    }
    expect(EXTERNAL_EXPERT.defaultScope).toBe("CASE");
  });

  it("keeps LEGACY_BILLING to billing keys only (no case access)", () => {
    expect(LEGACY_BILLING.permissions.sort()).toEqual(["billing.manage", "billing.view"]);
  });

  it("gives non-platform templates no platform-only keys", () => {
    for (const tpl of Object.values(ALL_ROLE_TEMPLATES)) {
      if (tpl.key === "PLATFORM_SYSTEM_ADMINISTRATOR") continue;
      for (const key of tpl.permissions) {
        expect(PERMISSION_REGISTRY[key].platformOnly, `${tpl.key} → ${key}`).toBe(false);
      }
    }
  });
});

// ─── Evaluation — the 11 steps ───────────────────────────────────────────────

describe("authorize — step 1: system prohibition", () => {
  it("denies platform-only keys even for a firm administrator with an explicit custom allow", () => {
    const r = authorize(
      input("featureflags.manage"),
      ctx({
        legacyRole: "ADMIN",
        assignments: [
          {
            status: "ACTIVE",
            customRolePermissions: [
              { permissionKey: "featureflags.manage", effect: "ALLOW", scopeType: "ORGANIZATION" },
            ],
          },
        ],
      }),
    );
    expect(r.allowed).toBe(false);
    expect(r.denialCode).toBe("SYSTEM_PROHIBITION");
  });

  it("denies unknown permission keys outright", () => {
    const r = authorize(input("totally.made.up"), ctx({ legacyRole: "ADMIN" }));
    expect(r.allowed).toBe(false);
    expect(r.denialCode).toBe("UNKNOWN_PERMISSION");
  });
});

describe("authorize — step 2: tenant boundary", () => {
  it("denies when the target firm differs from the user's firm, regardless of role", () => {
    const r = authorize(
      { ...input("case.view"), firmId: "firm-OTHER" },
      ctx({ legacyRole: "ADMIN" }),
    );
    expect(r.allowed).toBe(false);
    expect(r.denialCode).toBe("TENANT_BOUNDARY");
  });
});

describe("authorize — step 3: feature flag", () => {
  it("blocks a flag-gated key despite a role allow when the flag is disabled", () => {
    const r = authorize(
      input("vocational.edit"),
      ctx({ assignments: [{ builtInRole: "VOCATIONAL_EXPERT", status: "ACTIVE" }] }),
    );
    expect(r.allowed).toBe(false);
    expect(r.denialCode).toBe("FEATURE_DISABLED");
  });

  it("allows the same key once the firm enables the flag", () => {
    const r = authorize(
      input("vocational.edit", { caseId: "case-1" }),
      ctx({
        firmFeatures: { "report.vocational_assessment": true },
        assignments: [{ builtInRole: "VOCATIONAL_EXPERT", caseId: "case-1", status: "ACTIVE" }],
      }),
    );
    expect(r.allowed).toBe(true);
  });
});

describe("authorize — step 4: credential requirement", () => {
  const physicianCtx = (credentials: AuthzContext["credentials"]) =>
    ctx({ legacyRole: "PHYSICIAN_REVIEWER", credentials });

  it("denies physician sign-off with no credential on file", () => {
    const r = authorize(input("physician.review"), physicianCtx([]));
    expect(r.allowed).toBe(false);
    expect(r.denialCode).toBe("CREDENTIAL_REQUIRED");
    expect(r.userSafeReason).toContain("PHYSICIAN");
  });

  it("denies with only a SELF_REPORTED credential", () => {
    const r = authorize(
      input("physician.review"),
      physicianCtx([{ category: "PHYSICIAN", status: "SELF_REPORTED" }]),
    );
    expect(r.denialCode).toBe("CREDENTIAL_REQUIRED");
  });

  it("allows with an ORG_VERIFIED unexpired credential", () => {
    const r = authorize(
      input("physician.review"),
      physicianCtx([{ category: "PHYSICIAN", status: "ORG_VERIFIED", expiresAt: future }]),
    );
    expect(r.allowed).toBe(true);
    expect(r.requiredConditions.join(" ")).toContain("PHYSICIAN");
  });

  it("denies with an ORG_VERIFIED but expired credential", () => {
    const r = authorize(
      input("physician.review"),
      physicianCtx([{ category: "PHYSICIAN", status: "ORG_VERIFIED", expiresAt: past }]),
    );
    expect(r.denialCode).toBe("CREDENTIAL_REQUIRED");
  });

  it("ignores a verified credential of the wrong category", () => {
    const r = authorize(
      input("physician.review"),
      physicianCtx([{ category: "VOCATIONAL", status: "EXTERNALLY_VERIFIED" }]),
    );
    expect(r.denialCode).toBe("CREDENTIAL_REQUIRED");
  });

  it("accepts recommendation.approve as an alias of physician.review", () => {
    const r = authorize(
      input("recommendation.approve"),
      physicianCtx([{ category: "PHYSICIAN", status: "EXTERNALLY_VERIFIED" }]),
    );
    expect(r.allowed).toBe(true);
    expect(r.auditContext.canonicalPermission).toBe("physician.review");
  });
});

describe("authorize — step 5: explicit DENY", () => {
  const orgAllowAssignment = { builtInRole: "LIFE_CARE_PLANNER", status: "ACTIVE" };

  it("CASE-scoped DENY overrides an ORGANIZATION allow on the matching case", () => {
    const r = authorize(
      input("futurecare.edit", { caseId: "case-9" }),
      ctx({
        assignments: [
          orgAllowAssignment,
          {
            status: "ACTIVE",
            customRolePermissions: [
              { permissionKey: "futurecare.edit", effect: "DENY", scopeType: "CASE", scopeConfig: { caseId: "case-9" } },
            ],
          },
        ],
      }),
    );
    expect(r.allowed).toBe(false);
    expect(r.denialCode).toBe("EXPLICIT_DENY");
  });

  it("the same CASE-scoped DENY does not block other cases", () => {
    const r = authorize(
      input("futurecare.edit", { caseId: "case-other" }),
      ctx({
        assignments: [
          orgAllowAssignment,
          {
            status: "ACTIVE",
            customRolePermissions: [
              { permissionKey: "futurecare.edit", effect: "DENY", scopeType: "CASE", scopeConfig: { caseId: "case-9" } },
            ],
          },
        ],
      }),
    );
    expect(r.allowed).toBe(true);
  });

  it("ORGANIZATION DENY beats a CASE-scoped ALLOW (deny at same-or-broader scope wins)", () => {
    const r = authorize(
      input("futurecare.edit", { caseId: "case-1" }),
      ctx({
        assignments: [
          {
            status: "ACTIVE",
            caseId: "case-1",
            customRolePermissions: [
              { permissionKey: "futurecare.edit", effect: "ALLOW", scopeType: "CASE", scopeConfig: { caseId: "case-1" } },
              { permissionKey: "futurecare.edit", effect: "DENY", scopeType: "ORGANIZATION" },
            ],
          },
        ],
      }),
    );
    expect(r.allowed).toBe(false);
    expect(r.denialCode).toBe("EXPLICIT_DENY");
  });

  it("a DENY on an aliased key blocks the canonical key too", () => {
    const r = authorize(
      input("futurecare.edit"),
      ctx({
        legacyRole: "PLANNER",
        assignments: [
          {
            status: "ACTIVE",
            customRolePermissions: [
              { permissionKey: "recommendation.edit", effect: "DENY", scopeType: "ORGANIZATION" },
            ],
          },
        ],
      }),
    );
    expect(r.denialCode).toBe("EXPLICIT_DENY");
  });
});

describe("authorize — step 6: workflow-stage lock", () => {
  it("stage FINAL blocks futurecare.edit even for the planner role", () => {
    const r = authorize(
      input("futurecare.edit", { caseId: "case-1", workflowStage: "FINAL" }),
      ctx({ legacyRole: "PLANNER" }),
    );
    expect(r.allowed).toBe(false);
    expect(r.denialCode).toBe("STAGE_LOCKED");
  });

  it("stage FINAL still allows report.amend and workflow.unlock", () => {
    const admin = ctx({ legacyRole: "ADMIN" });
    expect(authorize(input("report.amend", { caseId: "case-1", workflowStage: "FINAL" }), admin).allowed).toBe(true);
    expect(authorize(input("workflow.unlock", { caseId: "case-1", workflowStage: "FINAL" }), admin).allowed).toBe(true);
  });

  it("stage ARCHIVED blocks records.upload but not case.view", () => {
    const planner = ctx({ legacyRole: "PLANNER" });
    expect(authorize(input("records.upload", { caseId: "c", workflowStage: "ARCHIVED" }), planner).denialCode).toBe(
      "STAGE_LOCKED",
    );
    expect(authorize(input("case.view", { caseId: "c", workflowStage: "ARCHIVED" }), planner).allowed).toBe(true);
  });

  it("active stages do not lock edits", () => {
    const r = authorize(
      input("futurecare.edit", { caseId: "case-1", workflowStage: "FUTURE_CARE" }),
      ctx({ legacyRole: "PLANNER" }),
    );
    expect(r.allowed).toBe(true);
  });
});

describe("authorize — step 7: report state", () => {
  const planner = () => ctx({ legacyRole: "PLANNER" });

  it("a FINAL report blocks report.delete_draft and report.edit", () => {
    expect(authorize(input("report.delete_draft", { reportStatus: "FINAL" }), planner()).denialCode).toBe(
      "REPORT_STATE",
    );
    expect(authorize(input("report.edit", { reportStatus: "FINAL" }), planner()).denialCode).toBe("REPORT_STATE");
  });

  it("a DRAFT report allows report.edit; FINAL still allows report.download", () => {
    expect(authorize(input("report.edit", { reportStatus: "DRAFT" }), planner()).allowed).toBe(true);
    expect(authorize(input("report.download", { reportStatus: "FINAL" }), planner()).allowed).toBe(true);
  });
});

describe("authorize — step 8: assignment/resource scope", () => {
  const caseScopedPlanner = () =>
    ctx({ assignments: [{ builtInRole: "LIFE_CARE_PLANNER", caseId: "case-1", status: "ACTIVE" }] });

  it("a CASE-scoped allow without a matching caseId → SCOPE_REQUIRED", () => {
    const r = authorize(input("futurecare.edit", { caseId: "case-2" }), caseScopedPlanner());
    expect(r.allowed).toBe(false);
    expect(r.denialCode).toBe("SCOPE_REQUIRED");
  });

  it("the same allow with the matching caseId → allowed", () => {
    const r = authorize(input("futurecare.edit", { caseId: "case-1" }), caseScopedPlanner());
    expect(r.allowed).toBe(true);
    expect(r.matchedRoleAssignments).toContain("built-in:LIFE_CARE_PLANNER");
  });

  it("an OFFICE-scoped allow matches only its office", () => {
    const officeCtx = ctx({
      assignments: [{ builtInRole: "CASE_MANAGER", officeId: "office-A", status: "ACTIVE" }],
    });
    expect(authorize(input("case.edit", { officeId: "office-A" }), officeCtx).allowed).toBe(true);
    expect(authorize(input("case.edit", { officeId: "office-B" }), officeCtx).denialCode).toBe("SCOPE_REQUIRED");
  });
});

describe("authorize — time windows on assignments and grants", () => {
  it("ignores an expired assignment", () => {
    const r = authorize(
      input("case.view"),
      ctx({
        assignments: [
          { builtInRole: "LIFE_CARE_PLANNER", status: "ACTIVE", effectiveFrom: past, effectiveUntil: past },
        ],
      }),
    );
    expect(r.denialCode).toBe("NO_GRANT");
  });

  it("ignores a scheduled assignment whose effectiveFrom is in the future", () => {
    const r = authorize(
      input("case.view"),
      ctx({ assignments: [{ builtInRole: "LIFE_CARE_PLANNER", status: "ACTIVE", effectiveFrom: future }] }),
    );
    expect(r.denialCode).toBe("NO_GRANT");
  });

  it("ignores REVOKED assignments even inside their window", () => {
    const r = authorize(
      input("case.view"),
      ctx({ assignments: [{ builtInRole: "LIFE_CARE_PLANNER", status: "REVOKED", effectiveFrom: past }] }),
    );
    expect(r.denialCode).toBe("NO_GRANT");
  });

  it("ignores an expired grant", () => {
    const r = authorize(
      input("costs.view", { caseId: "case-1" }),
      ctx({
        grants: [
          {
            scopeType: "CASE",
            scopeId: "case-1",
            permissions: ["costs.view"],
            status: "ACTIVE",
            effectiveFrom: past,
            effectiveUntil: past,
          },
        ],
      }),
    );
    expect(r.denialCode).toBe("NO_GRANT");
  });

  it("allows through a temporary grant inside its window", () => {
    const r = authorize(
      input("costs.view", { caseId: "case-1" }),
      ctx({
        grants: [
          {
            scopeType: "CASE",
            scopeId: "case-1",
            permissions: ["costs.view"],
            status: "ACTIVE",
            effectiveFrom: past,
            effectiveUntil: future,
          },
        ],
      }),
    );
    expect(r.allowed).toBe(true);
    expect(r.matchedRoleAssignments).toContain("access-grant");
  });
});

describe("authorize — aggregation, legacy, and default deny", () => {
  it("aggregates multiple roles as a union of allows", () => {
    const multi = ctx({
      assignments: [
        { builtInRole: "MEDICAL_RECORD_ANALYST", status: "ACTIVE" },
        { builtInRole: "QUALITY_ASSURANCE_REVIEWER", status: "ACTIVE" },
      ],
    });
    // From the analyst.
    expect(authorize(input("chronology.edit"), multi).allowed).toBe(true);
    // From the QA reviewer.
    expect(authorize(input("qa.review"), multi).allowed).toBe(true);
    // From neither.
    expect(authorize(input("billing.manage"), multi).denialCode).toBe("NO_GRANT");
  });

  it("legacy PLANNER keeps working via the template at ORGANIZATION scope", () => {
    const planner = ctx({ legacyRole: "PLANNER" });
    const r = authorize(input("futurecare.edit", { caseId: "any-case" }), planner);
    expect(r.allowed).toBe(true);
    expect(r.matchedRoleAssignments[0]).toContain("legacy:PLANNER");
    expect(authorize(input("team.manage"), planner).denialCode).toBe("NO_GRANT");
  });

  it("legacy BILLING_USER gets billing only", () => {
    const billing = ctx({ legacyRole: "BILLING_USER" });
    expect(authorize(input("billing.manage"), billing).allowed).toBe(true);
    expect(authorize(input("case.view"), billing).denialCode).toBe("NO_GRANT");
  });

  it("accepts alias input keys and reports the canonical key", () => {
    const r = authorize(input("recommendation.edit", { caseId: "c1" }), ctx({ legacyRole: "PLANNER" }));
    expect(r.allowed).toBe(true);
    expect(r.auditContext.canonicalPermission).toBe("futurecare.edit");
    expect(r.matchedPermissions).toContain("futurecare.edit");
  });

  it("default-denies with an empty context", () => {
    const r = authorize(input("case.view"), ctx());
    expect(r.allowed).toBe(false);
    expect(r.denialCode).toBe("NO_GRANT");
    expect(r.userSafeReason.length).toBeGreaterThan(0);
  });
});

// ─── Legacy shadow-equivalence sweep ─────────────────────────────────────────

describe("authorize — full legacy matrix equivalence (shadow starts clean)", () => {
  // For every legacy role × legacy permission, the new evaluator (with no
  // credentials/stage/report inputs beyond what legacy knew about) must match
  // rbac.can() — except credential-gated keys, where the new path adds the
  // verification requirement by design; with a verified credential supplied it
  // must match exactly.
  const legacyRoles = Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[];

  it.each(legacyRoles)("%s matches the legacy matrix on all 14 keys", (role) => {
    const allowedSet = new Set(ROLE_PERMISSIONS[role]);
    for (const key of LEGACY_KEYS) {
      const needsCredential = PERMISSION_REGISTRY[key].requiresCredential;
      const c = ctx({
        legacyRole: role,
        credentials: needsCredential
          ? [{ category: needsCredential, status: "ORG_VERIFIED", expiresAt: future }]
          : [],
      });
      const r = authorize(input(key), c);
      expect(r.allowed, `${role} × ${key}`).toBe(allowedSet.has(key as Permission));
    }
  });
});

// ─── explain() ───────────────────────────────────────────────────────────────

describe("explain — user-safe output", () => {
  it("renders an ALLOWED result with its grant sources", () => {
    const r = authorize(input("case.view"), ctx({ legacyRole: "PLANNER" }));
    const lines = explain(r);
    expect(lines[0]).toContain("ALLOWED");
    expect(lines.join("\n")).toContain("case.view");
    expect(lines.join("\n")).toContain("Granted by");
  });

  it("renders a DENIED result with the user-safe reason and needed conditions, no internals", () => {
    const r = authorize(input("physician.review"), ctx({ legacyRole: "PHYSICIAN_REVIEWER", credentials: [] }));
    const lines = explain(r);
    expect(lines[0]).toContain("DENIED");
    expect(lines.join("\n")).toContain("PHYSICIAN");
    expect(lines.join("\n")).not.toContain("decidedAtStep");
    expect(lines.join("\n")).not.toContain("4-credential");
  });
});

// ─── Shadow comparison ───────────────────────────────────────────────────────

describe("shadowCompare — divergence tracking", () => {
  beforeEach(() => resetShadowCounters());

  const allow = () => authorize(input("case.view"), ctx({ legacyRole: "PLANNER" }));
  const denyResult = () => authorize(input("case.view"), ctx());

  it("reports no divergence when both paths agree", () => {
    expect(shadowCompare(true, allow(), { permission: "case.view", route: "/api/cases" })).toEqual({
      diverged: false,
      direction: null,
    });
    expect(divergenceReport().divergences).toBe(0);
    expect(divergenceReport().comparisons).toBe(1);
  });

  it("classifies new-denies and new-allows directions", () => {
    expect(shadowCompare(true, denyResult(), { permission: "case.view", route: "/api/cases" }).direction).toBe(
      "new-denies",
    );
    expect(shadowCompare(false, allow(), { permission: "case.view", route: "/api/cases" }).direction).toBe(
      "new-allows",
    );
  });

  it("aggregates counts by route+permission+direction with denial codes and resets cleanly", () => {
    for (let i = 0; i < 3; i++) {
      shadowCompare(true, denyResult(), { permission: "case.view", route: "/api/cases/[caseId]" });
    }
    const report = divergenceReport();
    expect(report.divergences).toBe(3);
    expect(report.byRoute[0]).toMatchObject({
      route: "/api/cases/[caseId]",
      permission: "case.view",
      direction: "new-denies",
      count: 3,
    });
    expect(report.byRoute[0].denialCodes.NO_GRANT).toBe(3);
    // Buckets never carry user/case identifiers (no PHI).
    expect(JSON.stringify(report)).not.toContain(USER);
    resetShadowCounters();
    expect(divergenceReport().comparisons).toBe(0);
    expect(divergenceReport().byRoute).toHaveLength(0);
  });
});
