import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, audit } from "@/lib/tenant";
import { generateSecret, otpauthUri, verifyTotp, generateBackupCodes, hashCode } from "@/lib/auth/totp";
import { Prisma } from "@/generated/prisma";
import { ok, handleError } from "@/lib/api";

const schema = z.object({ action: z.enum(["setup", "enable", "disable"]), code: z.string().optional() });

// Per-user TOTP two-factor management.
export async function POST(req: Request) {
  try {
    const ctx = await requireApiContext();
    const user = ctx.user;
    const { action, code } = schema.parse(await req.json());

    if (action === "setup") {
      const secret = generateSecret();
      await prisma.user.update({ where: { id: user.id }, data: { totpSecret: secret, mfaEnabled: false } });
      return ok({ secret, otpauthUri: otpauthUri(secret, user.email) });
    }

    if (action === "enable") {
      if (!user.totpSecret) return ok({ error: "Start two-factor setup first." }, 400);
      if (!code || !verifyTotp(user.totpSecret, code)) return ok({ error: "That code didn't match. Check your authenticator and try again." }, 400);
      const { codes, hashes } = generateBackupCodes();
      await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true, mfaBackupCodes: hashes as unknown as Prisma.InputJsonValue } });
      await audit(ctx, "auth.mfa_enabled", { type: "user", id: user.id });
      return ok({ enabled: true, backupCodes: codes });
    }

    // disable
    if (user.mfaEnabled) {
      const hashes = Array.isArray(user.mfaBackupCodes) ? (user.mfaBackupCodes as string[]) : [];
      const validTotp = !!code && !!user.totpSecret && verifyTotp(user.totpSecret, code);
      const validBackup = !!code && hashes.includes(hashCode(code));
      if (!validTotp && !validBackup) return ok({ error: "Enter a valid authenticator or backup code to turn off two-factor." }, 400);
    }
    await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: false, totpSecret: null, mfaBackupCodes: Prisma.DbNull } });
    await audit(ctx, "auth.mfa_disabled", { type: "user", id: user.id });
    return ok({ disabled: true });
  } catch (err) {
    return handleError(err);
  }
}
