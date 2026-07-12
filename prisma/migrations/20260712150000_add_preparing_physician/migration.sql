-- EPIC-011 follow-up: the physician deemed to be preparing/authoring the report.
ALTER TABLE "Case" ADD COLUMN "preparingPhysicianId" TEXT;
ALTER TABLE "Case" ADD CONSTRAINT "Case_preparingPhysicianId_fkey" FOREIGN KEY ("preparingPhysicianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
