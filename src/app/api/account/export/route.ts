import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, audit } from "@/lib/tenant";
import { handleError } from "@/lib/api";

// Full firm data export (JSON) — supports the HIPAA right of access / portability.
// Scoped to the caller's firm; secrets (password hashes, TOTP secrets, session
// tokens, backup codes) are never included. Admin-only and audited.
export async function GET() {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "firm.settings");

    const firm = await prisma.firm.findUnique({
      where: { id: ctx.firm.id },
      include: {
        subscription: true,
        users: { select: { id: true, email: true, name: true, role: true, status: true, mfaEnabled: true, lastLoginAt: true, createdAt: true } },
        precedents: true,
        cases: {
          include: {
            documents: { select: { id: true, filename: true, type: true, serviceDate: true, authorName: true, authorRole: true, facility: true, pageCount: true, createdAt: true } },
            chronologyEvents: true,
            conditions: true,
            futureCareItems: true,
            reviewFindings: true,
            reports: { select: { id: true, format: true, template: true, createdAt: true } },
          },
        },
      },
    });

    await audit(ctx, "account.export", { type: "firm", id: ctx.firm.id, meta: { cases: firm?.cases.length ?? 0 } });

    const payload = { exportedAt: new Date().toISOString(), firmId: ctx.firm.id, data: firm };
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="lifeplanos-export-${stamp}.json"`,
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
