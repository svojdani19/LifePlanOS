import { prisma } from "@/lib/db";

// ─────────────────────────────────────────────────────────────────────────────
// Login rate limiting. Backed by the LoginAttempt table (serverless-safe, unlike
// an in-memory counter). If an IP accumulates too many failures inside the
// window, further attempts are blocked until the window rolls forward.
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = Number(process.env.LOGIN_MAX_FAILURES ?? 10);

/** Returns true when the request may proceed (not rate-limited). */
export async function loginAllowed(ip: string | null | undefined): Promise<boolean> {
  if (!ip) return true; // cannot identify the caller → do not lock everyone out
  const since = new Date(Date.now() - WINDOW_MS);
  const failures = await prisma.loginAttempt.count({ where: { ip, success: false, createdAt: { gte: since } } });
  return failures < MAX_FAILURES;
}

export async function recordLoginAttempt(ip: string | null | undefined, email: string | null | undefined, success: boolean): Promise<void> {
  await prisma.loginAttempt.create({ data: { ip: ip ?? undefined, email: email ?? undefined, success } }).catch(() => {});
}
