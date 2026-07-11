-- CreateTable
CREATE TABLE "SocUserInput" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "conditionName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "title" TEXT,
    "url" TEXT,
    "filename" TEXT,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SocUserInput_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "SocUserInput_caseId_conditionName_idx" ON "SocUserInput"("caseId", "conditionName");
-- AddForeignKey
ALTER TABLE "SocUserInput" ADD CONSTRAINT "SocUserInput_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
