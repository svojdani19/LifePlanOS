# LifePlanOS — Architecture

Single **Next.js 14 App Router** application (TypeScript strict, React 18,
Tailwind). One deployable; no microservices. Port 3100 in development.

```
src/
  app/
    (app)/            authenticated pages (dashboard, cases/[caseId], team,
                      settings, billing, account) — server components that load
                      tenant-scoped data and render client panels
    api/**/route.ts   REST route handlers (~30). Uniform shape:
                      requireApiContext → requirePermission → requireCase →
                      work → audit → ok()/handleError()
    login/, signup/, accept-invite/
  components/
    case/CaseWorkspace.tsx   the case UI: one client component with tabbed
                             panels (overview, records, chronology, causation,
                             soc, futurecare, costs, reviews, physician,
                             precedents, report)
    ui/                      small shared primitives (Badge, …)
  lib/
    tenant.ts         THE tenancy seam: session → {user, firm, subscription},
                      RBAC, firm-scoped case fetch, audit + usage writes
    rbac.ts           flat role→permission matrix
    auth/             opaque hashed session cookie, TOTP MFA, invites
    db.ts             Prisma client singleton
    storage.ts        object storage: S3 (SSE-KMS/AES256) or local uploads/ dev
    api.ts            ok()/handleError() response helpers
    documents/        ingestion: extract → OCR (pdfjs + tesseract) → classify →
                      metadata (providers/dates/facilities) → record summaries
    engine/           deterministic clinical pipeline (see AI_PIPELINE.md):
                      generate.ts (orchestrator), chronology.ts, evidence.ts,
                      careLibrary.ts, specialty.ts, cost.ts, standardOfCare.ts,
                      integrity.ts (pure validators), validation.ts (persisted
                      findings service), confidence.ts
    literature/       Europe PMC + Crossref (+ Semantic Scholar) merged search
    export/report.ts  DOCX Life Care Plan + CSV (see REPORT_ENGINE.md)
    llm/              provider abstraction; deterministic mock today
    intake/, icd10/, precedents/, stripe/, subscription/
  generated/prisma/   generated client (gitignored)
prisma/
  schema.prisma       all models; isolated `lifeplanos` Postgres schema
  migrations/         hand-authored, timestamped; applied via db push +
                      `prisma migrate resolve --applied <name>` (no shadow DB)
docs/                 this documentation set
```

## Key patterns

- **Tenant guard everywhere.** No route touches tenant data except through
  `requireApiContext()` + `requireCase()`. Conformance is unit-tested.
- **Deterministic engines.** No network/clock/randomness inside engine logic;
  literature retrieval is the only network stage and is best-effort.
- **Derived data is replaceable.** Chronology, conditions, care items, review
  findings, and validation findings are recomputed by `generatePlan()`;
  user-authored data (SoC inputs, physician notes) must survive regeneration
  (SoC inputs are name-keyed for this reason).
- **PHI flows through authenticated streams** (`documents/[docId]/view`,
  `export/[exportId]/download`); storage keys are opaque UUIDs.
- **Validation is additive**: `engine/integrity.ts` is pure and unit-testable;
  `engine/validation.ts` loads case data, runs it, and persists
  `ValidationFinding` rows (refreshed on generate / physician review / export;
  on-demand via `GET|POST /api/cases/:id/validation`).

## Dev environment quirks

- Prisma client is generated to `src/generated/prisma` (import via
  `@/generated/prisma`).
- Repeated large-file edits can corrupt the Next dev cache; fix is
  `rm -rf .next` + restart (never commit workarounds for this).
- OCR worker cache lives in `.ocr-cache/` (gitignored).
