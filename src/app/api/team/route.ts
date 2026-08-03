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
    // Affiliated clients per member: cases they created, prepare as physician,
    // hold a case-scoped assignment on, or are a named engagement assignee for.
    const userIds = users.map((u) => u.id);
    const [cases, grants, engagements] = await Promise.all([
      prisma.case.findMany({
        where: { firmId: ctx.firm.id, status: { notIn: ["ARCHIVED"] } },
        select: { id: true, clientName: true, createdById: true, preparingPhysicianId: true },
      }),
      prisma.userRoleAssignment.findMany({
        where: { firmId: ctx.firm.id, userId: { in: userIds }, status: "ACTIVE", caseId: { not: null } },
        select: { userId: true, caseId: true },
      }),
      prisma.caseEngagement.findMany({
        where: { firmId: ctx.firm.id, status: { notIn: ["CANCELLED"] } },
        select: { caseId: true, assignedPlannerId: true, assignedPhysicianId: true, assignedVocationalExpertId: true, assignedEconomistId: true, assignedQaReviewerId: true },
      }),
    ]);
    const clientByCase = new Map(cases.map((c) => [c.id, c.clientName]));
    const clientsByUser = new Map<string, Set<string>>();
    const affiliate = (userId: string | null | undefined, caseId: string) => {
      if (!userId || !clientByCase.has(caseId)) return;
      const set = clientsByUser.get(userId) ?? new Set<string>();
      set.add(clientByCase.get(caseId)!);
      clientsByUser.set(userId, set);
    };
    for (const c of cases) { affiliate(c.createdById, c.id); affiliate(c.preparingPhysicianId, c.id); }
    for (const g of grants) affiliate(g.userId, g.caseId!);
    for (const e of engagements) {
      affiliate(e.assignedPlannerId, e.caseId);
      affiliate(e.assignedPhysicianId, e.caseId);
      affiliate(e.assignedVocationalExpertId, e.caseId);
      affiliate(e.assignedEconomistId, e.caseId);
      affiliate(e.assignedQaReviewerId, e.caseId);
    }
    return ok({ users: users.map((u) => ({ ...u, clients: Array.from(clientsByUser.get(u.id) ?? []).sort() })) });
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
