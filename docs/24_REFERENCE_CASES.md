# Reference Cases — feeding real cases and finalized reports into LifePlanOS

The platform learns from real, professionally completed work. A *reference
case* is a real matter whose source records AND finalized professional report
are fed through the pipeline; the gap between what the engine produced and
what the professional finalized becomes training signal (learned priors) and
regression ground truth (gold fixtures).

## The loop

1. **Prepare a folder** per case:
   ```
   my-case/
     meta.json                 # optional: caseNumber, side, caseType, dateOfBirth, sex, primaryDiagnosis, icd10Code
     records/                  # the real source records (PDF/DOCX/TXT)
       01-er-visit.pdf
       02-mri-lumbar.pdf
       ...
     final-report.pdf          # the professionally finalized LCP/MCP, if available
   ```
2. **Ingest and run**:
   ```bash
   npx tsx scripts/reference-case.ts "Client Name" /path/to/my-case
   ```
   Records go through the real extraction/classification/segmentation path
   (identical to a UI upload). The finalized report is attached as a clearly
   labeled `EXPERT_REPORT` reference document — never mined as case records.
3. **Human review in the app** — approve suggested diagnoses on the Intake
   tab, then complete physician review, using the finalized report as the
   answer key (approve/modify/reject each item with the structured
   correction-reason codes; the before→after values are the learning signal).
4. **Capture as gold**:
   ```bash
   npx tsx scripts/gold-capture.ts <caseId> "client-name-v1"
   ```
   The physician-reviewed plan becomes the expected answer: approved/modified
   items with their corrected values, rejected items as expected exclusions,
   PV totals with tolerance.
5. **Score and learn**:
   ```bash
   npx tsx scripts/gold-harness.ts          # precision/recall/F1 + parameter accuracy per gold case
   npx tsx scripts/learn.ts                 # fold corrections into firm-scoped learned priors
   npx tsx scripts/clinical-validation.ts   # persist the scorecard (ValidationRun ledger)
   ```
   Learned priors adjust future drafts (median of ≥3 consistent corrections,
   always disclosed on the item, always still physician-reviewable). The gold
   harness shows whether each engine version moves closer to professional
   output.

## Rules that keep this honest

- PHI: reference cases are real records — only load them into a firm/database
  covered by the appropriate agreements. Use `FIRM_ID` to target a dedicated
  reference firm if needed.
- The finalized report is *reference truth*, never input: nothing from it is
  auto-extracted into diagnoses or care items. Humans transcribe its
  conclusions through the normal review workflow, which preserves attribution.
- Gold capture refuses to fabricate: a case with no physician review captures
  a loudly-labeled vacuous fixture.
- Deleting a reference case later does not remove its GoldCase fixture or the
  learned priors derived from it (both are aggregates, not PHI copies —
  fixtures store service names/values only).

## Current corpus

| Gold case | Source | Status |
|---|---|---|
| fredrika-j-glazer-v1 | F.J. finalized LCP (Dr. Glazer) | vacuous — awaiting source re-upload + review replay |
