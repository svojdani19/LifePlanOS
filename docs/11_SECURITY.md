# LifePlanOS — Security & PHI

LifePlanOS processes protected health information (medical records) for
litigation support. Treat every `Document`, `ChronologyEvent`, `Condition`,
`FutureCareItem`, and report artifact as PHI.

## Tenant isolation

- One firm = one tenant. Every tenant-owned row carries `firmId`.
- **The only sanctioned identity path** is `src/lib/tenant.ts`:
  `requireApiContext()` (session → user → firm) and `requireCase(ctx, caseId)`
  (firm-scoped fetch; cross-tenant = 404). Client-sent firmIds are never
  trusted.
- Conformance test: `src/lib/security/tenantIsolation.test.ts` fails the build
  if any route under `/api/cases/[caseId]/` omits the guard pair, and
  behaviorally verifies cross-firm denial.
- The DB lives in an isolated `lifeplanos` Postgres schema.

## Authentication & sessions

- Opaque 32-byte session token in an httpOnly cookie; only its SHA-256 hash is
  stored (`Session.tokenHash`) — a DB leak cannot be replayed.
- 14-day absolute TTL + 30-minute idle timeout (configurable via
  `SESSION_IDLE_MINUTES`); lastSeen refresh throttled.
- TOTP MFA with hashed backup codes; login attempts recorded (`LoginAttempt`).
- Invite flow: tokenized, expiring invites; suspended users are dead on arrival
  at the guard.

## Files & storage

- Uploads and report artifacts go through `lib/storage.ts`: S3 with server-side
  encryption (SSE-KMS when `S3_KMS_KEY_ID` is set, else AES256) in production;
  local gitignored `uploads/` in dev. Keys are opaque UUIDs.
- **PHI files are never served statically.** Reads stream through
  authenticated, audited routes (`documents/[docId]/view`,
  `export/[exportId]/download`) that pass the tenant guard first.
- Upload validation happens at the ingestion route (type/extension screening).

## Audit

- Every mutating route writes `AuditLog` (firmId, userId, action, target
  type/id, caseId, ip, user-agent, small meta JSON).
- Usage metering (`UsageRecord`) tracks billable events per period.

## Logging rules (hard)

Never log: full medical-record content, extracted text, API keys, tokens,
passwords, or unnecessary PHI. `AuditLog.meta` must stay small and structural
(ids, counts, statuses) — never record excerpts.

## Secrets & configuration

- All secrets via environment (`.env`, gitignored; `.env.example` has
  placeholders only). Verified no secrets in the repo before publishing.
- Stripe webhook secret, DB URLs, S3 credentials, literature API keys are
  env-only. Mock modes exist for billing and LLM so dev needs no keys.

## Data deletion

- `Firm` and `Case` cascade-delete their children (Prisma `onDelete: Cascade`),
  so tenant/case removal removes clinical rows. Object-storage artifacts are
  keyed but not yet garbage-collected on delete — **known gap** (roadmap):
  deleting a case should also delete its stored objects.

## Known gaps / follow-ups

1. Object-storage GC on case/firm deletion (above).
2. Rate limiting on auth endpoints beyond `LoginAttempt` bookkeeping.
3. Signed, expiring URLs are not used (streaming-only today) — acceptable, but
   revisit if a CDN is introduced.
4. Retention policy configuration (per-firm) not yet implemented.
5. `Document.extractedText` keeps full record text in Postgres (encrypted at
   rest by the host); revisit for field-level encryption if required by
   enterprise customers.
