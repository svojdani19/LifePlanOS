# Roles & Access — Firm Administrator Guide

Plain-language guide to LifePlanOS authorization. Architecture: docs/26.

## How access is decided

Every action is checked on the server in a fixed order — the first rule that
applies wins: platform security prohibitions → your organization's boundary →
feature flags → required professional credentials → explicit denials →
workflow-stage locks → report-state locks → assignment scope → allows from
roles and grants → otherwise **denied**. Missing context always means no.

## Built-in roles (protected templates)

Thirteen templates (Firm Administrator, Case Manager, Records Analyst, Life
Care Planner, Physician Reviewer, Vocational Expert, Forensic Economist, QA
Reviewer, External Expert, Attorney Client, Insurance Client, Observer,
Platform Sysadmin). You can assign them or clone them into custom roles; you
cannot edit them. Your six legacy roles map automatically (existing users
keep exactly their current access).

## Custom roles

Clone a template or start from scratch; pick granular permissions with
scopes (organization / office / case / report) and explicit denials. Rules
that protect you:
- You can only grant permissions you hold *and* that are delegable — no
  self-escalation, no platform-only keys.
- Approval/attestation permissions never substitute for credentials: signing
  as a physician, vocational expert, or economist always requires a
  verified, unexpired credential of that category, regardless of role.
- Roles are versioned; concurrent edits conflict instead of overwriting;
  assigned roles archive, never delete.
- **Warning: avoid overly broad roles.** Clone the narrowest template that
  fits and add only what the job actually needs.

## Assignments

A role says what someone *could* do; an assignment says *where*: whole
organization, one office, or a single case (with a responsibility label like
Primary Planner). Assignments can be scheduled and temporary — temporary
access always has an end date and expires automatically. Every change is
audited with who/why.

## Credentials

Statuses: self-reported → organization-verified → externally verified (or
expired/suspended/pending). Self-reported is not sufficient for signing.
LifePlanOS does not independently verify licensure — verification records
who at your firm checked, and when.

## Rollout

The enterprise evaluator runs in shadow (logging any difference from legacy
behavior) until your firm enables `authorization.enterprise`. Flip it only
after verifying physicians' credentials — that is the one intentional
tightening: signing requires a verified credential from day one.

## Troubleshooting a denial

The denial message states the user-safe reason (e.g. "Physician credential
required", "Case assignment required", "Feature not enabled", "Workflow
stage locked"). Administrators can use the access preview (Roles & Access →
Access Review) to evaluate any user + action + case and see exactly which
rule decided.
