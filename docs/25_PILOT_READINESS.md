# Controlled Pilot Readiness — Life Care Plan Professionals

Operational guide for the production pilot. Companion to
docs/23_PILOT_HARDENING_PLAN.md (architecture) and docs/24_REFERENCE_CASES.md
(feeding real cases).

## Service lines and their states

| Service | Status at pilot start | Final export requires |
|---|---|---|
| Comprehensive Life Care Plan | Production (golden-test protected) | Existing recommendation-level physician review; report-level attestation when `report.report_level_attestation` enabled |
| Medical Cost Projection | Production | Standard export gate; physician-decided included items |
| Vocational Assessment | Controlled pilot (`report.vocational_assessment`) | Structured intake complete + vocational expert report approval + attestation |
| Forensic Economist Report | Controlled pilot (`report.forensic_economist`) | Explicit sourced assumptions + economist report approval + attestation |

Supporting work products (chronology, record summary, provider matrix,
physician review report, testimony pack) ship enabled; opinion-heavy analyses
(necessity, causation, rebuttal, damages summary, custom) stay behind flags
until validated.

## Tenant configuration

Per-firm flags live on `Firm.features` (Json). Example pilot firm:
```json
{ "report.vocational_assessment": true, "report.forensic_economist": true }
```
Set via DB update or the admin API; defaults in `src/lib/flags.ts` govern
anything unset. Core service lines are never hidden — disabled states render
as "Not enabled", incomplete expert workflows as "Expert input required".

## Roles for the pilot

- PLANNER — intake, records, chronology, future care, drafts.
- PHYSICIAN_REVIEWER — recommendation review, report approval/attestation for
  clinical reports.
- Vocational experts and economists occupy PHYSICIAN_REVIEWER seats for the
  pilot (report-level approvals record `expertRole` distinctly); a dedicated
  role enum value is deliberately deferred to avoid a risky enum migration
  mid-pilot.
- ATTORNEY_REVIEWER — read + export; no clinical edits.
- PARALEGAL — read-only case support; no exports.

## Non-negotiable invariants (verified by tests)

1. Legacy Life Care Plan output is golden-file locked.
2. No report type bypasses export-blocking findings for totals-bearing content.
3. Expert reports cannot be finalized without the required expert's report-level
   approval bound to the exact content hash; stale approvals display as stale.
4. Every final export: immutable file + content SHA-256 + snapshot + engine
   versions + per-type version series (concurrency-safe).
5. Failed persistence removes the stored object (no orphans).
6. Mock LLM cannot operate in production; startup env validation is fatal.
7. Downloads are authenticated, tenant-scoped, permission-checked, audited,
   and carry nosniff/no-store/no-referrer headers.

## Operational runbook

- Feed reference cases: docs/24_REFERENCE_CASES.md loop (ingest → review →
  gold-capture → learn). Track corpus in that doc's table.
- Weekly: `npx tsx scripts/clinical-validation.ts` (persists ValidationRun),
  `npx tsx scripts/gold-harness.ts`, `npx tsx scripts/review-analytics.ts`.
- Backups/restore: Neon PITR is the primary recovery path; verify retention
  window fits firm policy before onboarding real PHI. (Free-tier compute
  suspensions observed in dev — pilot requires a paid Neon tier or managed
  Postgres.)
- Rollback: each migration ships rollback.sql; application rollback is a git
  revert of the phase commit(s). Golden fixture regeneration is a deliberate
  act (delete fixture + rerun test).

## Verification snapshot (filled at sprint close)

- Tests: 670 passing / 57 files (incl. golden LCP regression, concurrency,
  storage compensation, security headers, economics determinism, vocational
  provenance, economist assumption tests); `npx tsc --noEmit` clean;
  `npm run build` clean; migrations applied through
  20260727170000_pilot_hardening_p2 (all additive, each with rollback.sql).
- Manual checks still required before first real matter: PDF converter
  (LibreOffice) present on prod host; S3 + KMS configured; OCR BAA ack;
  LLM_PROVIDER configured or assistant disabled; Neon tier upgraded.
