# 13 — Developer Standards

## Change control (binding)

- **Smallest safe additive change.** No broad refactors for preference; no
  duplicate services or competing data models.
- **Stable surfaces** (change only with explicit approval): report design and
  section flow, navigation/tabs, branding, established workflows, existing API
  contracts, `tenant.ts`/`rbac.ts`/`auth` mechanics, `cost.ts` math,
  chronology/OCR extraction.
- Every new `/api/cases/[caseId]/**` route MUST use `requireApiContext()` +
  `requireCase()` (+ `requirePermission`) and write an `audit()` on mutation —
  enforced by the conformance test.
- Derived data may be wiped/rebuilt; user-authored data (review actions, notes,
  SoC inputs) must survive regeneration.

## Definition of done

1. `npx tsc --noEmit` clean; `npm test` green, including new tests for the
   change.
2. No design/branding/report drift.
3. Schema changes: additive migration + [06_DATABASE_SPEC.md](06_DATABASE_SPEC.md)
   + [CHANGELOG.md](CHANGELOG.md) updated.
4. Deterministic engines stay deterministic (no clock/randomness in logic).
5. Verified against seeded demo data where observable.

## Testing standards

- Pure logic → Vitest unit tests colocated as `*.test.ts` (no DB/network;
  vitest config enforces node env).
- Clinical invariants live in `engine/integrity.test.ts`; financial
  reproducibility in `engine/cost.test.ts`; tenancy in
  `security/tenantIsolation.test.ts`. Extend these when touching their
  domains.
- DOCX verification pattern: generate from seed → unzip → strip XML → assert
  flow/forbidden-terms/totals.

## Code conventions

- TypeScript strict; match surrounding idiom and comment density.
- Prisma client via `@/generated/prisma`; queries always firm-scoped.
- No PHI or secrets in logs, tests, fixtures, or docs.

## Accepted Technical Decisions (ATD log)

| # | Date | Decision |
|---|---|---|
| ATD-1 | 2026-07-12 | `ValidationFinding` rows are **persisted source-of-truth records** for integrity results (derived data, atomically replaced on recompute; not recomputed ad-hoc in UIs). |
| ATD-2 | 2026-07-12 | The validation GET endpoint's **summary counts may be computed live** until production profiling shows a performance problem; the stored rows remain authoritative for findings. |
| ATD-3 | 2026-07-12 | **Object-storage garbage collection on deletion and auth rate limiting are required before any paid production pilot** (release gate; see 12_DEPLOYMENT.md). |
| ATD-4 | 2026-07-12 | **Frequency/duration plausibility checks** stay on the roadmap and must begin as **narrow deterministic rules** (per-category bounds) — not broad AI inference. |
| ATD-5 | 2026-07-12 | **Regeneration supersedes rather than deletes** recommendations with review history (formal requirement P2.R1 in 14_ROADMAP.md). |
