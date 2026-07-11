-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mfaBackupCodes" JSONB,
ADD COLUMN     "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totpSecret" TEXT;
