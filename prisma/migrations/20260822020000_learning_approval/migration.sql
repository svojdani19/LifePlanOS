-- Human approval for learned lessons.
--
-- evaluateCandidate() wrote status ADOPTED the moment judgeCandidate() said the
-- held-out metrics improved, and retrieveGuidance() serves ADOPTED rows into
-- live prompts. So a lesson began shaping output with no person in the loop,
-- and a lesson that changes how care is recommended was adopted on exactly the
-- same footing as one that changes which field leads a summary.
--
-- Passing evaluation now earns APPROVAL_PENDING: the right to be considered.
-- Adoption is a human act, and which human depends on the class:
--   STYLE    — presentation and structure; a firm administrator may approve.
--   CLINICAL — changes what the program asserts about care; requires a verified
--              PHYSICIAN credential, the same gate that guards attestation.
--
-- approvalClass is frozen on the row rather than derived at read time, so a
-- later change to the mechanism cannot silently reclassify a pending approval
-- into the weaker gate.
--
-- Backfill is deliberately strict. Existing ADOPTED rows were adopted with no
-- approver, and this migration will not invent one. They are defaulted to
-- CLINICAL, which is the stricter class, and any row that is still ADOPTED is
-- returned to APPROVAL_PENDING so a human confirms what the machine adopted.
-- That is a behaviour change and it is the point of the migration: guidance
-- nobody approved stops being served until somebody approves it.
--
-- Reversible:
--   UPDATE "LearningCandidate" SET "status" = 'ADOPTED' WHERE "status" = 'APPROVAL_PENDING';
--   ALTER TABLE "LearningCandidate"
--     DROP COLUMN "approvalClass", DROP COLUMN "approvedById", DROP COLUMN "approvedAt",
--     DROP COLUMN "approverCredential", DROP COLUMN "approvalNote",
--     DROP COLUMN "rejectedById", DROP COLUMN "rejectedAt", DROP COLUMN "rejectionReason";
ALTER TABLE "LearningCandidate"
  ADD COLUMN IF NOT EXISTS "approvalClass"      TEXT NOT NULL DEFAULT 'CLINICAL',
  ADD COLUMN IF NOT EXISTS "approvedById"       TEXT,
  ADD COLUMN IF NOT EXISTS "approvedAt"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "approverCredential" TEXT,
  ADD COLUMN IF NOT EXISTS "approvalNote"       TEXT,
  ADD COLUMN IF NOT EXISTS "rejectedById"       TEXT,
  ADD COLUMN IF NOT EXISTS "rejectedAt"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rejectionReason"    TEXT;

-- Return machine-adopted lessons to the queue. adoptedAt is cleared with them:
-- it recorded an adoption that no longer stands.
UPDATE "LearningCandidate"
   SET "status" = 'APPROVAL_PENDING', "adoptedAt" = NULL
 WHERE "status" = 'ADOPTED' AND "approvedById" IS NULL;

UPDATE "LearningFinding"
   SET "state" = 'EVALUATED'
 WHERE "state" = 'ADOPTED'
   AND "candidateId" IN (SELECT "id" FROM "LearningCandidate" WHERE "status" = 'APPROVAL_PENDING');

CREATE INDEX IF NOT EXISTS "LearningCandidate_firmId_approvalClass_status_idx"
  ON "LearningCandidate"("firmId", "approvalClass", "status");
