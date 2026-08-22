# Rollout — safeguard corrections (2026-08-22)

Applies the schema and data changes behind the recorded-basis, retrieval-status,
learning-approval and basis-reconciliation safeguards.

**Nothing in this document has been run against a live database.** The
procedure and its script are checked in so they can be reviewed on their own,
and they have been exercised only against the disposable Postgres that CI
creates for each run.

## What is being deployed

| Migration | Adds |
|---|---|
| `20260822010000_retrieval_attempt` | `RetrievalAttempt` |
| `20260822020000_learning_approval` | `LearningCandidate` approval columns **+ a backfill** |
| `20260822030000_basis_specification_and_assessment` | `RecommendationBasis.specification`, `.assessmentBasis` |
| `20260822040000_basis_reconciliation` | `BasisReconciliation` |

## Why the backfill needs its own step

The live database is managed with `prisma db push`, not `migrate deploy`. Its
`_prisma_migrations` table holds a partial history (21 of 66 rows), so a deploy
would try to replay migrations whose objects already exist.

`db push` reconciles the **schema** and runs **no DML**. Three of the four
migrations above are pure DDL and are fully covered by a push. The
learning-approval migration is not: it carries an `UPDATE` that returns
machine-adopted lessons to the approval queue.

That `UPDATE` is the substance of the change. `evaluateCandidate` used to write
`status = 'ADOPTED'` the moment held-out metrics improved, and `retrieveGuidance`
serves `ADOPTED` rows into live prompts. Rows adopted that way have no approver.
If the push runs and the backfill does not, those lessons keep shaping every
future case with nobody having approved them — the exact defect the approval
gate was added to close, surviving the change meant to close it.

## Steps

Run from the repository root, with `DATABASE_URL` and `DIRECT_URL` set in the
environment for the target database. Do not paste a connection string on the
command line; the script prints the host only, never credentials.

**1 — Back up first.** Take a Neon branch or a `pg_dump`. Step 3 changes rows.

**2 — Push the schema.** DDL only; no rows change.

```bash
npm run prisma:generate && npx prisma db push
```

**3 — Preflight.** Verifies every required object exists and reports the counts.
Changes nothing. Read the numbers before continuing.

```bash
npm run rollout:check
```

Expected output: a schema-check pass, then four counts — machine-adopted lessons
(the ones that will move), human-approved lessons (which must not change),
lessons already awaiting approval, and findings that will follow their
candidate. It exits `2` if the schema is not ready.

**4 — Apply.** One transaction. Only rows where `approvedById IS NULL` are
touched, and that predicate is in the SQL rather than in application code.

```bash
npm run rollout:apply
```

It re-surveys afterwards and warns if any machine-adopted lesson remains or if
the human-approved count moved. It exits `3` if the first of those happens.

**5 — Regenerate affected plans.** Bases recorded before
`20260822030000` have no `specification` or `assessmentBasis`, so they will read
`BASIS_STALE` and block final export until the plan is regenerated. That is the
intended behaviour and not a fault: a basis that cannot be reconstructed
faithfully must fail its own freshness check. Regenerate per case through the
normal flow.

**6 — Verify.** Re-run `npm run rollout:check`; it should report nothing to
backfill. Confirm `/settings/learning` lists the returned lessons as awaiting
approval and that previously human-approved lessons still read adopted with
their approver.

## Re-running

Every step is idempotent. `rollout:check` never writes. `rollout:apply` on a
database with nothing to backfill reports "Nothing to backfill" and makes no
changes, and running it twice is indistinguishable from running it once — CI
asserts this on every build.

## Rollback

**Step 3 (the backfill).** Restore from the step-1 backup. There is deliberately
no automatic inverse: re-adopting the returned lessons would mean re-adopting
them with no approver, which is the state being corrected. If they should be
adopted, approve them through `/settings/learning` — that records who did it.

**Step 2 (the schema).** All four migrations are additive. To reverse:

```sql
DROP TABLE "BasisReconciliation";
DROP TABLE "RetrievalAttempt";
ALTER TABLE "RecommendationBasis" DROP COLUMN "specification", DROP COLUMN "assessmentBasis";
ALTER TABLE "LearningCandidate"
  DROP COLUMN "approvalClass", DROP COLUMN "approvedById", DROP COLUMN "approvedAt",
  DROP COLUMN "approverCredential", DROP COLUMN "approvalNote",
  DROP COLUMN "rejectedById", DROP COLUMN "rejectedAt", DROP COLUMN "rejectionReason";
```

Dropping the approval columns discards the record of who approved what. Restore
from backup instead unless that loss is intended.

**Application code.** Reverting the code without reverting the schema is safe:
the added columns are nullable and the added tables are only read by the code
that writes them.

## What will look different afterwards

- Recommendations whose basis predates the rollout report `BASIS_STALE` and
  cannot be finally exported until regenerated.
- A recorded-basis divergence can no longer be resolved-as-is or ignored. It
  closes by regeneration or by a credentialed physician's reconciliation.
- Machine-adopted lessons stop being served into prompts until a person adopts
  them.
- The report prints guideline sources as context rather than as applied
  evidence unless verified, item-specific guidance is recorded for the item.
