import { prisma } from "@/lib/db";
import { notify } from "@/lib/notifications/service";
import type { CaseEngagement } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// CaseEngagement service (MDIP docs/28, Agent B). An engagement is the
// commercial wrapper around one expert deliverable for one case: recommended
// (by the damages evaluation) or requested (by staff/attorney), authorized,
// staffed with experts, executed, delivered, completed — or cancelled.
//
// Allowed transition graph (the ONLY legal moves — everything else is refused):
//
//   RECOMMENDED ───────────► AWAITING_AUTHORIZATION ─► AUTHORIZED ─► ASSIGNMENT_PENDING
//        │                          │        │              │               │
//        │ (authorize)              │        ▼              │               ▼
//        ├──────────────────────────┴──► RECORDS_PENDING ───┘         IN_PROGRESS ◄─┐
//        │                                    (authorized but no             │      │
//        │                                     records on file yet)          ▼      │
//        │                                                              QA_REVIEW ──┘
//        │                                                                   │
//        │                                                                   ▼
//        │                                                              DELIVERED
//        │                                                                   │
//        │                                                                   ▼
//        │                                                              COMPLETED (terminal)
//        └──► CANCELLED (terminal — reachable from every non-terminal state,
//                        only via cancelEngagement, which requires a reason)
//
// Every mutation writes an AuditLog row and fires Notifications through the
// notifications service (which swallows its own failures — a notification
// never breaks an engagement flow). No PHI beyond the case number enters any
// notification text.
// ─────────────────────────────────────────────────────────────────────────────

export type EngagementStatus =
  | "RECOMMENDED"
  | "AWAITING_AUTHORIZATION"
  | "RECORDS_PENDING"
  | "AUTHORIZED"
  | "ASSIGNMENT_PENDING"
  | "IN_PROGRESS"
  | "QA_REVIEW"
  | "DELIVERED"
  | "COMPLETED"
  | "CANCELLED";

export const ENGAGEMENT_STATUSES: EngagementStatus[] = [
  "RECOMMENDED",
  "AWAITING_AUTHORIZATION",
  "RECORDS_PENDING",
  "AUTHORIZED",
  "ASSIGNMENT_PENDING",
  "IN_PROGRESS",
  "QA_REVIEW",
  "DELIVERED",
  "COMPLETED",
  "CANCELLED",
];

/** The validated transition map — the single source of truth for legal moves. */
export const ENGAGEMENT_TRANSITIONS: Record<EngagementStatus, EngagementStatus[]> = {
  RECOMMENDED: ["AWAITING_AUTHORIZATION", "AUTHORIZED", "RECORDS_PENDING", "CANCELLED"],
  AWAITING_AUTHORIZATION: ["AUTHORIZED", "RECORDS_PENDING", "CANCELLED"],
  RECORDS_PENDING: ["AUTHORIZED", "CANCELLED"], // records arrived → fully authorized
  AUTHORIZED: ["ASSIGNMENT_PENDING", "IN_PROGRESS", "CANCELLED"],
  ASSIGNMENT_PENDING: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["QA_REVIEW", "DELIVERED", "CANCELLED"],
  QA_REVIEW: ["IN_PROGRESS", "DELIVERED", "CANCELLED"], // QA can send work back
  DELIVERED: ["COMPLETED", "CANCELLED"],
  COMPLETED: [], // terminal
  CANCELLED: [], // terminal
};

const TERMINAL: EngagementStatus[] = ["COMPLETED", "CANCELLED"];

export class EngagementError extends Error {
  constructor(
    message: string,
    readonly status: number = 422,
  ) {
    super(message);
    this.name = "EngagementError";
  }
}

/** The acting user — used for audit attribution and tenant scoping. */
export interface EngagementActor {
  firmId: string;
  userId: string;
}

// ── Fee configuration ────────────────────────────────────────────────────────
// Per-firm pricing lives in Firm.features["pricing"] as
//   { [reportType]: { fixed?, hourly?, rush?, turnaroundDays? } }
// (docs/28 decision 4 — no new billing engine). All values are non-negative
// numbers; anything malformed reads as absent.

export interface PricingEntry {
  fixed?: number;
  hourly?: number;
  rush?: number;
  turnaroundDays?: number;
}

function nonNegNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Resolve the pricing entry for a report type from raw Firm.features. Pure. */
export function feeFor(firmFeatures: unknown, reportType: string): PricingEntry | null {
  if (typeof firmFeatures !== "object" || firmFeatures === null || Array.isArray(firmFeatures)) return null;
  const pricing = (firmFeatures as Record<string, unknown>)["pricing"];
  if (typeof pricing !== "object" || pricing === null || Array.isArray(pricing)) return null;
  const raw = (pricing as Record<string, unknown>)[reportType];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const out: PricingEntry = {
    fixed: nonNegNumber(entry.fixed),
    hourly: nonNegNumber(entry.hourly),
    rush: nonNegNumber(entry.rush),
    turnaroundDays: nonNegNumber(entry.turnaroundDays),
  };
  const hasAny = out.fixed !== undefined || out.hourly !== undefined || out.rush !== undefined || out.turnaroundDays !== undefined;
  return hasAny ? out : null;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function auditEngagement(
  actor: EngagementActor,
  action: string,
  engagement: { id: string; caseId: string },
  meta?: Record<string, unknown>,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      firmId: actor.firmId,
      userId: actor.userId,
      action,
      targetType: "caseEngagement",
      targetId: engagement.id,
      caseId: engagement.caseId,
      meta: (meta as never) ?? undefined,
    },
  });
}

/** Load an engagement, enforcing firm scoping. */
async function requireEngagement(actor: EngagementActor, engagementId: string): Promise<CaseEngagement> {
  const engagement = await prisma.caseEngagement.findFirst({
    where: { id: engagementId, firmId: actor.firmId },
  });
  if (!engagement) throw new EngagementError("Engagement not found", 404);
  return engagement;
}

/** Case number for PHI-free notification text ("—" if the case vanished). */
async function caseNumberFor(firmId: string, caseId: string): Promise<string> {
  const c = await prisma.case.findFirst({ where: { id: caseId, firmId }, select: { caseNumber: true } });
  return c?.caseNumber ?? "—";
}

function invalidTransition(from: string, to: string): EngagementError {
  const allowed = ENGAGEMENT_TRANSITIONS[from as EngagementStatus];
  return new EngagementError(
    `Invalid engagement transition ${from} → ${to}. Allowed from ${from}: ${
      allowed && allowed.length > 0 ? allowed.join(", ") : "none (terminal state)"
    }.`,
  );
}

// ── Mutations ────────────────────────────────────────────────────────────────

export interface CreateEngagementInput {
  caseId: string;
  reportType: string;
  requestedById: string;
  /** Explicit override; when absent the firm pricing config's fixed fee is used. */
  feeEstimate?: number | null;
  /** RECOMMENDED when created from a damages-evaluation recommendation; AWAITING_AUTHORIZATION when requested directly. */
  status?: Extract<EngagementStatus, "RECOMMENDED" | "AWAITING_AUTHORIZATION">;
  /** Raw Firm.features — supplies the pricing config (see feeFor). */
  firmFeatures?: unknown;
}

/**
 * Create an engagement from a recommendation or a direct request. Fee estimate,
 * fee structure, and estimated completion date derive from the firm's pricing
 * config unless explicitly provided.
 */
export async function createEngagement(actor: EngagementActor, input: CreateEngagementInput): Promise<CaseEngagement> {
  const c = await prisma.case.findFirst({
    where: { id: input.caseId, firmId: actor.firmId },
    select: { id: true, caseNumber: true },
  });
  if (!c) throw new EngagementError("Case not found", 404);

  const status: EngagementStatus = input.status ?? "AWAITING_AUTHORIZATION";
  const pricing = feeFor(input.firmFeatures, input.reportType);
  const feeEstimate = input.feeEstimate ?? pricing?.fixed ?? null;
  const feeStructure =
    input.feeEstimate != null ? "FIXED" : pricing?.fixed !== undefined ? "FIXED" : pricing?.hourly !== undefined ? "HOURLY" : null;
  const estimatedCompletionDate =
    pricing?.turnaroundDays !== undefined ? new Date(Date.now() + pricing.turnaroundDays * 86_400_000) : null;

  const engagement = await prisma.caseEngagement.create({
    data: {
      firmId: actor.firmId,
      caseId: input.caseId,
      requestedById: input.requestedById,
      reportType: input.reportType,
      status,
      feeEstimate,
      feeStructure,
      estimatedCompletionDate,
    },
  });

  await auditEngagement(actor, "engagement.create", engagement, {
    reportType: input.reportType,
    status,
    feeEstimate,
  });
  await notify({
    firmId: actor.firmId,
    userId: input.requestedById,
    kind: status === "RECOMMENDED" ? "engagement.recommended" : "engagement.requested",
    title: `Engagement ${status === "RECOMMENDED" ? "recommended" : "requested"}: ${input.reportType} — case ${c.caseNumber}`,
    caseId: input.caseId,
  });
  return engagement;
}

/**
 * Authorize an engagement. Records the authorizer + timestamp, computes
 * missingRequirements from case state: with zero records on file the
 * engagement lands in RECORDS_PENDING (authorized, waiting on records)
 * instead of AUTHORIZED.
 */
export async function authorizeEngagement(actor: EngagementActor, engagementId: string): Promise<CaseEngagement> {
  const engagement = await requireEngagement(actor, engagementId);
  const authorizable: EngagementStatus[] = ["RECOMMENDED", "AWAITING_AUTHORIZATION", "RECORDS_PENDING"];
  if (!authorizable.includes(engagement.status as EngagementStatus)) {
    throw invalidTransition(engagement.status, "AUTHORIZED");
  }

  const recordCount = await prisma.document.count({ where: { caseId: engagement.caseId } });
  const missingRequirements: string[] = [];
  if (recordCount === 0) missingRequirements.push("MEDICAL_RECORDS");
  const nextStatus: EngagementStatus = missingRequirements.length > 0 ? "RECORDS_PENDING" : "AUTHORIZED";

  const updated = await prisma.caseEngagement.update({
    where: { id: engagement.id },
    data: {
      status: nextStatus,
      authorizedById: actor.userId,
      authorizedAt: new Date(),
      missingRequirements: missingRequirements as never,
    },
  });

  await auditEngagement(actor, "engagement.authorize", engagement, {
    from: engagement.status,
    to: nextStatus,
    missingRequirements,
  });
  const caseNumber = await caseNumberFor(actor.firmId, engagement.caseId);
  await notify({
    firmId: actor.firmId,
    userId: engagement.requestedById,
    kind: nextStatus === "RECORDS_PENDING" ? "engagement.records_pending" : "engagement.authorized",
    title:
      nextStatus === "RECORDS_PENDING"
        ? `Engagement authorized, records pending: ${engagement.reportType} — case ${caseNumber}`
        : `Engagement authorized: ${engagement.reportType} — case ${caseNumber}`,
    caseId: engagement.caseId,
  });
  return updated;
}

export interface AssignExpertsInput {
  plannerId?: string | null;
  physicianId?: string | null;
  vocationalExpertId?: string | null;
  economistId?: string | null;
  qaReviewerId?: string | null;
}

/**
 * Assign the expert team. Legal from AUTHORIZED, ASSIGNMENT_PENDING, or
 * IN_PROGRESS (re-staffing). With at least one expert assigned the engagement
 * moves to IN_PROGRESS; with none it sits in ASSIGNMENT_PENDING. Every newly
 * assigned expert is notified.
 */
export async function assignExperts(
  actor: EngagementActor,
  engagementId: string,
  assignees: AssignExpertsInput,
): Promise<CaseEngagement> {
  const engagement = await requireEngagement(actor, engagementId);
  const assignable: EngagementStatus[] = ["AUTHORIZED", "ASSIGNMENT_PENDING", "IN_PROGRESS"];
  if (!assignable.includes(engagement.status as EngagementStatus)) {
    throw invalidTransition(engagement.status, "ASSIGNMENT_PENDING");
  }

  // Every referenced assignee must be an ACTIVE seat in this firm.
  const referencedIds = [
    assignees.plannerId,
    assignees.physicianId,
    assignees.vocationalExpertId,
    assignees.economistId,
    assignees.qaReviewerId,
  ].filter((id): id is string => typeof id === "string" && id.length > 0);
  if (referencedIds.length > 0) {
    const found = await prisma.user.findMany({
      where: { id: { in: referencedIds }, firmId: actor.firmId, status: "ACTIVE" },
      select: { id: true },
    });
    const foundIds = new Set(found.map((u) => u.id));
    const missing = referencedIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) throw new EngagementError("One or more assignees are not active members of this firm.", 400);
  }

  // Merge: undefined leaves a slot untouched; null explicitly clears it.
  const next = {
    assignedPlannerId: assignees.plannerId === undefined ? engagement.assignedPlannerId : assignees.plannerId,
    assignedPhysicianId: assignees.physicianId === undefined ? engagement.assignedPhysicianId : assignees.physicianId,
    assignedVocationalExpertId:
      assignees.vocationalExpertId === undefined ? engagement.assignedVocationalExpertId : assignees.vocationalExpertId,
    assignedEconomistId: assignees.economistId === undefined ? engagement.assignedEconomistId : assignees.economistId,
    assignedQaReviewerId: assignees.qaReviewerId === undefined ? engagement.assignedQaReviewerId : assignees.qaReviewerId,
  };
  const anyAssigned = Object.values(next).some((v) => v != null);
  const nextStatus: EngagementStatus = anyAssigned ? "IN_PROGRESS" : "ASSIGNMENT_PENDING";

  const updated = await prisma.caseEngagement.update({
    where: { id: engagement.id },
    data: { ...next, status: nextStatus },
  });

  await auditEngagement(actor, "engagement.assign", engagement, {
    from: engagement.status,
    to: nextStatus,
    assignees: next,
  });

  const caseNumber = await caseNumberFor(actor.firmId, engagement.caseId);
  const previous = [
    engagement.assignedPlannerId,
    engagement.assignedPhysicianId,
    engagement.assignedVocationalExpertId,
    engagement.assignedEconomistId,
    engagement.assignedQaReviewerId,
  ];
  const newlyAssigned = [...new Set(Object.values(next).filter((id): id is string => id != null && !previous.includes(id)))];
  for (const userId of newlyAssigned) {
    await notify({
      firmId: actor.firmId,
      userId,
      kind: "engagement.assigned",
      title: `You were assigned to an engagement: ${engagement.reportType} — case ${caseNumber}`,
      caseId: engagement.caseId,
    });
  }
  if (!newlyAssigned.includes(engagement.requestedById)) {
    await notify({
      firmId: actor.firmId,
      userId: engagement.requestedById,
      kind: "engagement.staffed",
      title: `Engagement staffed: ${engagement.reportType} — case ${caseNumber}`,
      caseId: engagement.caseId,
    });
  }
  return updated;
}

/**
 * Advance an engagement along the transition graph. CANCELLED is refused here
 * (cancellation requires a reason — use cancelEngagement); everything else is
 * validated against ENGAGEMENT_TRANSITIONS. COMPLETED stamps completedAt.
 */
export async function advanceStatus(actor: EngagementActor, engagementId: string, nextStatus: string): Promise<CaseEngagement> {
  if (!ENGAGEMENT_STATUSES.includes(nextStatus as EngagementStatus)) {
    throw new EngagementError(`Unknown engagement status: ${nextStatus}`, 400);
  }
  if (nextStatus === "CANCELLED") {
    throw new EngagementError("Cancellation requires a reason — use the cancel action.", 400);
  }
  const engagement = await requireEngagement(actor, engagementId);
  const allowed = ENGAGEMENT_TRANSITIONS[engagement.status as EngagementStatus] ?? [];
  if (!allowed.includes(nextStatus as EngagementStatus)) {
    throw invalidTransition(engagement.status, nextStatus);
  }

  const updated = await prisma.caseEngagement.update({
    where: { id: engagement.id },
    data: {
      status: nextStatus,
      ...(nextStatus === "COMPLETED" ? { completedAt: new Date() } : {}),
    },
  });

  await auditEngagement(actor, "engagement.advance", engagement, { from: engagement.status, to: nextStatus });
  if (nextStatus === "DELIVERED" || nextStatus === "COMPLETED") {
    const caseNumber = await caseNumberFor(actor.firmId, engagement.caseId);
    await notify({
      firmId: actor.firmId,
      userId: engagement.requestedById,
      kind: `engagement.${nextStatus.toLowerCase()}`,
      title: `Engagement ${nextStatus === "DELIVERED" ? "delivered" : "completed"}: ${engagement.reportType} — case ${caseNumber}`,
      caseId: engagement.caseId,
    });
  }
  return updated;
}

/**
 * Cancel an engagement. A non-empty reason is mandatory; terminal engagements
 * cannot be cancelled. The reason is persisted as cancellationStatus.
 */
export async function cancelEngagement(actor: EngagementActor, engagementId: string, reason: string): Promise<CaseEngagement> {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) throw new EngagementError("A cancellation reason is required.", 400);
  const engagement = await requireEngagement(actor, engagementId);
  if (TERMINAL.includes(engagement.status as EngagementStatus)) {
    throw invalidTransition(engagement.status, "CANCELLED");
  }

  const updated = await prisma.caseEngagement.update({
    where: { id: engagement.id },
    data: { status: "CANCELLED", cancellationStatus: trimmed, cancelledAt: new Date() },
  });

  await auditEngagement(actor, "engagement.cancel", engagement, { from: engagement.status, reason: trimmed });
  const caseNumber = await caseNumberFor(actor.firmId, engagement.caseId);
  const recipients = new Set(
    [
      engagement.requestedById,
      engagement.assignedPlannerId,
      engagement.assignedPhysicianId,
      engagement.assignedVocationalExpertId,
      engagement.assignedEconomistId,
      engagement.assignedQaReviewerId,
    ].filter((id): id is string => id != null),
  );
  for (const userId of recipients) {
    await notify({
      firmId: actor.firmId,
      userId,
      kind: "engagement.cancelled",
      title: `Engagement cancelled: ${engagement.reportType} — case ${caseNumber}`,
      caseId: engagement.caseId,
    });
  }
  return updated;
}
