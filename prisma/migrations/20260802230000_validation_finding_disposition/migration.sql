-- User dispositions on integrity findings (additive).
ALTER TABLE "ValidationFinding" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'OPEN';
ALTER TABLE "ValidationFinding" ADD COLUMN IF NOT EXISTS "resolvedById" TEXT;
ALTER TABLE "ValidationFinding" ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3);
