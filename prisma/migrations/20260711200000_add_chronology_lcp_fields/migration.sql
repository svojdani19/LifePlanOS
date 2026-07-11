-- AlterTable
ALTER TABLE "ChronologyEvent" ADD COLUMN     "eventDateEnd" TIMESTAMP(3),
ADD COLUMN     "facility" TEXT,
ADD COLUMN     "subjective" TEXT,
ADD COLUMN     "procedure" TEXT,
ADD COLUMN     "disposition" TEXT;
