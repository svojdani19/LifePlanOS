-- Explicit treatment-series membership: date, document and page per member.
ALTER TABLE "ChronologyEvent" ADD COLUMN "seriesMembers" JSONB;
