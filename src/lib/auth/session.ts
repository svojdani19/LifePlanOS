import { randomBytes, createHash } from "crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";

// ─────────────────────────────────────────────────────────────────────────────
// Session management. A random opaque token lives in an httpOnly cookie; only
// its SHA-256 hash is stored in the DB, so a database leak cannot be replayed as
// a live session. This module is the single seam to swap for NextAuth/Clerk/SSO.
// ─────────────────────────────────────────────────────────────────────────────

export const SESSION_COOKIE = "lpos_session";
const SESSION_TTL_DAYS = 14;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function createSession(
  userId: string,
  ctx?: { userAgent?: string | null; ip?: string | null },
): Promise<void> {
  const raw = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(raw),
      expiresAt,
      userAgent: ctx?.userAgent ?? undefined,
      ip: ctx?.ip ?? undefined,
    },
  });

  cookies().set(SESSION_COOKIE, raw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Returns the userId for a valid, unexpired session, or null. */
export async function readSession(): Promise<string | null> {
  const raw = cookies().get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(raw) } });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return session.userId;
}

export async function destroySession(): Promise<void> {
  const raw = cookies().get(SESSION_COOKIE)?.value;
  if (raw) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(raw) } }).catch(() => {});
  }
  cookies().delete(SESSION_COOKIE);
}
