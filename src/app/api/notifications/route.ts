import { prisma } from "@/lib/db";
import { requireApiContext } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Notification feed (MDIP docs/28). Any authenticated user reads and marks
// ONLY their own notifications — no permission gate beyond a valid session,
// no cross-user access. Notification text carries no PHI beyond case number
// + workflow title (enforced at write time in the notification service).
// ─────────────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const ctx = await requireApiContext();
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: ctx.user.id },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.notification.count({ where: { userId: ctx.user.id, readAt: null } }),
    ]);
    return ok({ notifications, unreadCount });
  } catch (err) {
    return handleError(err);
  }
}

// PATCH ?id=<id> marks one of the caller's notifications read.
// PATCH ?all=1 marks all of the caller's unread notifications read.
export async function PATCH(req: Request) {
  try {
    const ctx = await requireApiContext();
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const all = url.searchParams.get("all");

    if (all === "1") {
      const res = await prisma.notification.updateMany({
        where: { userId: ctx.user.id, readAt: null },
        data: { readAt: new Date() },
      });
      return ok({ updated: res.count });
    }
    if (!id) return ok({ error: "Provide ?id= or ?all=1" }, 400);

    // Scoped by userId — a user can never mark someone else's notification.
    const res = await prisma.notification.updateMany({
      where: { id, userId: ctx.user.id },
      data: { readAt: new Date() },
    });
    if (res.count === 0) return ok({ error: "Notification not found" }, 404);
    return ok({ updated: res.count });
  } catch (err) {
    return handleError(err);
  }
}
