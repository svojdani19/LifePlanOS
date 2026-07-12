# Prioritized Remediation Plan

## P0 — Clinical evidence correctness

1. Create canonical `EvidenceSource` records.
2. Create per-claim `EvidenceAssessment` records.
3. Add hard applicability gates for diagnosis, anatomy, population, intervention, and outcome.
4. Prevent clinically unjustified source reuse across diagnoses and recommendations.
5. Add evidence hierarchy and source-authority ranking.
6. Add current-version and supersession checks for guidelines.
7. Add explicit contradictory-literature retrieval.
8. Add structured unknown/gap generation.
9. Require human approval of every Standard of Care source before final export.
10. Block final export when a major claim lacks an approved applicable source.

## P1 — Evidence Explorer expansion

1. Display evidence level and source type.
2. Display clinical question supported.
3. Display applicability matrix.
4. Display why the source was selected.
5. Display limitations and population mismatches.
6. Display contradictory patient facts and contradictory literature separately.
7. Display missing evidence by category.
8. Warn when the same source supports multiple unrelated entities.
9. Allow reviewer approve/reject/replace source.
10. Preserve evidence review history across graph rebuilds.

## P1 — Standard of Care precision

1. Separate guideline discovery from patient-specific applicability.
2. Extract discrete recommendations, not just quotes.
3. Require recommendation strength and certainty when available.
4. Map patient evidence to each discrete recommendation with explicit status.
5. Do not infer guideline concordance from generic token overlap.
6. Prefer primary publisher sources.
7. Avoid breach-style wording in standard LCP mode.

## P2 — Engineering and operations

1. Remove duplicate repository root from archives.
2. Stop committing platform-specific Prisma engine binaries or regenerate in CI.
3. Add background jobs for literature and evidence enrichment.
4. Add telemetry for retrieval quality and source rejection reasons.
5. Add regression fixtures covering previously irrelevant citations.

## Suggested acceptance metric

For a curated test set of at least 100 diagnosis/recommendation clinical questions:

- ≥95% of displayed sources judged clinically relevant by a physician reviewer
- 100% of guideline citations resolve to a real source
- 100% of quoted language is verifiable in the source
- 0 instances of a source reused across unrelated diagnoses without explicit reviewer justification
- 100% of major recommendations show both supporting evidence and a meaningful weakness/unknown review
