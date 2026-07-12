import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, assertSeatCapacity, audit } from "@/lib/tenant";
import { inviteTeammate } from "@/lib/auth/service";
import { ok, handleError } from "@/lib/api";

export async function GET() {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    const users = await prisma.user.findMany({
      where: { firmId: ctx.firm.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        lastLoginAt: true,
        inviteToken: true,
        createdAt: true,
        credentialSummary: true,
      },
    });
    return ok({ users });
  } catch (err) {
    return handleError(err);
  }
}

const inviteSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  role: z.enum(["ADMIN", "PLANNER", "PHYSICIAN_REVIEWER", "ATTORNEY_REVIEWER", "PARALEGAL", "BILLING_USER"]),
});

export async function POST(req: Request) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    await assertSeatCapacity(ctx);
    const input = inviteSchema.parse(await req.json());
    const user = await inviteTeammate(ctx.firm.id, ctx.user.id, input);
    await audit(ctx, "seat.invite", { type: "user", id: user.id, meta: { email: user.email, role: user.role } });
    // In production the invite link is emailed; here we return it for the demo.
    return ok({ user: { id: user.id, email: user.email }, inviteToken: user.inviteToken });
  } catch (err) {
    return handleError(err);
  }
}
