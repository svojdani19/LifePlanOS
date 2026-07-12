# LifePlanOS Documentation

This directory contains the governing documentation for LifePlanOS.

These documents define the architecture, clinical rules, product vision,
development standards, and roadmap for the platform.

**The code implements these documents — not the other way around.** When a task
conflicts with the docs, stop and resolve the conflict explicitly before
writing code.

## Canonical reading order

| # | Document | Purpose |
|---|---|---|
| 00 | [00_MASTER_PRODUCT_SPEC.md](00_MASTER_PRODUCT_SPEC.md) | **The controlling specification** — vision, roles, workflows, rules, definition of done, known limitations, explicit non-goals. Start here. |
| 01 | [01_PRODUCT_VISION.md](01_PRODUCT_VISION.md) | The problem, the vision, differentiation, north-star outcomes. |
| 02 | [02_MARKET_ANALYSIS.md](02_MARKET_ANALYSIS.md) | Buyer segments, real alternatives, positioning, moats, risks (qualitative; no invented statistics). |
| 03 | [03_USER_PERSONAS.md](03_USER_PERSONAS.md) | The humans behind each role and what they need. |
| 04 | [04_PRODUCT_PRINCIPLES.md](04_PRODUCT_PRINCIPLES.md) | Operating principles: never fabricate, no software opinions, honest labels, traceability, expert control. |
| 05 | [05_SYSTEM_ARCHITECTURE.md](05_SYSTEM_ARCHITECTURE.md) | Application layout, key patterns, dev-environment notes. |
| 06 | [06_DATABASE_SPEC.md](06_DATABASE_SPEC.md) | Data model, derived vs. user-authored data, migration discipline, schema change log, proposed lineage schema. |
| 07 | [07_AI_ENGINE.md](07_AI_ENGINE.md) | The deterministic pipeline: hard rules, stages, literature layer, validation layer, failure modes. |
| 08 | [08_EVIDENCE_GRAPH.md](08_EVIDENCE_GRAPH.md) | Evidence relationships today and the Priority-2 EvidenceLink / Evidence Explorer design. |
| 09 | [09_CLINICAL_RULES.md](09_CLINICAL_RULES.md) | Diagnosis mapping, coding, pricing, literature relevance, inclusion-in-totals, review labels, apportionment. |
| 10 | [10_REPORT_ENGINE.md](10_REPORT_ENGINE.md) | The DOCX report: locked design system, locked section flow, content rules, verification pattern. |
| 11 | [11_SECURITY.md](11_SECURITY.md) | Tenancy, auth, PHI handling, storage, audit, logging rules, known gaps. |
| 12 | [12_DEPLOYMENT.md](12_DEPLOYMENT.md) | Environment, migrations, seed, release checklist and gates. |
| 13 | [13_DEVELOPER_STANDARDS.md](13_DEVELOPER_STANDARDS.md) | Change control, definition of done, code conventions. |
| 14 | [14_TESTING.md](14_TESTING.md) | Testing philosophy, what is pinned where, DOCX verification pattern, required additions per phase. |
| 15 | [15_PRODUCT_ROADMAP.md](15_PRODUCT_ROADMAP.md) | Priorities P1–P4 with status, and formal requirements (P2.R1 recommendation versioning). |
| 16 | [16_DECISION_LOG.md](16_DECISION_LOG.md) | Accepted Technical Decisions (ATD log) — binding engineering decisions with rationale. |
| 17 | [17_CHANGELOG.md](17_CHANGELOG.md) | Chronological record of shipped changes. |
| — | [epics/](epics/README.md) | One PRD per epic; implement one epic at a time. EPIC-001 partially shipped; others planned. |

## Conventions

- Numbered files are the canonical set; propose new numbers rather than
  creating unnumbered documents.
- No secrets, API keys, PHI, or real patient information in documentation.
- Schema changes require an entry in 06 **and** 17_CHANGELOG.md; engineering
  decisions go in the ATD log (16); feature-scale work gets an epic PRD before
  implementation.
