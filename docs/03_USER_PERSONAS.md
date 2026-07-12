# 03 — User Personas

Roles are enforced in code (`src/lib/rbac.ts`); these personas describe how the
humans behind them work. Permissions listed are the authoritative matrix.

## The Planner (`PLANNER`)
Certified life care planner / rehab or nurse consultant. Owns the case
end-to-end: intake, uploads, chronology curation, future-care drafting, pricing
review, report export. Cares about: throughput, not losing work, catching gaps
before the physician or attorney does. Pain: thousand-page charts, template
drudgery, defending frequency/duration choices.
**Permissions:** case create/edit, uploads, chronology, future-care, export,
precedents.

## The Physician Reviewer (`PHYSICIAN_REVIEWER`)
Physician expert who signs the medical-necessity opinions. Reviews each
recommendation with the evidence in front of them; approves / rejects /
modifies (probability, frequency, duration) with a note. Cares about: seeing
the objective basis fast, never being represented as having approved something
they didn't. Pain: review queues without evidence context.
**Permissions:** view, physician.review, export.

## The Attorney (`ATTORNEY_REVIEWER`)
Retaining counsel (either side). Reads the plan for damages posture: totals,
drivers, what is approved vs. pending, weaknesses the other side will attack.
Cares about: version differences between disclosures, traceability of every
number. **Permissions:** view, export.

## The Paralegal (`PARALEGAL`)
Runs intake and records wrangling: uploads, classification checks, provider/
date metadata, missing-records chase lists.
**Permissions:** case create/edit, uploads, chronology.

## The Firm Admin (`ADMIN`)
Practice owner. Manages seats, roles, billing, branding/letterhead, audit
review. Cares about: utilization, turnaround, compliance posture.
**Permissions:** everything.

## The Billing User (`BILLING_USER`)
Bookkeeper persona; subscription and payment only. **Permissions:** billing.
