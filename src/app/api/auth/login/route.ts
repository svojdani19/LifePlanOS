import { headers } from "next/headers";
import { z } from "zod";
import { authenticate } from "@/lib/auth/service";
import { createSession } from "@/lib/auth/session";
import { loginAllowed, recordLoginAttempt } from "@/lib/auth/rateLimit";
import { ok, handleError } from "@/lib/api";
import { prisma } from "@/lib/db";

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(req: Request) {
  try {
    const { email, password } = schema.parse(await req.json());
    const h = headers();
    const ip = h.get("x-forwarded-for");

    if (!(await loginAllowed(ip))) {
      return ok({ error: "Too many failed attempts. Please wait a few minutes and try again." }, 429);
    }

    const user = await authenticate(email, password);
    await recordLoginAttempt(ip, email, !!user);
    if (!user) {
      return ok({ error: "Invalid email or password." }, 401);
    }
    await createSession(user.id, { userAgent: h.get("user-agent"), ip });
    await prisma.auditLog.create({
      data: { firmId: user.firmId, userId: user.id, action: "auth.login" },
    });
    return ok({ id: user.id });
  } catch (err) {
    return handleError(err);
  }
}
