# LifePlanOS — AI Pipeline

**The clinical pipeline is deterministic**: rules + retrieval. There is no
generative model in the clinical path. `src/lib/llm/` provides a provider
abstraction with a deterministic mock; any future LLM use must go through it
and must obey the fabrication rules below.

## Hard rules

1. **Never fabricate** — citations, quotes, CPT/HCPCS codes, providers,
   findings, or dates. Everything cited must exist in the ingested records or a
   real retrieved source.
2. **Never render a medical opinion.** The pipeline organizes and validates;
   opinions belong to the human expert.
3. **Never auto-approve.** `physicianStatus` transitions only via the physician
   review route.
4. **Disclose weakness honestly** — offline literature, thin records, garbled
   OCR, missing evidence are stated, not papered over.
5. **Deterministic** — no randomness or wall-clock in engine logic; identical
   inputs give identical outputs (tested).

## Stages (orchestrated by `engine/generate.ts` → `generatePlan(caseId)`)

1. **Ingestion** (`documents/ingest.ts`, upload route)
   - text extraction; OCR fallback for scans (`documents/ocr.ts`: pdfjs render
     @200 DPI, white-bg flatten, tesseract WASM, PSM-6 retry on low confidence;
     per-page "Page N of M" stamps for downstream page citations)
   - classification by content (`classify.ts`), metadata extraction (`meta.ts`:
     providers with credentials/roles/pages, service dates/ranges, facilities)
2. **Conditions (causation map)** — primary + additional diagnoses + specialty-
   pack conditions (injury-related only); each gets page-cited
   `evidenceSources` via `engine/evidence.ts` (verbatim quotes located with
   distinctive-term matching).
3. **Future care** — diagnosis-driven templates (`careLibrary.ts`
   `CONDITION_CARE` + `BASELINE_CARE`; fallback `specialty.ts` packs), de-duped;
   **each item mapped to its region-matched condition** via
   `integrity.mapRecommendationToCondition` (never blindly the primary).
4. **Chronology** (`chronology.ts`) — record-driven timeline; consolidated
   charts segmented per encounter (own provider/recordType); relevance gating;
   LCP-format labeled sections; falls back to a specialty template only when no
   relevant records exist.
5. **Costs** (`cost.ts`) — unit×geo → annual → year-by-year inflation →
   discounted PV; low/expected/high bands; category pricing references with
   bundled-estimate disclosure for non-coded categories.
6. **Reviews** — defense/completeness critique points (`ReviewFinding`).
7. **Guideline retrieval** (`standardOfCare.ts`, formerly the Standard-of-Care
   module) — now an INTERNAL service that locates real clinical
   practice guidelines (concept-mapped queries widen ICD phrasing), quotes
   pertinent language **verbatim**, maps documented care against it, and builds
   a deposition-style rationale. *Report note:* the ordinary LCP renders this as
   "Clinical Basis and Future-Care Relevance" without met/departed verdicts.
8. **Citations** (`enrichCitations`) — real articles per item from the
   literature layer.
9. **Validation** (`engine/validation.ts`) — runs the integrity check and
   persists `ValidationFinding` rows (also refreshed on physician review and
   export; on-demand via `/api/cases/:id/validation`).

## Literature layer (`src/lib/literature/`)

- Sources queried in parallel: Europe PMC, Crossref, Semantic Scholar (with
  key); merged and de-duplicated into one candidate pool; a failing source
  contributes nothing (best-effort). `literatureReachable()` probes
  connectivity so offline runs degrade honestly.
- **Medical Necessity & Clinical Evidence engine (`medicalNecessity.ts`, Refactor
  Sprint)**: synthesizes, per future-care recommendation, one physician-quality
  dossier — medical-necessity narrative, structured probability (+%), potential
  challenges, organized & source-traceable supporting evidence, contradictory
  evidence, unknowns, gated literature, and structured confidence. Pure; shared
  by the report (server) and the Future Care panel (client). REPLACES the
  standalone Standard-of-Care view; the former SoC engine
  (`standardOfCare.ts`) is retained as an internal guideline-retrieval service
  that populates `Condition.socAnalysis`, which the dossier consumes.
- **Citation quality (`citationQuality.ts`, Clinical Evidence Sprint)**: a hard
  compatibility gate + explicit relevance score + 10-tier hierarchy + structured
  confidence, enforced at selection time in `enrichCitations` and the SoC
  selector, and re-checked by the validation service. See 09_CLINICAL_RULES §4.
- Legacy relevance gate (in `integrity.ts`): `evaluateCitation` scores diagnosis/
  region match (required), intervention match, outcome signal, evidence tier
  (guideline > SR/MA > cohort/registry > RCT > review > case series > case
  report), population match (pediatric/congenital rejected for adult injury),
  threshold ≥ 50. `filterCitations` orders survivors best-evidence-first.
- SoC guidance uses concept vocabulary (`guidanceTerms`) so ICD-phrased
  diagnoses match guidelines written in standard terminology.

## Validation layer (`engine/integrity.ts` — pure, unit-tested)

- **Body-region mapping** for recommendations vs. documented diagnoses.
- **CPT/HCPCS validation** against a curated code table (region + modality +
  injection-approach conflicts; bundled no-code services validated when
  disclosed).
- **Pricing validation** (modality/region mismatches; undisclosed bundled
  estimates).
- **Inclusion gating** (`classifyRecommendation`): an item enters totals only
  if region-matched, free of critical coding defects, and physician-approved
  OR record-supported + medically probable.
- **Honest labels** (`reviewLabel`): never "physician approved" without an
  approval action.
- **Functional findings** (`functionalFinding`): specific documented findings
  (e.g. "rolling walker") carried into the report's functional assessment.
- `runIntegrityCheck` grades findings Critical/High/Moderate/Low;
  critical ⇒ export-blocking (report renders DRAFT).

## Failure modes

| Failure | Behavior |
|---|---|
| Literature APIs unreachable | analysis states lookup unavailable; nothing invented |
| OCR low confidence | flagged on the document; garbled lines never surface as findings |
| No guideline for a diagnosis | honest "no indexed guideline located; add a source" |
| Critical validation finding | item excluded from totals; export watermarked DRAFT |
| Pipeline interrupted | chronology rebuilds are transactional (never a half-empty timeline) |
