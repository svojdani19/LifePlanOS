# EPIC-011 — Clinical Interviews & Reviewer Credentials

**Status:** Shipped (2026-07-12). Credential upload available to any medical-personnel seat (ADMIN / PLANNER / PHYSICIAN_REVIEWER).

Closes the two gaps identified when benchmarking a generated plan against a
signed physician LCP (David Glazer MD, *F.J. Redacted LCP*): (1) that report was
authored by a named, board-certified physician who **interviewed the patient and
the treating providers**, and (2) it **incorporated the physician's credentials**
(board certifications, CV). A records-only generator cannot invent either; this
epic gives the human expert a structured place to supply them and weaves them
into the report exactly where Glazer's did.

---

## Problem

Our report is more rigorously validated and more evidence-dense per
recommendation than the reference, but it is **less persuasive at deposition**
because it lacks the two things that make an LCP read as physician-authored:

1. **No patient voice.** Glazer's "Complaints" section — first-person, per
   symptom ("migraine headaches at least 4 days per week … aura of stars and
   double vision," "nightmares that are usually about water") — is the clinical
   and human heart of the document. We have no interview data, so we cannot
   produce it.
2. **No treating-provider input.** Glazer interviewed the treating neurologist;
   those opinions carry weight ours cannot.
3. **Generic authorship.** Our Qualifications section says "prepared by
   [planner], CV under separate cover" instead of a named physician's real
   credentials and referenced CV.

## Business value

- **Persuasiveness / defensibility** — the single biggest lever on report
  credibility identified in the benchmark.
- **Retention** — makes the physician expert (the high-value seat) a first-class
  participant, not just an approver.
- **Differentiation** — combines our validation/evidence engine with a real
  physician's interview and signature, which neither manual authoring nor a
  records-only generator achieves alone.

## Scope — three capabilities

### A. Treating Providers tab (+ provider interviews)
A new **"Treating Providers"** tab in the existing case workspace that:
- **Auto-populates** the roster of providers affiliated with the care, pulled
  from the medical record we already parse (`Document.authorName` /
  `authorCredentials` / `authorRole` / `facility`, `Document.providers[]`,
  `ChronologyEvent.provider`), deduplicated by name.
- Lets the user **confirm, edit, add, or dismiss** providers (extraction is a
  suggestion; the curated roster is user-owned and survives regeneration).
- Provides, per provider, a place to **record interview findings** —
  **categorized or free-text** — with interview date and interviewer.
- Feeds those findings into the **final report**.

### B. Patient interview
A patient-interview capture (surfaced on the Overview/Current-Status area or as
a sub-view of the same tab) that records, per **clinical category** and/or as
**free text**, the patient's complaints and their own words, with interview date
and interviewer — the raw material for a Glazer-style "Current Complaints"
section and for per-recommendation necessity.

### C. Reviewer credentials on seats
For any **medical-personnel seat** (physician reviewer, and optionally any user),
allow upload of **board certification, CV, license, or other credential
documents**, stored securely and **referenced in the report** the way Glazer's
credentials appear — a real Qualifications paragraph plus a referenced-documents
list.

---

## Functional requirements

### Provider roster
- On case load (and after each generation), compute a **suggested provider list**
  from the records; present new suggestions the user hasn't yet acted on.
- Each roster entry: name, credentials, specialty/role, facility, source
  documents/pages, `isTreating` vs incidental, contact (optional), status
  (suggested / confirmed / dismissed).
- Regeneration **must not delete** a provider that carries interview findings or
  user edits (same supersede-not-delete principle as P2.R1 / SoC inputs).

### Interview findings (patient and provider)
- A finding has: **category** (from a fixed clinical taxonomy — see below) **or**
  free-text; the finding text; an optional **verbatim patient/provider quote**;
  interview date; interviewer (a user); and optional **links** to a specific
  `Condition` and/or `FutureCareItem` so the finding can feed that
  recommendation.
- Clinical categories (taxonomy, extensible): Pain, Headache, Sleep, Cognition,
  Mood/Psychological, Mobility/Gait, ADLs/Self-care, Vision, Bladder/Bowel,
  Medications, Work/Vocational, Sensory/Neurologic, Other.
- Findings are **user-authored** and never wiped by regeneration.

### Report incorporation
- **Current Complaints & Patient Interview** — a new subsection under *Current
  Medical Status* (does not alter the section order or DOCX design), rendering
  the patient interview by category in Glazer's style, with quotes, dated to the
  interview.
- **Per-recommendation necessity** — a finding linked to a condition/item is
  woven into that recommendation's medical-necessity narrative and appears in its
  *Supporting functional limitations* / *Supporting treating-physician
  documentation* evidence buckets (via `medicalNecessity.ts`).
- **Treating-provider opinions** — provider interview findings appear as a
  *Treating provider opinion* evidence item on linked recommendations, and the
  roster (with interview dates) is summarized where the plan lists its basis.
- **Qualifications** — when a physician-reviewer seat with credentials is on the
  case, render their real name, board certifications, and a referenced CV
  paragraph in place of the generic "CV under separate cover"; list the credential
  documents (e.g., in Records Reviewed or an appendix).
- **Methodology** — note that the plan is informed by patient and treating-
  provider interviews when present (mirrors Glazer's "Dr. … interviewed Ms. … on
  …").

### Permissions
- Provider roster + interviews: `case.edit` (planner/paralegal/admin);
  physician-reviewer may add provider-opinion findings.
- Credential upload for a seat: the seat's owner or `team.manage` (admin).
- All reads firm-scoped through the tenant guard; no cross-firm exposure.

---

## Technical requirements

### Data model (additive; migrations per the established discipline)

```prisma
enum ProviderStatus { SUGGESTED CONFIRMED DISMISSED }
model TreatingProvider {
  id String @id @default(uuid())
  caseId String; firmId String
  name String
  credentials String?
  specialty   String?
  facility    String?
  contact     String?
  isTreating  Boolean @default(true)
  status      ProviderStatus @default(SUGGESTED)
  sourceDocumentIds Json?  // documents/pages the provider appears in
  addedById   String?
  createdAt DateTime @default(now())
  @@index([caseId]); @@index([firmId])
}

enum InterviewSubject { PATIENT PROVIDER }
model InterviewFinding {
  id String @id @default(uuid())
  caseId String; firmId String
  subject     InterviewSubject          // patient vs a treating provider
  providerId  String?                   // TreatingProvider, when subject = PROVIDER
  category    String?                   // clinical taxonomy, or null for free-text
  text        String
  quote       String?                   // verbatim patient/provider words
  interviewDate DateTime?
  interviewedById String?               // the user who conducted it
  conditionId String?                   // optional link → feeds that diagnosis
  futureCareItemId String?              // optional link → feeds that recommendation
  createdById String?
  createdAt DateTime @default(now())
  @@index([caseId]); @@index([firmId]); @@index([caseId, subject])
}

enum CredentialType { BOARD_CERTIFICATION CV LICENSE OTHER }
model UserCredential {
  id String @id @default(uuid())
  userId String; firmId String
  type        CredentialType
  label       String?                   // e.g. "ABPMR — Brain Injury Medicine"
  filename    String
  storageKey  String                    // lib/storage (S3/local), streamed via authed route
  createdById String?
  createdAt DateTime @default(now())
  @@index([userId]); @@index([firmId])
}
// User: + credentialSummary String?  (optional cached "board certified in …" line)
```

Interview findings and credentials are **user-authored** (survive regeneration);
`TreatingProvider` is curated (suggested → confirmed; confirmed/interviewed
entries are preserved on regeneration, matched by normalized name).

### Services
- `engine/providerRoster.ts` (pure) — aggregate + dedupe providers from the
  documents/chronology already loaded; produce suggestions; reconcile against the
  existing curated roster (preserve confirmed/interviewed).
- Extend `engine/medicalNecessity.ts` — accept linked interview findings and fold
  them into the necessity narrative and the *functional limitations* /
  *physician documentation* evidence buckets (additive inputs; existing outputs
  unchanged when no interviews exist).
- `engine/report` — new *Current Complaints* subsection; Qualifications pulls
  reviewer credentials; roster/opinions rendered. **No design/section-order
  change.**

### APIs (all tenant-guarded + audited)
- `GET /api/cases/:id/providers` (roster + fresh suggestions),
  `POST` (add/confirm), `PATCH/DELETE /:providerId` (edit/dismiss).
- `GET/POST /api/cases/:id/interviews`, `PATCH/DELETE /:findingId`.
- `POST /api/team/:userId/credentials` (multipart upload),
  `GET /api/team/:userId/credentials`, `DELETE /:credentialId`,
  `GET /api/team/:userId/credentials/:credentialId/view` (authed stream).

### Storage
Credential documents use the existing `lib/storage` (S3 SSE-KMS / local),
streamed through an authenticated route; deletion GCs the object (per ATD-3).

---

## UX requirements

- **New "Treating Providers" tab** in the existing case tab bar (between
  Chronology/Causation and Future Care), using the existing design system — no
  new navigation paradigm, no restyle.
- Roster as a simple table/cards (name · credentials · specialty · facility ·
  source), with confirm/edit/dismiss and an "Add provider" control.
- Per provider: an expandable interview panel — category dropdown + text +
  optional quote + date, or a free-text note; a list of recorded findings.
- Patient interview: the same finding editor scoped to the patient, grouped by
  category, on the Overview/Current-Status area.
- Seats (Team page): per medical-personnel user, a credentials list with upload
  and a short "board certified in …" summary field.
- Design tokens, typography, and report layout unchanged.

---

## Acceptance criteria

1. The Treating Providers tab auto-lists providers parsed from the case records,
   deduplicated, with their source documents.
2. A user can confirm/edit/add/dismiss providers; regeneration preserves any
   provider with interview findings or edits.
3. Patient and provider interview findings can be recorded as **categorized or
   free-text**, with quotes and dates, and optionally linked to a diagnosis or
   recommendation.
4. The generated report contains a **Current Complaints** section reflecting the
   patient interview (by category, with quotes) when findings exist; absent
   findings, the report is unchanged (no empty section).
5. A finding linked to a recommendation appears in that recommendation's
   necessity narrative / evidence buckets.
6. A physician-reviewer seat's uploaded credentials render a real Qualifications
   paragraph and a referenced-documents list; without credentials, the current
   generic language is retained.
7. Credential documents are firm-scoped, streamed through an authed route, and
   GC'd on deletion; no cross-firm access.
8. No change to report design, section order, navigation, or unrelated workflow.

## Tests

- Provider roster: dedupe + suggestion + regeneration preservation (pure).
- Interview findings: categorized/free-text round-trip; linkage to condition/item.
- `medicalNecessity`: a linked patient complaint flows into the dossier; no
  interviews ⇒ output identical to today (regression).
- Report: Current Complaints appears only when findings exist; Qualifications
  reflects credentials when present.
- Security: cross-firm denial for providers, interviews, and credential
  documents (route-conformance + behavioral).

## Documentation updates

- New model docs in `06_DATABASE_SPEC`; interview/credential incorporation in
  `10_REPORT_ENGINE`; workflow note in `00_MASTER_PRODUCT_SPEC` (§4);
  decision log entry (interviews are user-authored, never fabricated); changelog.

## Non-goals

- **No fabricated interview content.** The system stores only what a user enters;
  it never invents patient complaints or provider opinions.
- No automated transcription or NLP of interviews (manual entry in v1).
- No change to the deterministic evidence/validation engines beyond accepting
  interview inputs.

## Phasing

1. **P1** — schema + Treating Providers tab (roster + provider interviews) +
   report roster/opinions.
2. **P2** — patient interview capture + Current Complaints section + per-
   recommendation weaving.
3. **P3** — seat credentials upload + Qualifications incorporation.
