# 12 — Deployment

## Runtime

Single Next.js 14 application (Node). Dev server on port 3100
(`.claude/launch.json` config "lifeplanos"). No background workers — OCR runs
in-process with a small worker pool.

## Environment (see `.env.example` for the full annotated list)

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `DIRECT_URL` | Postgres (append `?schema=lifeplanos`; the app owns that isolated schema) |
| `S3_BUCKET`, `AWS_REGION`, `S3_PREFIX`, `S3_KMS_KEY_ID` | PHI object storage (SSE-KMS when key set, else AES256). **Unset bucket ⇒ local `uploads/` dev fallback — never production.** |
| `SESSION_IDLE_MINUTES` | idle timeout (default 30) |
| `SEMANTIC_SCHOLAR_API_KEY` | optional third literature source |
| `ANTHROPIC_API_KEY` | optional; LLM seam only (deterministic mock without it) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | billing (mock mode without them) |

No secrets in the repo; `.env` is gitignored.

## Database & migrations

- Prisma client generated to `src/generated/prisma` (gitignored; run
  `npx prisma generate` after schema changes).
- Migration discipline (no shadow DB): `npx prisma db push --skip-generate` →
  `npx prisma generate` → hand-author
  `prisma/migrations/<timestamp>_<name>/migration.sql` (no schema prefix) →
  `npx prisma migrate resolve --applied <name>`. Fresh environments replay the
  migrations directory normally.
- Seed: `npx prisma db seed` (idempotent demo firm; wipes/rebuilds the
  `meridian-life-care` slug only).

## Release checklist

1. `npx tsc --noEmit` clean; `npm test` green (includes tenant-isolation
   conformance).
2. Schema changes documented in [06_DATABASE_SPEC.md](06_DATABASE_SPEC.md) +
   CHANGELOG entry.
3. S3 + KMS configured; verify `storageMode() === "s3"`.
4. Stripe webhook endpoint + secret configured (or mock mode explicitly
   accepted).
5. **Gate for any paid production pilot** (decision ATD-3): object-storage GC
   on deletion and auth rate limiting must be implemented first.

## OCR configuration

Scanned records are read by the **local** Tesseract pipeline by default — fully
on-device, no PHI leaves the machine (`documents/ocr.ts`, rendered at
`OCR_DPI`=300; an A/B showed 300 DPI without preprocessing beats 200, while
binarization/contrast-stretch both regress — so `OCR_PREP` defaults to `none`).

A **medical-grade cloud provider** (AWS Textract / Google Document AI / Azure
Document Intelligence) can be switched on via `documents/ocrProvider.ts`, but it
sends PHI to a third party and therefore requires, all together:

- `OCR_PROVIDER` = `textract` | `documentai` | `azure`
- `OCR_BAA_ACK=true` — explicit operator acknowledgement that a **BAA is signed**
  with that vendor (a legal precondition for transmitting PHI)
- the provider's credentials (e.g. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
  / `AWS_REGION`) in the env
- the provider SDK added and the adapter in `cloudProvider()` implemented

If a cloud provider is selected but any of these is missing, ingestion throws a
clear setup error and **no PHI is sent** — it never silently falls back to local
or silently ships data. Tuning knobs: `OCR_DPI` (150–400), `OCR_PREP`
(`none`/`enhance`/`binarize`).

## Operational notes

- Dev-only: repeated large-file edits can corrupt `.next`; fix `rm -rf .next`
  and restart.
- OCR language/model cache in `.ocr-cache/` (safe to delete; re-downloads).
- Health probe: `GET /api/health`.
