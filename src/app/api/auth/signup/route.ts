import { headers } from "next/headers";
import { z } from "zod";
import { signupFirm } from "@/lib/auth/service";
import { createSession } from "@/lib/auth/session";
import { ok, handleError } from "@/lib/api";
import { prisma } from "@/lib/db";

const schema = z.object({
  firmName: z.string().min(2),
  adminName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  tier: z.enum(["SOLO", "SMALL_FIRM", "ENTERPRISE"]).optional(),
  state: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const user = await signupFirm(body);
    const h = headers();
    await createSession(user.id, { userAgent: h.get("user-agent"), ip: h.get("x-forwarded-for") });
    await prisma.auditLog.create({
      data: { firmId: user.firmId, userId: user.id, action: "firm.signup", targetType: "firm", targetId: user.firmId },
    });
    return ok({ id: user.id, email: user.email });
  } catch (err) {
    return handleError(err);
  }
}
