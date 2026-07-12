import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase } from "@/lib/tenant";
import { diffSnapshots, type SnapshotPayload } from "@/lib/engine/snapshot";
import { ok, handleError } from "@/lib/api";

// Case version snapshots (P3). GET lists the captured versions; with ?a=&b=
// (version numbers) it also returns the structured diff between the two.
export async function GET(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const snapshots = await prisma.caseSnapshot.findMany({
      where: { caseId: params.caseId, firmId: ctx.firm.id },
      orderBy: { version: "asc" },
      select: { id: true, version: true, createdAt: true, reportExportId: true },
    });
    const url = new URL(req.url);
    const a = url.searchParams.get("a");
    const b = url.searchParams.get("b");
    let diff = null;
    if (a && b) {
      const [sa, sb] = await Promise.all([
        prisma.caseSnapshot.findUnique({ where: { caseId_version: { caseId: params.caseId, version: Number(a) } } }),
        prisma.caseSnapshot.findUnique({ where: { caseId_version: { caseId: params.caseId, version: Number(b) } } }),
      ]);
      if (sa && sb) diff = diffSnapshots(sa.payload as unknown as SnapshotPayload, sb.payload as unknown as SnapshotPayload);
    }
    return ok({ snapshots, diff });
  } catch (err) {
    return handleError(err);
  }
}
