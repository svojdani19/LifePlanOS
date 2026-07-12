import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, audit, TenantError } from "@/lib/tenant";
import { putObject } from "@/lib/storage";
import { ok, handleError } from "@/lib/api";

// Reviewer credentials (EPIC-011). Available for medical-personnel seats only.
const MEDICAL_ROLES = new Set(["ADMIN", "PLANNER", "PHYSICIAN_REVIEWER"]);

async function authorize(userId: string) {
  const ctx = await requireApiContext();
  const target = await prisma.user.findFirst({ where: { id: userId, firmId: ctx.firm.id } });
  if (!target) throw new TenantError("User not found", "FORBIDDEN", 404);
  // The seat owner may manage their own credentials; else team.manage is required.
  if (target.id !== ctx.user.id) requirePermission(ctx, "team.manage");
  if (!MEDICAL_ROLES.has(target.role)) throw new TenantError("Credentials apply to medical-personnel seats only.", "FORBIDDEN", 400);
  return { ctx, target };
}

export async function GET(_req: Request, { params }: { params: { userId: string } }) {
  try {
    const { ctx } = await authorize(params.userId);
    const credentials = await prisma.userCredential.findMany({
      where: { userId: params.userId, firmId: ctx.firm.id },
      select: { id: true, type: true, label: true, filename: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    return ok({ credentials });
  } catch (err) {
    return handleError(err);
  }
}

const metaSchema = z.object({ type: z.enum(["BOARD_CERTIFICATION", "CV", "LICENSE", "OTHER"]).default("OTHER"), label: z.string().max(160).optional() });
export async function POST(req: Request, { params }: { params: { userId: string } }) {
  try {
    const { ctx } = await authorize(params.userId);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return ok({ error: "No file provided" }, 400);
    const meta = metaSchema.parse({ type: form.get("type") ?? "OTHER", label: form.get("label") ?? undefined });
    const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
    const storageKey = await putObject(Buffer.from(await file.arrayBuffer()), ext);
    const cred = await prisma.userCredential.create({
      data: { userId: params.userId, firmId: ctx.firm.id, type: meta.type, label: meta.label, filename: file.name, storageKey, createdById: ctx.user.id },
    });
    await audit(ctx, "credential.upload", { type: "userCredential", id: cred.id, meta: { userId: params.userId, credType: meta.type } });
    return ok({ credential: { id: cred.id, type: cred.type, label: cred.label, filename: cred.filename, createdAt: cred.createdAt } });
  } catch (err) {
    return handleError(err);
  }
}
