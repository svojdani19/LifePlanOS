# EPIC-002 — Evidence Graph

**Status:** Shipped v1 (2026-07-12) — `EvidenceLink` materialized at generation from structured engine output; rebuilt on demand via POST /api/cases/:id/evidence.

## Scope pointer
Materialize diagnosis→evidence→recommendation→literature→review relationships as queryable rows (`EvidenceLink`). Design notes: [../08_EVIDENCE_GRAPH.md](../08_EVIDENCE_GRAPH.md); roadmap P2.

*Problem, business value, functional/technical/UX requirements, acceptance
criteria, tests, and documentation updates to be specified here before this
epic is scheduled.*

## Shipped notes
See [../08_EVIDENCE_GRAPH.md](../08_EVIDENCE_GRAPH.md); builder unit-tested (`engine/evidenceGraph.test.ts`).
