# Security and Commercial Readiness

## Positive findings

- Tenant guard patterns and tenant-isolation tests exist.
- Login throttling is database-backed.
- Recommendation and report actions are audited.
- Object-storage garbage collection was added to deletion.
- Role-specific workflows are emerging.
- Version snapshots and report comparison improve defensibility.

## Paid-pilot gates

Before using identifiable records in a paid pilot, verify:

1. Executed BAAs with all vendors handling PHI.
2. Production-grade encryption and key management.
3. Secure, expiring object URLs and strict storage bucket policies.
4. Centralized PHI-safe logs with retention policy.
5. Backup and tested restore procedure.
6. Incident-response plan.
7. User offboarding and session revocation.
8. MFA enforcement options for firms.
9. Vulnerability scanning and dependency monitoring.
10. Production observability for OCR, literature, AI, and export jobs.
11. Data-retention and deletion controls.
12. Clean cross-platform CI build and test run.

## Commercial product gates

- Guided onboarding for a new firm
- Firm template configuration
- Support workflow and issue reporting
- Clear limits and billing behavior
- Error recovery for failed OCR/AI jobs
- User-facing status for long-running jobs
- Demonstrable report turnaround improvement
- Quality benchmark against expert-created plans
- Terms of service, privacy policy, BAA workflow, and acceptable-use policy
- Design-partner feedback from at least several planners and attorneys

## Recommended commercialization sequence

### Stage 1 — Internal validation

Use synthetic and fully de-identified cases. Run adversarial review against the source records.

### Stage 2 — Design partners

Small number of experienced life care planners. Require human review of every recommendation and citation.

### Stage 3 — Paid controlled pilot

Limit report volume, monitor all evidence failures, and maintain a formal escalation path.

### Stage 4 — General availability

Only after evidence relevance, source integrity, export blocking, security operations, and customer support are proven.
