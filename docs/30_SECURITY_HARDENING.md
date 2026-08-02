# MDIP Security Hardening (branch claude/mdip-security-hardening)

Implemented 2026-08-02. Each area is its own commit for independent review.

## Platform authorization (no email checks)
- Platform authority = an ACTIVE, unexpired `UserRoleAssignment` with
  `builtInRole = "PLATFORM_SYSTEM_ADMINISTRATOR"` (any firm), checked via
  `src/lib/authz/platform.ts` (`isPlatformAdmin` / `requirePlatformAdmin`).
- `PLATFORM_ADMIN_EMAILS` and every hardcoded email comparison are removed.
- Tenant admins get no platform access; platform admins get read-only
  workspace views and no professional authority.

## Demo Super Admin
- Login: `platform.admin@demo.lifeplanos.com` (Robin Demo-Vance), password
  from `DEMO_PASSWORD` (dev default `LifePlanOS-Demo-2026!` outside
  production; production seeding refuses without `DEMO_PASSWORD`). One-click
  at `/demo` when `ENABLE_DEMO_MODE=true`.
- Seeded with the org-scoped platform assignment (seed fails loudly without
  it); legacy role is BILLING_USER so nothing bypasses the DB-grant path.
- Public signup rejects the reserved `@demo.lifeplanos.com` domain.
- "View as": platform admins can open any of the 14 workspaces from
  /platform-admin via an httpOnly cookie set by the audited
  `/api/platform/view-as` route. A labeled banner ("presentation only") with
  one-click return renders while active. View-as changes navigation only —
  never permissions, credentials, or audit actor identity.

## Professional credential boundaries
- `src/lib/authz/credentialGate.ts`: a credential qualifies only with the
  matching category, status ORG_VERIFIED/EXTERNALLY_VERIFIED, and unexpired
  expiry. SELF_REPORTED/PENDING/EXPIRED/SUSPENDED/uncategorized never pass.
- Always-strict: item attestations (PHYSICIAN), report attestations (mapped
  from the report's requiredExpert), vocational VERIFIED sign-off.
- Enterprise-or-demo enforced, warn+audit (`credential.gap`) elsewhere:
  physician item decisions, report approvals, economics authorship.
- All gated routes record the session actor; regression tests cover the
  cross-professional matrix (specialists cannot cross-attest; admins and
  the Super Admin cannot attest without credentials).

## Case-scoped authorization
- `src/lib/authz/caseScope.ts` resolves accessible cases from ACTIVE
  unexpired case-scoped assignments + engagements naming the user in an
  assigned-expert slot. External-class grantees (observer, external expert,
  attorney client, insurance client) never inherit firm-wide visibility.
- PHYSICIAN_REVIEWER fallbacks removed from vocational/economist/QA
  workspaces; dashboard firm view and /cases (page + API) filtered for
  guests; platform admins view read-only.

## Damages evaluation freshness
- `FutureDamagesEvaluation.inputsHash`: sha256 of the canonicalized engine
  input + row ids + logic version. GET recomputes to report staleness from
  real content changes, not timestamp drift.

## Engagement/pricing/database integrity
- reportType validated against the report registry; fees reject
  negative/NaN/Infinity and cap at 10,000,000; AUTHORIZED unreachable
  except through the authorize action (stamps session actor + time).
- Migration `20260802160000_engagement_integrity`: six ON DELETE CASCADE
  FKs (CaseEngagement/Notification/FutureDamagesEvaluation → Case/Firm/
  User), added NOT VALID then validated after orphan cleanup. The raw FKs
  live in migration SQL, not the Prisma schema — a future `db push` may
  propose dropping them; migrations are the source of truth.

## CI
- Added `npm run lint` and non-blocking `npm audit --audit-level=high`
  to the existing validate/generate/tsc/vitest/build pipeline.

## Demo persona legacy roles (tightened)
platform.admin=BILLING_USER, firm.admin=ADMIN, attorney=ATTORNEY_REVIEWER,
case.manager=PARALEGAL, records.analyst=PARALEGAL, planner=PLANNER,
physician=PHYSICIAN_REVIEWER, vocational=PLANNER, economist=PLANNER,
qa=PARALEGAL, operations=BILLING_USER, observer=ATTORNEY_REVIEWER,
medical.director=PHYSICIAN_REVIEWER (+QA template). Specialist authority
comes from role-template assignments and verified credentials, never from
a physician seat.
