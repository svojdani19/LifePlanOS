import { headers } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { createSession } from "@/lib/auth/session";
import { ok, handleError } from "@/lib/api";
import { demoModeEnabled, demoPersonaByEmail, DEMO_FIRM_SLUG } from "@/lib/demo/config";
import { workspaceHrefForRole } from "@/lib/workspaces";

// One-click demo login (docs/28 §6). No password: the demo gate + the fixed
// persona roster ARE the authorization. Only persona emails are accepted, and
// the user must belong to the demo firm (Firm.isDemo), so this route can never
// mint a session for a real tenant. Session mechanics are the real login's
// (createSession — opaque token, hashed in the DB, httpOnly cookie).

const schema = z.object({ email: z.string().email() });

export async function POST(req: Request) {
  try {
    if (!demoModeEnabled()) return ok({ error: "Not found." }, 404);

    const { email } = schema.parse(await req.json());
    const persona = demoPersonaByEmail(email);
    if (!persona) return ok({ error: "Not found." }, 404);

    const user = await prisma.user.findUnique({
      where: { email: persona.email },
      include: { firm: { select: { slug: true, isDemo: true } } },
    });
    if (!user || user.status !== "ACTIVE" || !user.firm.isDemo || user.firm.slug !== DEMO_FIRM_SLUG) {
      return ok({ error: "Demo environment is not seeded. Run: npx tsx scripts/demo-seed.ts" }, 409);
    }

    const h = await headers();
    await createSession(user.id, { userAgent: h.get("user-agent"), ip: h.get("x-forwarded-for") });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await prisma.auditLog.create({
      data: { firmId: user.firmId, userId: user.id, action: "auth.demo_login", meta: { persona: persona.email } },
    });

    return ok({
      id: user.id,
      redirect: workspaceHrefForRole(user.preferredWorkspace ?? persona.preferredWorkspace),
    });
  } catch (err) {
    return handleError(err);
  }
}
