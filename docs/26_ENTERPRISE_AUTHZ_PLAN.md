# Enterprise Authorization — Phase 0 Audit & Design

Extends (never replaces) the existing auth/permission architecture.
Companion: docs/23 (pilot hardening), docs/25 (pilot readiness).

## PART 1 — AUDIT (verified in-repo)

**Current-state authorization flow (diagram):**
```
Request → session cookie → readSession (opaque token, sha-256, DB row)
  → requireApiContext() {user, firm(+subscription)}          [tenant.ts:39]
  → requirePermission(ctx, perm)  — static role→perm lookup  [tenant.ts:61]
  → requireCase(ctx, caseId)      — firmId scoping, 404      [tenant.ts:68]
  → route logic (+report gates: gateReport, expert branches, flags)
  → audit(ctx, action, …)                                    [tenant.ts:125]
```

**Inventory:**
- User model: single `User` with `role UserRole` (one enum value per user),
  `inviteToken` invitation flow, `credentialSummary`; **no multi-role, no
  external-user model** — clients/experts would occupy internal seats.
- Organization: `Firm` (+subscription tiers, `features Json` flags).
  **No Office model. No CaseAssignment model** — case linkage is only
  `createdById` / `preparingPhysicianId`; dashboards already scope "my cases"
  by those two fields. Assignment-aware access does not exist.
- Roles: `UserRole` enum ×6 (ADMIN, PLANNER, PHYSICIAN_REVIEWER,
  ATTORNEY_REVIEWER, PARALEGAL, BILLING_USER). Permissions: 14 string keys in
  `rbac.ts`; static `ROLE_PERMISSIONS` map; `can()`/`requirePermission()`.
  **No custom roles, no scopes, no denials, no delegation ceiling.**
- Workflow stages: `CaseStatus` enum (INTAKE…FINAL/CLOSED/ARCHIVED) — used
  for display/pipeline, **not consulted by authorization**.
- Report authorization: registry `permission: "report.export"` + `gateReport`
  matrix + `requiredExpert` branches + flags + `ReportApproval`
  (report-level APPROVAL/ATTESTATION w/ expertRole + content hash). Strong,
  but expert-role eligibility = `physician.review` permission only —
  **credentials are not checked** (UserCredential is an uploaded-document
  model: type/label/file; no status, expiry, or verification workflow).
- Enforcement points: every API route under src/app/api uses the tenant
  guards (verified pattern); downloads/exports permission-checked + audited +
  security headers; storage keys opaque; **no server actions, no websockets,
  no background-job identity** (scripts run as operator).
- Audit: mature (`AuditLog` + action strings across auth/review/report/
  export/attestation/economics/vocational). Tenant-isolation tests exist
  (`security/tenantIsolation.test.ts`); rbac.test.ts covers the matrix.
- Seeds/migrations: hand-authored SQL + rollback per change; seed creates the
  6-role demo team.

**Security gaps (ranked):**
1. No assignment scoping — any `case.view` holder sees every firm case.
2. Credentials not verified for approval/attestation (permission ≡ authority).
3. Single-role model — no multi-role, office, temporary, or external scoping.
4. Workflow stage not enforced server-side (e.g. editing after FINAL).
5. No explicit denials, no delegation ceiling (ADMIN self-manages roles).
6. Session permissions resolved per-request from the static map (good: no
   stale claims) but there is no authorization revision for future caching.
7. `accept-all` and some engine scripts bypass per-item nuance (known).

## PART 2 — DESIGN

**Files likely to change:** `rbac.ts` (registry grows, stays source-compatible),
`tenant.ts` (+`authorize()` core + helpers), new `src/lib/authz/*`
(registry.ts, roles.ts, evaluate.ts, credentials.ts), new admin routes
`/api/firm/roles*`, `/api/firm/assignments*`, UI `src/app/(app)/team` →
Roles & Access tabs, report/case routes adopt helper calls incrementally.
Schema: new models only.

**Proposed schema (all additive, reversible):**
- `Office {id, firmId, name, …}` + `User.officeIds` via assignment rows.
- `CustomRole {id, firmId, name, description, status, clonedFromSystemRole?,
  isDefaultForNewUsers, isAssignable, version, createdBy/updatedBy, archivedAt}`
- `CustomRolePermission {customRoleId, permissionKey, effect ALLOW|DENY,
  scopeType ORGANIZATION|OFFICE|CASE|REPORT, scopeConfig Json?}`
- `UserRoleAssignment {userId, firmId, builtInRole?|customRoleId?, officeId?,
  caseId?, responsibility?, effectiveFrom/Until, status, assignedBy, reason,
  revokedAt/By/Reason}` — multi-role, scheduled, temporary, revocable.
- `RoleVersion {roleId, version, permissionSnapshot Json, changedBy/At/Reason}`
- `Credential` (extends UserCredential additively with `category
  PHYSICIAN|RN|CLCP|VOCATIONAL|ECONOMIST|OTHER, status SELF_REPORTED|
  ORG_VERIFIED|EXTERNALLY_VERIFIED|EXPIRED|SUSPENDED|PENDING, expiresAt,
  verifiedBy/At, jurisdiction`).
- `AuthzRevision` counter per firm (bumped on any role/assignment/credential/
  flag change; cache key for future memoization).
- `AccessGrant` (temporary/delegated: scope, permissions|role, start/end,
  grantor, reason — auto-expired by effectiveUntil checks). Break-glass: NOT
  implemented (not operationally necessary yet; documented as deferred).

**Built-in role strategy:** 13 protected templates defined in code
(`authz/roles.ts`) mapping to the brief's roster; the existing 6 enum values
become aliases of their templates (ADMIN→Firm Administrator, PLANNER→Life
Care Planner, PHYSICIAN_REVIEWER→Physician Reviewer, ATTORNEY_REVIEWER→
Attorney Client, PARALEGAL→Case Manager, BILLING_USER→Billing-scoped custom
template). New roster (Platform Sysadmin, Records Analyst, Vocational Expert,
Economist, QA Reviewer, External Expert, Insurance Client, Observer) are
templates assignable via UserRoleAssignment — **no UserRole enum migration**
(risky); `User.role` remains the legacy base role, assignments layer on top.

**Custom-role strategy:** clone-from-template → independent snapshot;
edits bump `version` + write RoleVersion (optimistic concurrency on version);
archive-not-delete when assigned; delegation ceiling: role editors may grant
only permission keys they hold AND that are marked delegable for their tier;
platform-only keys never delegable.

**Permission catalog:** adopt the brief's catalog, mapped onto existing keys
(existing 14 keys kept as canonical aliases — e.g. `futurecare.edit` ⇒
`recommendation.edit`; no behavioral rename). Registry entries carry
{key, name, description, category, risk LOW..CRITICAL, delegable, scopes[],
requiresCredential?, externalAssignable, customRoleAssignable, featureFlag?,
platformOnly, privileged}. ~70 keys initial.

**Evaluation order (deterministic, single function `authorize()`):**
1 system prohibition → 2 tenant boundary → 3 feature flag → 4 credential
requirement → 5 explicit scoped DENY (most-specific wins) → 6 workflow-stage
prohibition → 7 report-state prohibition → 8 assignment/resource scope →
9 explicit scoped ALLOW → 10 role ALLOW (built-in or custom) → 11 default
DENY. Returns {allowed, denialCode, userSafeReason, matched*, auditContext}.
Immutable prohibitions can never be out-ranked by a more specific allow.

**Workflow-stage restrictions:** stage policy table keyed by CaseStatus —
e.g. PHYSICIAN_REVIEW locks physician-approved items for non-physicians
(unlock = `workflow.unlock` + reason + audit + attestation invalidation);
FINAL locks edits except amend/supersede paths; ARCHIVED read-only.

**Report-specific controls:** registry definitions gain a declarative
`policy {view, editInputs, preview, draft, submit, approve, attest, finalize,
download, share, amend, supersede}` each naming permission + credential
category; immutable minimums per report type (physician for necessity/
causation/rebuttal; vocational for VA; economist for FER) enforced in
`authorize()` step 4 regardless of role content.

**Professional-qualification controls:** approval/attestation routes verify
an ACTIVE, unexpired credential of the required category (status ≥
ORG_VERIFIED by default; firm-configurable floor). Honest labeling: statuses
per the brief; no claim of independent licensure verification.

**Migration/backward-compat:** zero-behavior-change deploy — evaluate new
path in shadow mode first (log divergences from legacy `can()`), then flip
per-firm flag `authorization.enterprise`. Legacy mapping table (6 roles →
templates) + expected-access fixtures generated from current ROLE_PERMISSIONS
before any change; post-migration equivalence test compares effective access
per role/route; ambiguity → preserve access + flag for admin review.

**Test matrix:** the brief's 40 custom-role cases + per-template route
matrix + tenant isolation on every new model + stage/report/credential/flag
rejection suites + shadow-mode equivalence + concurrency (role version
conflict) + delegation-ceiling + self-escalation prevention. Route-level
tests via mocked ctx per the download-route test pattern.

**Risks & rollback:** biggest risk is silently changing today's access —
mitigated by shadow mode + equivalence fixtures + per-firm flag (rollback =
flag off; schema rollback.sql per migration). Performance: single-query
assignment/role load per request + request-scoped memo + AuthzRevision cache
key. Sessions already resolve permissions per-request (no stale-claim risk);
high-risk revocation adds session termination hook.

**Phases:** P1 registry+service+conflict rules (shadow) → P2 custom roles →
P3 assignments/offices/stages/reports/credentials → P4 enforcement adoption →
P5 admin UI (Roles & Access: built-ins, custom builder, assignments, matrix,
access review, history, impact analysis) → P6 migration flip + hardening.
Stop-and-report after each.
