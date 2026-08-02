import { prisma } from "@/lib/db";
import type { UserRole } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Notification service (MDIP docs/28). Minimal, fire-and-forget helpers used by
// workflow transitions (engagements, reviews). Two hard rules:
//
//   1. Notifications NEVER break a flow — every failure is swallowed. A missed
//      bell item is acceptable; a failed authorization because the notification
//      insert raced is not.
//   2. No PHI beyond the case number + a short workflow title ever enters a
//      notification. Client names, diagnoses, and record content stay out.
// ─────────────────────────────────────────────────────────────────────────────

export interface NotifyInput {
  firmId: string;
  userId: string;
  kind: string; // e.g. "engagement.authorized"
  title: string; // short, PHI-free (case number + workflow event only)
  body?: string;
  caseId?: string;
}

/** Create one notification. Swallows every error — notifications never break a flow. */
export async function notify(input: NotifyInput): Promise<boolean> {
  try {
    await prisma.notification.create({
      data: {
        firmId: input.firmId,
        userId: input.userId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        caseId: input.caseId ?? null,
      },
    });
    return true;
  } catch {
    return false; // never propagate
  }
}

export interface NotifyRoleInput {
  firmId: string;
  role: UserRole; // legacy role — fans out to every ACTIVE holder
  kind: string;
  title: string;
  body?: string;
  caseId?: string;
}

/**
 * Fan a notification out to every ACTIVE user holding a legacy role in the
 * firm. Returns the number of notifications created (0 on any failure).
 */
export async function notifyRole(input: NotifyRoleInput): Promise<number> {
  try {
    const users = await prisma.user.findMany({
      where: { firmId: input.firmId, role: input.role, status: "ACTIVE" },
      select: { id: true },
    });
    if (users.length === 0) return 0;
    await prisma.notification.createMany({
      data: users.map((u) => ({
        firmId: input.firmId,
        userId: u.id,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        caseId: input.caseId ?? null,
      })),
    });
    return users.length;
  } catch {
    return 0; // never propagate
  }
}
