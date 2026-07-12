# LifePlanOS — Report Engine

Source: `src/lib/export/report.ts` (`buildReportDocx`, `buildCostCsv`).
Exports are versioned (`ReportExport`), stored via `lib/storage.ts`, and
downloaded through the authenticated stream route.

## Design system (LOCKED — do not change without explicit approval)

- **Typography:** Garamond serif; body ~11.5pt; section headers 15pt bold;
  subheaders 13pt; tables 10pt.
- **Color:** near-black body (`#1A1A1A`), dark-blue headers (`#1F3864`), grey
  captions, thin `#B7BDC7` table borders, alternating row shading, navy header
  rows. No dashboards, gauges, badges, or icons.
- **Chrome:** title page (no header) → running header on every page
  (`Patient | Life Care Plan | date … Page X of Y`) + running footer
  (`CONFIDENTIAL · PREPARED IN ANTICIPATION OF LITIGATION`). Wide margins.
- **Voice:** first-person physician ("I have reviewed…", "In my opinion, to a
  reasonable degree of medical probability…"). Narrative over bullets.

## Section flow (LOCKED)

Title Page → Executive Summary → Synopsis → Purpose of Report → Qualifications
of Reviewer → Methodology → Medical Records Reviewed → Medical Chronology →
Pre-Injury History → The Incident → Post-Injury Treatment → Current Medical
Status → Functional Assessment → Treating Physician Diagnoses (with **Clinical
Basis and Future-Care Relevance**) → Future Medical Needs & Medical Necessity →
Life Care Plan (cost tables) → Cost Analysis (scenarios + sensitivity) →
Assumptions → Discussion → Limitations → Conclusions → Appendix A References →
B Abbreviations → C Physician Review & Endorsement → D Evidence Traceability →
E Methodological Basis → F Life Care Plan Integrity Check.

## Interviews & credentials (EPIC-011)

- **Current Complaints** — a subsection under *Current Medical Status* rendered
  from the patient interview (by category, with the patient's verbatim quotes),
  dated to the interview. Appears only when findings exist.
- **Per-recommendation weaving** — interview findings linked to a diagnosis or a
  specific recommendation flow into that recommendation's medical-necessity
  narrative and its *Supporting functional limitations* (patient) /
  *treating-physician documentation* (provider) evidence buckets.
- **Methodology** notes the interviews relied upon (patient + named providers).
- **Qualifications & signature** — authorship derives from the case's designated
  **preparing physician** (`Case.preparingPhysician`), not the creator (ATD-11).
  When that physician carries a credential summary and/or uploaded documents, a
  real Glazer-style credentials paragraph plus a referenced-documents list
  replaces the generic "CV under separate cover," and the signature bears their
  name. With no preparing physician designated, the report falls back to the
  creator's name with the generic language and renders no credentials.
- Nothing here is fabricated — only user-entered interview content and
  uploaded credential documents.

## Content rules

1. **Integrity-gated totals.** `runIntegrityCheck` decides inclusion; excluded
   items are disclosed in Limitations, never silently dropped or included.
2. **Honest review accounting.** Executive Summary states proposed /
   record-supported / physician-approved / awaiting / excluded counts.
   `reviewLabel()` wording is mandatory — no "physician-endorsed" without an
   approval event.
3. **Diagnosis mapping.** Each recommendation shows its region-matched
   supporting diagnosis from the integrity mapping.
4. **No negligence opinions.** The ordinary LCP renders guideline material as
   "Clinical Basis and Future-Care Relevance" — no met/departed/standard-of-care
   verdict language (reserved for a separate, explicitly enabled module).
5. **Literature.** Only citations passing the relevance gate appear; otherwise
   the report states that direct literature support is limited.
6. **Apportionment.** Qualitative consideration language unless a quantitative
   method with basis is actually present.
7. **Repetition control.** Full "In my opinion…" narrative reserved for
   high-cost items (PV ≥ $100k); routine items get one specific sentence + the
   spec table.
8. **DRAFT watermark.** Any unresolved critical validation finding ⇒ title-page
   banner + running-header "DRAFT —" tag + Appendix F table of findings.
9. **Never expose:** AI/tooling language, confidence scores, quality scores,
   defense-vulnerability ratings, internal metrics, prompts, or
   chain-of-thought. (These live in the app, not the document.)
10. **Graceful nulls.** Missing DOI ⇒ "the date of injury"; unknown sex ⇒
    neutral phrasing; no "—" artifacts in prose.

## CSV export

`buildCostCsv` emits the full item table (category, service, CPT, probability,
confidence, frequency, duration, costs, PV, low/high, pricing source, evidence,
vulnerability, physician status) for spreadsheet work — internal fields are
acceptable here because the CSV is a working document, not the served report.

## Verification pattern

Generate against seeded demo data, unzip the DOCX, strip XML to text, then
assert: section flow, forbidden-term absence (AI/score/vulnerability/%), DRAFT
logic, totals consistency, and prose quality. See the Priority-1 test additions
and `scripts/` helpers.
