import { z } from "zod";
import { acceptInvite } from "@/lib/auth/service";
import { createSession } from "@/lib/auth/session";
import { ok, handleError } from "@/lib/api";
import { prisma } from "@/lib/db";

const schema = z.object({ token: z.string().min(1), password: z.string().min(8) });

export async function POST(req: Request) {
  try {
    const { token, password } = schema.parse(await req.json());
    const user = await acceptInvite(token, password);
    await createSession(user.id);
    await prisma.auditLog.create({ data: { firmId: user.firmId, userId: user.id, action: "seat.accept" } });
    return ok({ id: user.id });
  } catch (err) {
    return handleError(err);
  }
}
