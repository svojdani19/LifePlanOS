import { z } from "zod";
import { ok, handleError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { setSessionSupportFirm } from "@/lib/auth/session";
import { requirePlatformAdmin } from "@/lib/authz/platform";
import { audit, requireApiContext, TenantError } from "@/lib/tenant";

const schema = z.object({ firmId: z.string().uuid().nullable() });

/** Select or clear a server-side, read-only target-tenant support context. */
export async function POST(req: Request) {
  try {
    const ctx = await requireApiContext();
    await requirePlatformAdmin(ctx);
    if (!ctx.sessionId) throw new TenantError("Session context is unavailable.", "FORBIDDEN", 403);

    const { firmId: requestedFirmId } = schema.parse(await req.json());
    const actorFirmId = ctx.actorFirmId ?? ctx.user.firmId;
    const targetFirmId = requestedFirmId === actorFirmId ? null : requestedFirmId;

    let targetName: string | null = null;
    if (targetFirmId) {
      const target = await prisma.firm.findUnique({ where: { id: targetFirmId }, select: { name: true } });
      if (!target) throw new TenantError("Organization not found.", "FORBIDDEN", 404);
      targetName = target.name;
    }

    await audit(ctx, targetFirmId ? "platform.support_context.enter" : "platform.support_context.exit", {
      type: "firm",
      id: targetFirmId ?? actorFirmId,
      meta: {
        actorFirmId,
        previousTargetFirmId: ctx.supportMode ? ctx.firm.id : null,
        targetFirmId,
        targetName,
        readOnly: true,
      },
    });
    await setSessionSupportFirm(ctx.sessionId, targetFirmId);

    return ok({
      supportMode: Boolean(targetFirmId),
      firmId: targetFirmId,
      firmName: targetName,
      redirect: targetFirmId ? "/dashboard" : "/platform-admin",
    });
  } catch (err) {
    return handleError(err);
  }
}
