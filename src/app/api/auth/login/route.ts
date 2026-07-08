import { headers } from "next/headers";
import { z } from "zod";
import { authenticate } from "@/lib/auth/service";
import { createSession } from "@/lib/auth/session";
import { ok, handleError } from "@/lib/api";
import { prisma } from "@/lib/db";

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(req: Request) {
  try {
    const { email, password } = schema.parse(await req.json());
    const user = await authenticate(email, password);
    if (!user) {
      return ok({ error: "Invalid email or password." }, 401);
    }
    const h = headers();
    await createSession(user.id, { userAgent: h.get("user-agent"), ip: h.get("x-forwarded-for") });
    await prisma.auditLog.create({
      data: { firmId: user.firmId, userId: user.id, action: "auth.login" },
    });
    return ok({ id: user.id });
  } catch (err) {
    return handleError(err);
  }
}
