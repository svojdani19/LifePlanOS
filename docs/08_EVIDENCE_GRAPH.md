# 08 — Evidence Graph

The evidence graph is the relationship layer connecting
**Diagnosis → Objective Evidence → Functional Limitations → Recommendation →
CPT/HCPCS → Pricing → Literature → Physician Review → Cost.** Its rule: these
relationships live in **structured data**, never only inside free-text output.

## What exists today (implemented)

| Relationship | Where it lives |
|---|---|
| Diagnosis → record evidence (doc, page, verbatim quote) | `Condition.evidenceSources` JSON, located by `engine/evidence.ts` |
| Recommendation → diagnosis | `FutureCareItem.conditionId`, set by body-region mapping (`integrity.mapRecommendationToCondition`) — never blindly the primary diagnosis |
| Recommendation → CPT / pricing basis | `FutureCareItem.cptCode`, `pricingSource`, validated by `integrity.validateCode` / `validatePricing` |
| Recommendation → literature | `FutureCareItem.citation` JSON (real articles), relevance-gated at render (`evaluateCitation`) |
| Recommendation → physician review | `physicianStatus`, note, summary + `AuditLog` events |
| Chronology event → source | `ChronologyEvent.sourceDocumentId` + `sourcePage` |
| Guideline support per diagnosis | `Condition.socAnalysis` (verbatim-quoted guidance) |
| Validation state per recommendation | `ValidationFinding` rows (persisted) |
| Report traceability | Appendix D (recommendation → diagnosis → records → literature → cost basis) |

## Priority-2 target (approved design)

An additive `EvidenceLink` join model materializing the relationships above as
queryable rows, populated at generation from the existing extractions (no new
inference):

```prisma
model EvidenceLink {
  id String @id @default(uuid())
  caseId String; firmId String
  kind   String   // DIAGNOSIS_EVIDENCE | REC_DIAGNOSIS | REC_EVIDENCE |
                  // REC_LITERATURE | REC_FUNCTIONAL | CONTRADICTS | ...
  fromType String; fromId String
  toType   String; toId   String
  documentId String?; page Int?; quote String?
  meta Json?
  createdAt DateTime @default(now())
}
```

On top of it: the **Evidence Explorer** — a panel inside the existing case
workspace (existing design system, no new navigation) that answers, for any
selected diagnosis, chronology entry, limitation, or recommendation:

- Why this item exists
- What evidence supports it (records, pages, quotes, providers, literature)
- What evidence weakens it (contradictory records)
- What remains unknown (gaps, missing records)
- What approval is still required

Explanations are **source-backed** — assembled from links and quotes, never
hidden chain-of-thought.

## Priority-2 formal requirement — Recommendation versioning

See [15_PRODUCT_ROADMAP.md](15_PRODUCT_ROADMAP.md) § "P2.R1" for the binding requirement
(supersede-not-delete, lineage, material-change re-review) and
[06_DATABASE_SPEC.md](06_DATABASE_SPEC.md) § "Proposed schema" for the lineage
fields.
