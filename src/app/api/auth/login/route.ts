import { headers } from "next/headers";
import { z } from "zod";
import { authenticate } from "@/lib/auth/service";
import { createSession } from "@/lib/auth/session";
import { loginAllowed, recordLoginAttempt } from "@/lib/auth/rateLimit";
import { verifyTotp, hashCode } from "@/lib/auth/totp";
import { Prisma } from "@/generated/prisma";
import { ok, handleError } from "@/lib/api";
import { prisma } from "@/lib/db";

const schema = z.object({ email: z.string().email(), password: z.string().min(1), totp: z.string().optional() });

export async function POST(req: Request) {
  try {
    const { email, password, totp } = schema.parse(await req.json());
    const h = await headers();
    const ip = h.get("x-forwarded-for");

    if (!(await loginAllowed(ip, email))) {
      return ok({ error: "Too many failed attempts. Please wait a few minutes and try again." }, 429);
    }

    const user = await authenticate(email, password);
    if (!user) {
      await recordLoginAttempt(ip, email, false);
      return ok({ error: "Invalid email or password." }, 401);
    }

    // Second factor (TOTP or a one-time backup code) when enabled.
    if (user.mfaEnabled) {
      const t = (totp ?? "").trim();
      const hashes = Array.isArray(user.mfaBackupCodes) ? (user.mfaBackupCodes as string[]) : [];
      const validTotp = !!t && !!user.totpSecret && verifyTotp(user.totpSecret, t);
      const backupIdx = t ? hashes.indexOf(hashCode(t)) : -1;
      if (!validTotp && backupIdx < 0) {
        await recordLoginAttempt(ip, email, false);
        return ok({ error: t ? "Invalid two-factor code." : "Two-factor code required.", mfaRequired: true }, 401);
      }
      if (backupIdx >= 0) {
        // Consume the used backup code.
        hashes.splice(backupIdx, 1);
        await prisma.user.update({ where: { id: user.id }, data: { mfaBackupCodes: hashes as unknown as Prisma.InputJsonValue } });
      }
    }

    await recordLoginAttempt(ip, email, true);
    await createSession(user.id, { userAgent: h.get("user-agent"), ip });
    await prisma.auditLog.create({
      data: { firmId: user.firmId, userId: user.id, action: "auth.login" },
    });
    const assignment = await prisma.userRoleAssignment.findFirst({
      where: { userId: user.id, firmId: user.firmId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { builtInRole: true },
    });
    const { workspaceHrefForRole } = await import("@/lib/workspaces");
    return ok({ id: user.id, redirectTo: workspaceHrefForRole(user.preferredWorkspace ?? assignment?.builtInRole) });
  } catch (err) {
    return handleError(err);
  }
}
