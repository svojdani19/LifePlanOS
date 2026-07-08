import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import type { PlanTier, UserRole } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Account lifecycle: firm signup, login, teammate invitation & acceptance.
// Every new firm starts on a 14-day TRIALING subscription of the chosen tier.
// ─────────────────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "firm"
  );
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  let n = 1;
  while (await prisma.firm.findUnique({ where: { slug } })) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

export interface SignupInput {
  firmName: string;
  adminName: string;
  email: string;
  password: string;
  tier?: PlanTier;
  state?: string;
}

export async function signupFirm(input: SignupInput) {
  const email = input.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new Error("An account with that email already exists.");
  }

  const slug = await uniqueSlug(slugify(input.firmName));
  const passwordHash = await hashPassword(input.password);
  const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  const firm = await prisma.firm.create({
    data: {
      name: input.firmName.trim(),
      slug,
      state: input.state?.trim() || null,
      subscription: {
        create: {
          tier: input.tier ?? "SOLO",
          status: "TRIALING",
          trialEndsAt,
        },
      },
      users: {
        create: {
          email,
          name: input.adminName.trim(),
          role: "ADMIN",
          status: "ACTIVE",
          passwordHash,
        },
      },
    },
    include: { users: true },
  });

  return firm.users[0];
}

export async function authenticate(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user || user.status === "SUSPENDED") return null;
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return null;
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return user;
}

export async function inviteTeammate(
  firmId: string,
  invitedById: string,
  input: { email: string; name: string; role: UserRole },
) {
  const email = input.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new Error("That email is already in use.");

  const inviteToken = randomBytes(24).toString("hex");
  const inviteExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  return prisma.user.create({
    data: {
      firmId,
      email,
      name: input.name.trim(),
      role: input.role,
      status: "INVITED",
      invitedById,
      inviteToken,
      inviteExpiresAt,
    },
  });
}

export async function acceptInvite(token: string, password: string) {
  const user = await prisma.user.findUnique({ where: { inviteToken: token } });
  if (!user || user.status !== "INVITED") throw new Error("Invalid or expired invitation.");
  if (user.inviteExpiresAt && user.inviteExpiresAt.getTime() < Date.now()) {
    throw new Error("This invitation has expired.");
  }
  const passwordHash = await hashPassword(password);
  return prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, status: "ACTIVE", inviteToken: null, inviteExpiresAt: null },
  });
}
