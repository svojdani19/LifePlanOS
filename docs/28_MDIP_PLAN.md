# Medical Damages Intelligence Platform (MDIP) — Execution Plan

Directive: transform LifePlanOS into role-specific workspaces + damages
evaluation + engagements + demo environment, phases 0-17, continuous, additive.

## Phase 0 audit (known from prior sprints — deltas only)
Existing & reusable: enterprise authz (src/lib/authz: 78-key registry, 13 role
templates, custom roles/assignments/credentials/authz-preview, shadow+flag
enforcement), report registry (15 defs, policies, approvals/attestations,
snapshots, hashes), workflow CaseStatus enum, economics engine, Vocational/
EconomistWorkspace components, PhysicianWorkspace (/review), validation engine
(QA), Roles & Access console (/roles), Firm.features flags, audit, 785 tests,
seed (prisma/seed.ts). Missing: role-routed workspaces, damages-evaluation
engine, engagement model, notifications, demo mode/users/cases, observer.

## Architecture decisions
1. Workspaces = new routes under src/app/(app)/{attorney,case-manager,records,
   planner,physician,vocational,economist,qa,operations,platform-admin,
   observer}/page.tsx. /admin → existing /roles+/settings hub page. Physician
   page wraps existing PhysicianWorkspace; vocational/economist pages wrap the
   existing workspace components w/ case selector; planner/qa reuse existing
   queue/validation components. Server-side guard per page: requireContext +
   workspaceAllowed(role/assignments) — deny→redirect /dashboard.
2. WorkspaceSwitcher: shared client component in the app shell (layout) —
   lists workspaces allowed for the user's roles/assignments; post-login
   routing via preferredWorkspace (User.preferredWorkspace String?) → primary
   role map → dashboard.
3. FutureDamagesEvaluation: pure deterministic engine
   src/lib/engine/damagesEvaluation.ts (logicVersion "fde-1") over existing
   structured data (conditions, items, assessments, findings, voc entries,
   econ assumptions); persisted rows; isStale = caseUpdatedAt > evaluatedAt.
   No LLM anywhere in it.
4. CaseEngagement: new model per the brief (statuses RECOMMENDED..CANCELLED);
   service + API + operations/attorney surfaces. Pricing per-firm via
   Firm.features["pricing.*"] JSON config (no new billing engine).
5. Notification: minimal model {firmId,userId,kind,title,body,caseId?,readAt}
   + notify() helper called from key transitions; bell in shell.
6. Demo mode: ENABLE_DEMO_MODE env guard (+NODE_ENV!=production unless
   DEMO_MODE_PRODUCTION_ACK); Firm.isDemo Boolean; /demo page (cards, one-click
   login via /api/demo/login → creates session, only when enabled); 13 demo
   users @demo.lifeplanos.com (bcrypt via existing password hashing, DEMO_PASSWORD
   env else documented default in dev); seed scripts/demo-seed.ts building
   "Life Care Plan Partners Demo" org + 8 cases per spec; demo banner in shell
   when ctx.firm.isDemo; reset = delete demo firm cascade + reseed (platform-
   admin UI + CLI), audited.
7. Workspace access mapping (built-in role/template → workspaces):
   ADMIN→admin,operations,attorney? no — admin,operations; PLANNER→planner,
   case-manager,records; PHYSICIAN_REVIEWER→physician; ATTORNEY_REVIEWER→
   attorney; PARALEGAL→case-manager,records; BILLING_USER→operations;
   assignments with templates VOCATIONAL_EXPERT→vocational, FORENSIC_ECONOMIST
   →economist, QUALITY_ASSURANCE_REVIEWER→qa, EXTERNAL_EXPERT/ATTORNEY_CLIENT/
   INSURANCE_CLIENT/READ_ONLY_OBSERVER→observer, PLATFORM admin (env-listed
   emails or template)→platform-admin. Central map in src/lib/authz/workspaces.ts.

## File ownership (agents must not cross)
- me: schema+migration, docs, workspaces.ts, shell/switcher/banner, login
  routing, final integration+verify+commits.
- Agent A: damagesEvaluation engine+tests+API+/attorney UI.
- Agent B: CaseEngagement service+API+tests+/operations UI+notifications
  (model service+bell excluded — bell is mine; B builds notify() service+API).
- Agent C: demo seed+/demo page+/api/demo/login+reset (script+API)+tests.
- Agent D: /case-manager,/records,/observer pages.
- Agent E: /planner,/qa,/physician,/vocational,/economist,/admin,
  /platform-admin pages (wrapping existing components).
- Final: tests full run, build, docs 29 (demo guide), commit+push per commit
  discipline (established workflow).

## Schema (additive, one migration 20260728010000_mdip)
User.preferredWorkspace String?; Firm.isDemo Boolean @default(false);
FutureDamagesEvaluation{id,firmId,caseId,caseRevision Int?,logicVersion,
evaluatedAt,evaluatedById,overallOutcome,recommendedPrimaryProduct?,
recommendedAdditionalProducts Json,readinessState,supportingFactors Json,
weakeningFactors Json,missingInformation Json,unresolvedValidationIssues Int,
estimatedMedicalRange Json?,confidenceDimensions Json?,nextActions Json,
sourceFactIds Json,isStale Boolean}; CaseEngagement{...per brief};
Notification{id,firmId,userId,kind,title,body?,caseId?,readAt?,createdAt}.

## Completion status (2026-08-02)

Implemented and verified — tsc clean, 856 vitest tests green (65 files),
`next build` clean, demo tenant seeded (13 users / 8 cases):

- 14 workspace routes live under src/app/(app)/: attorney, case-manager,
  records, planner, physician, vocational, economist, qa, operations,
  firm-admin, platform-admin, external-expert, insurance, observer. Every page
  is a server component with its own role/assignment guard (deny →
  redirect /dashboard). Sidebar lists allowed workspaces; post-login routing
  honors User.preferredWorkspace via workspaceHrefForRole. Canonical workspace
  map lives in src/lib/workspaces.ts (not src/lib/authz/workspaces.ts as first
  planned — that module already existed).
- Damages engine: src/lib/engine/damagesEvaluation.ts (fde-1, pure,
  deterministic, 27 tests) + GET/POST
  /api/cases/[caseId]/damages-evaluation + attorney workspace UI.
- Engagements: src/lib/engagements/service.ts (transition graph, fees from
  Firm.features["pricing"], 22 tests) + case engagements API +
  /api/firm/pricing + operations workspace (engagements, pricing editor,
  derived invoices, capacity, deadlines).
- Notifications: model + src/lib/notifications/service.ts (notify/notifyRole,
  PHI-free bodies) + /api/notifications + bell in the sidebar
  (feature-detects the API).
- Demo mode: src/lib/demo/{config,seed}.ts, /demo one-click page,
  /api/demo/login, /api/demo/reset, scripts/demo-{seed,reset}.ts, demo banner
  in the shell, 13 tests. See docs/29_MDIP_DEMO.md.
- Migration 20260728010000_mdip applied + resolved against dev; an empty
  stray 20260802150000_role_workspaces dir was removed.
