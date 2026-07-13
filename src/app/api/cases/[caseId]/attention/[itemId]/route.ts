import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";

// Triage a single attention item: assign / start review / defer / resolve /
// dismiss / reopen. This ONLY changes the item's triage state and assignee — it
// never approves a recommendation, edits a cost, or changes physician approval
// (§8). Every transition is audited with prior→new status and the reason (§10);
// resolved/dismissed items remain in history (never deleted).

const ACTIONS = {
  assign: null,
  start_review: "IN_REVIEW",
  defer: "DEFERRED",
  resolve: "RESOLVED",
  dismiss: "DISMISSED",
  reopen: "OPEN",
} as const;
type Action = keyof typeof ACTIONS;

export async function PATCH(req: Request, { params }: { params: { caseId: string; itemId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.edit");
    await requireCase(ctx, params.caseId);

    const body = (await req.json().catch(() => ({}))) as { action?: Action; note?: string; assignedUserId?: string | null };
    const action = body.action;
    if (!action || !(action in ACTIONS)) return ok({ error: "Unknown action." }, 400);

    const item = await prisma.attentionItem.findFirst({ where: { id: params.itemId, caseId: params.caseId, firmId: ctx.firm.id } });
    if (!item) return ok({ error: "Attention item not found." }, 404);

    // Dismiss requires a reason (§3 "Dismiss with reason").
    if (action === "dismiss" && !body.note?.trim()) return ok({ error: "A reason is required to dismiss an item." }, 400);

    // Assignment must be to a member of the firm.
    if (action === "assign") {
      if (body.assignedUserId) {
        const member = await prisma.user.findFirst({ where: { id: body.assignedUserId, firmId: ctx.firm.id } });
        if (!member) return ok({ error: "Assignee must be a member of your firm." }, 400);
      }
      const updated = await prisma.attentionItem.update({ where: { id: item.id }, data: { assignedUserId: body.assignedUserId ?? null } });
      await audit(ctx, "attention.assign", { type: "attentionItem", id: item.id, caseId: params.caseId, meta: { assignedUserId: body.assignedUserId ?? null } });
      return ok({ item: updated });
    }

    const to = ACTIONS[action] as Exclude<(typeof ACTIONS)[Action], null>;
    const terminal = to === "RESOLVED" || to === "DISMISSED";
    const updated = await prisma.attentionItem.update({
      where: { id: item.id },
      data: {
        status: to,
        resolutionNote: body.note?.trim() || item.resolutionNote,
        resolvedAt: terminal ? new Date() : action === "reopen" ? null : item.resolvedAt,
      },
    });
    await audit(ctx, `attention.${action}`, { type: "attentionItem", id: item.id, caseId: params.caseId, meta: { from: item.status, to, note: body.note ?? null } });
    return ok({ item: updated });
  } catch (err) {
    return handleError(err);
  }
}
