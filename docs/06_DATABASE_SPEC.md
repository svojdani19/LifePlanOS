# LifePlanOS — Data Model

Source of truth: `prisma/schema.prisma`. All tables live in the isolated
`lifeplanos` Postgres schema. Every tenant-owned row carries `firmId`; the
**Case** is the root aggregate for all clinical data.

## Tenancy & identity

| Model | Purpose |
|---|---|
| `Firm` | tenant root; branding/letterhead; relations to everything |
| `Subscription` | plan tier/status, seats, Stripe linkage, overrides |
| `User` | role (`UserRole`), status, password hash, TOTP MFA, invite flow |
| `Session` | sha-256 token hash, absolute + idle expiry, UA/IP |
| `LoginAttempt` | login throttling/audit trail |
| `UsageRecord` | metered usage (`CASE_CREATED`, `RECORD_PAGE_OCR`, `AI_GENERATION`, `REPORT_EXPORT`, `SEAT_ACTIVE`) |
| `AuditLog` | actor, action, target type/id, caseId, ip/UA, meta JSON |

## Case aggregate

| Model | Purpose | Notes |
|---|---|---|
| `Case` | intake (demographics, incident, diagnoses, ICD-10, pre-existing, work status, specialties) + economic assumptions (life expectancy, discount, inflation, geographic factor) + `CaseStatus` stage | `additionalDiagnoses`/`additionalSpecialties` are JSON |
| `Document` | uploaded record: type (60+ `DocumentType`s), OCR confidence, `storageKey`, `extractedText`, provider/date/facility metadata, `providers`/`locations` JSON, classification provenance | PHI-heavy; access via authed stream only |
| `ChronologyEvent` | dated clinical event: provider, facility, recordType, labeled sections (subjective, objectiveFindings, imagingFindings, diagnosis, treatment, procedure, disposition), functional status, clinicalSignificance, source doc + page, `eventDateEnd` for ranges | derived; rebuilt on generate |
| `Condition` | causation item: relatedness, confidence, objectiveEvidence, `evidenceSources` JSON `[{documentId, filename, page, quote}]`, reasoning, `socAnalysis` JSON | derived; rebuilt on generate |
| `SocUserInput` | reviewer notes/sources for the SoC analysis; **keyed by condition NAME** so it survives regeneration | user-authored; never wiped |
| `FutureCareItem` | recommendation: category (30+ `CareCategory`s), service, rationale, specialty, `cptCode`, probability, confidence, frequency/duration/lifetime, unit→annual→lifetime→PV costs + low/high, `pricingSource`, evidence fields, `citation` JSON, physician review fields (`physicianStatus`, note, summary) | derived, except physician fields |
| `ReviewFinding` | defense/completeness critique points with counters | derived |
| `ValidationFinding` | **persisted integrity-check results**: service, result, issue, severity, suggestion, exportBlocking | derived; replaced atomically by `persistCaseValidation()` |
| `ReportExport` | versioned export: format, template, version int, storageKey, totals, generatedBy | append-only history |
| `PrecedentPlan` | firm precedent library (de-identified prior LCPs) for likeness matching | firm-scoped, no PHI expected |

## Derived vs. user-authored

`generatePlan()` **wipes and rebuilds** the derived rows (ChronologyEvent,
Condition, FutureCareItem, ReviewFinding) and refreshes ValidationFinding.
User-authored data must survive: `SocUserInput` does (name-keyed);
physician-review state on items currently does **not** (known limitation —
lifecycle work will supersede rather than delete reviewed items).

## Conventions

- ids: uuid strings; timestamps `createdAt`/`updatedAt`.
- JSON columns hold display-shaped, non-relational payloads only; anything the
  product must query/join belongs in a real column or join table.
- Item↔finding linkage is by denormalized `service` name (items are recreated
  on regenerate, so FKs to them would cascade away history).

## Migration discipline

Additive migrations via the established pattern:
`npx prisma db push --skip-generate` → `npx prisma generate` → hand-author
`prisma/migrations/<timestamp>_<name>/migration.sql` (no schema prefix; the
connection's search_path targets `lifeplanos`) → `npx prisma migrate resolve
--applied <name>`. Document every schema change here and in CHANGELOG.md.

### Change log (schema)

- **2026-07-12** `ValidationFinding` added (+ back-relations on Firm/Case) —
  persisted integrity findings.
- **2026-07-11** `ChronologyEvent` + `eventDateEnd`, `facility`, `subjective`,
  `procedure`, `disposition`; `Condition` + `evidenceSources`, `socAnalysis`;
  `SocUserInput` added.

## Proposed schema — recommendation lineage (P2.R1, not yet implemented)

Additive fields/models satisfying the formal requirement in
[14_ROADMAP.md § P2.R1](14_ROADMAP.md). Nothing existing changes shape.

```prisma
// FutureCareItem — additive columns
//   lineageId      String   @default(uuid())  // constant across versions
//   version        Int      @default(1)
//   supersededById String?                    // forward pointer; null = current
//   supersededAt   DateTime?
//   lifecycleStatus RecStatus @default(AI_DRAFT) // 12-state model (see 00 §12)

model RecommendationTransition {
  id         String   @id @default(uuid())
  caseId     String
  firmId     String
  lineageId  String   // stable across versions
  itemId     String   // the version this transition was recorded against
  userId     String
  role       String
  priorStatus String
  newStatus   String
  comment     String?
  modifiedFields Json? // field names; drives material/nonmaterial logic
  materialChange Boolean @default(false)
  caseVersion Int?     // populated once CaseSnapshot (P3) exists
  createdAt  DateTime @default(now())

  @@index([caseId]); @@index([lineageId])
}
```

Rules encoded in code (unit-tested, per P2.R1 §3): material fields =
`service, category, conditionId, cptCode, probability, frequencyPerYear,
durationYears, isLifetime, unitCost, pricingSource`. Nonmaterial =
`rationale, physicianSummary` wording. Only the current version of a lineage
(`supersededById = null`) is eligible for totals. Regeneration matches
lineages by service identity; unreviewed AI drafts may still be
replaced-in-place.
