import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";
import { AdminServiceError, bumpAuthzRevision } from "@/lib/authz/adminService";

// ─────────────────────────────────────────────────────────────────────────────
// Credential verification workflow (docs/26 Phase 3). Only team managers may
// change a credential's status/category; marking ORG_VERIFIED stamps the
// verifier (ctx.user) and time — honest labeling: this records that the FIRM
// reviewed the document, not an independent licensure check. Credential state
// feeds authorize() step 4, so every change bumps the authz revision.
// ─────────────────────────────────────────────────────────────────────────────

const patchSchema = z.object({
  credentialId: z.string().min(1),
  status: z.enum(["SELF_REPORTED", "PENDING", "ORG_VERIFIED", "EXTERNALLY_VERIFIED", "EXPIRED", "SUSPENDED"]),
  category: z.enum(["PHYSICIAN", "RN", "CLCP", "VOCATIONAL", "ECONOMIST", "OTHER"]).optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  jurisdiction: z.string().max(120).nullable().optional(),
});

export async function PATCH(req: Request) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "team.manage");
    const input = patchSchema.parse(await req.json());

    const credential = await prisma.userCredential.findFirst({
      where: { id: input.credentialId, firmId: ctx.firm.id },
    });
    if (!credential) return ok({ error: "Credential not found" }, 404);

    const updated = await prisma.userCredential.update({
      where: { id: credential.id },
      data: {
        status: input.status,
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        ...(input.jurisdiction !== undefined ? { jurisdiction: input.jurisdiction } : {}),
        // The verifier is always the acting user — never client-supplied.
        ...(input.status === "ORG_VERIFIED"
          ? { verifiedById: ctx.user.id, verifiedAt: new Date() }
          : {}),
      },
    });
    await bumpAuthzRevision(ctx.firm.id);
    await audit(ctx, "credential.status", {
      type: "userCredential",
      id: credential.id,
      meta: {
        userId: credential.userId,
        from: credential.status,
        to: input.status,
        category: updated.category,
      },
    });
    return ok({ credential: updated });
  } catch (err) {
    if (err instanceof AdminServiceError) return ok({ error: err.message, code: err.code }, err.status);
    return handleError(err);
  }
}
