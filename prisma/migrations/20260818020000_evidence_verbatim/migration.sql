-- Distinguish the record's own words from the extraction's prose about it.
--
-- Chronology narrative fields (objectiveFindings, functionalStatus, procedure…)
-- are what the extraction WROTE about an encounter; a claim excerpt is what the
-- clinician wrote. Both are legitimate evidence and only one may be quoted in a
-- report as the chart's language, so the distinction is recorded rather than
-- inferred at display time.
--
-- Defaults to false: every row written before this column existed carried text
-- of unknown provenance, and "not established as verbatim" is the honest value.
ALTER TABLE "RecommendationEvidence"
  ADD COLUMN IF NOT EXISTS "verbatim" BOOLEAN NOT NULL DEFAULT false;
