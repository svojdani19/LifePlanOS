# LifePlanOS

**The operating system for life care planning.** A standalone, multi-tenant SaaS
for life care planning firms, rehab & nurse consultants, physician life care
planners, and law firms.

> Product principle: maximize **defensibility**, not damages. Every
> recommendation is tied to medical probability, source records, expert review,
> pricing support, and transparent reasoning.

This repository folder is a **fully standalone application**. It shares a Postgres
_server_ with other apps in the workspace but keeps every table in an isolated
`lifeplanos` Postgres schema, so there is zero coupling or collision.

---

## What's built in this milestone

This milestone delivers **Module 1 — the Firm Subscription System — plus the
multi-tenant foundation** the rest of the product hangs off of:

| Area | Status |
| --- | --- |
| Firm accounts + signup/login/logout | ✅ real cookie sessions (hashed tokens in DB) |
| Roles (admin, planner, physician reviewer, attorney reviewer, paralegal, billing) | ✅ RBAC permission matrix |
| Subscription tiers (solo / small firm / enterprise) | ✅ plan catalog + limits |
| User seats + invitations + revocation | ✅ invite links, seat limits, soft-revoke |
| Usage tracking + case limits by plan | ✅ append-only meter, enforced on create |
| Stripe billing | ✅ abstraction, **mock mode** works with no keys; live seam ready |
| Firm-branded templates | ✅ branding/letterhead in firm settings |
| Permission controls | ✅ server-enforced + UI-aware |
| Audit logs | ✅ append-only, every PHI/security action |
| Case intake (core) + tenant-scoped case list | ✅ create/list scoped by firm |
| LLM abstraction layer | ✅ provider-swappable stub (mock default) |

The chronology / future-care / cost / defense / report engines from the product
spec are the next modules; the schema and the tenant guard are designed so they
plug straight in behind `ctx.firm.id`.

## Stack

- **Next.js 14** (App Router) + React 18 + TypeScript
- **Postgres** via **Prisma** (client generated to `src/generated/prisma`)
- **Tailwind** design system (deep slate + clinical-teal identity)
- Node stdlib `scrypt` password hashing, DB-backed sessions (swap-in seam for
  NextAuth/Clerk/SSO in `src/lib/auth/session.ts`)

## Run it

```bash
cd lifeplanos

# 1. Schema → isolated `lifeplanos` Postgres schema (uses DATABASE_URL in .env)
npm run prisma:push
npm run prisma:generate

# 2. Seed a demo firm with cases, teammates, and usage
npm run db:seed

# 3. Start on http://localhost:3100
npm run dev
```

**Demo login:** `demo@lifeplanos.app` / `password123` (firm admin).
Other seeded roles share the same password (`planner@`, `physician@`, `para@`).

## Architecture notes

- **Tenant isolation** — `src/lib/tenant.ts` is the *only* sanctioned way server
  code gets identity or touches tenant data. It resolves the session to a
  `{ user, firm, subscription }` context, enforces RBAC + plan limits, and writes
  the audit/usage trail. Client-supplied `firmId` is never trusted.
- **Plan limits** live in code (`src/lib/subscription/plans.ts`) with per-firm
  Enterprise overrides on the `Subscription` row.
- **Billing** is behind `src/lib/stripe/index.ts`; mock mode applies plan changes
  instantly. Provide `STRIPE_SECRET_KEY` + price ids and wire the webhook to go
  live — no callers change.
- **AI** always flows through `src/lib/llm/index.ts` so the model provider is a
  one-line swap and guardrails have a single choke point.

## Security & compliance posture

HIPAA-ready / BAA-ready architecture: encryption in transit (TLS to Postgres),
encryption at rest (DB + storage level), role-based access, append-only audit
logging, session revocation, tenant-scoped queries. Data-retention and
export-logging controls are configurable per firm on Enterprise plans.
