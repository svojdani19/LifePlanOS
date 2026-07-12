# Architecture and Code Findings

## Repository structure

The archive contains two apparent copies of the application: a repository at the ZIP root and a more complete nested `LifePlanOS/` directory. The nested directory contains the newer Priority 2–4 work, including:

- `src/lib/engine/evidenceGraph.ts`
- `src/lib/engine/lifecycle.ts`
- `src/lib/engine/snapshot.ts`
- `src/lib/engine/validation.ts`
- `src/lib/security/tenantIsolation.test.ts`
- the canonical numbered documentation set.

This should be cleaned in future review archives so there is one authoritative repository root.

## Technology stack

- Next.js 14 / React 18
- TypeScript
- Prisma / PostgreSQL
- DOCX report generation
- Multi-source literature retrieval
- S3-compatible object storage
- Stripe integration
- Vitest

## Strengths

1. **Structured domain entities exist.** Conditions, future-care items, evidence links, review findings, validation findings, transitions, snapshots, and exports are modeled rather than stored only as report prose.
2. **Recommendation history is preserved.** The lifecycle implementation supersedes reviewed recommendations instead of deleting them.
3. **Evidence graph is materialized.** `EvidenceLink` rows provide a queryable provenance layer.
4. **Validation is persisted.** Findings survive beyond a single request and can block export.
5. **Security testing is improving.** Cross-tenant access tests are present.
6. **Documentation is now coherent.** The numbered documentation structure is filled and includes decisions, roadmap, standards, and changelog.

## Risks and recommendations

### A. Evidence links lack a durable source entity

Literature and guidelines are stored primarily as JSON metadata on `FutureCareItem`, `Condition.socAnalysis`, and `EvidenceLink.meta`. `toId` is null for citation and guideline links.

This limits:

- global deduplication;
- source-version tracking;
- retraction and correction handling;
- source-use analytics;
- quality reassessment;
- case-level duplicate detection;
- firm-approved source libraries.

**Recommendation:** introduce canonical `EvidenceSource` and `EvidenceAssessment` models. Evidence links should reference stable source IDs.

### B. Evidence graph rebuild deletes and recreates links

This is acceptable for derived links, but user-reviewed evidence assessments must not be deleted on rebuild.

**Recommendation:** separate engine-derived links from user-reviewed/locked evidence relationships.

### C. Generated Prisma binaries are committed

The archive contains a Darwin ARM64 Prisma query engine in `src/generated/prisma`. In the Linux audit environment, 157 tests passed but three unhandled initialization errors occurred because the generated client could not locate a Linux engine.

**Recommendation:** generate Prisma during install/build or configure CI generation correctly. Do not depend on a platform-specific committed binary.

### D. `next lint` is deprecated in newer Next.js workflows

The current script uses `next lint`. Adopt direct ESLint configuration before framework upgrades.

### E. Evidence generation is synchronous and network-dependent

Literature enrichment and Standard of Care retrieval can be slow and variable.

**Recommendation:** move literature research into resumable background jobs with visible status, retries, provenance, and failure handling.

## Test run

Command attempted:

```bash
npm ci --ignore-scripts
npm run test
```

Result:

- 19 test files passed
- 157 tests passed
- 3 unhandled Prisma Client initialization errors caused by the archive's Darwin-generated Prisma client in a Linux environment

The errors do not indicate failed assertions, but they must be fixed to produce a clean portable test run.
