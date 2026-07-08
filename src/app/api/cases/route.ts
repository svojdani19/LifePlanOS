import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  requireApiContext,
  requirePermission,
  assertCaseCapacity,
  audit,
  recordUsage,
} from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";

const createSchema = z.object({
  clientName: z.string().min(1),
  caseType: z.enum(["PERSONAL_INJURY", "MED_MAL", "WORKERS_COMP", "PRODUCT_LIABILITY", "CATASTROPHIC"]).optional(),
  side: z.enum(["PLAINTIFF", "DEFENSE", "NEUTRAL"]).optional(),
  jurisdiction: z.string().optional(),
  dateOfInjury: z.string().optional(),
  mechanism: z.string().optional(),
  diagnosis: z.string().optional(),
});

// Cases are always scoped to the caller's firm — the client can never pass firmId.
export async function GET() {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    const cases = await prisma.case.findMany({
      where: { firmId: ctx.firm.id },
      orderBy: { updatedAt: "desc" },
      include: { createdBy: { select: { name: true } } },
    });
    return ok({ cases });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.create");
    await assertCaseCapacity(ctx); // enforces the plan's active-case limit

    const input = createSchema.parse(await req.json());

    // Per-firm sequential case number.
    const year = new Date().getUTCFullYear();
    const count = await prisma.case.count({ where: { firmId: ctx.firm.id } });
    const caseNumber = `LCP-${year}-${String(count + 1).padStart(4, "0")}`;

    const created = await prisma.case.create({
      data: {
        firmId: ctx.firm.id,
        createdById: ctx.user.id,
        caseNumber,
        clientName: input.clientName,
        caseType: input.caseType ?? "PERSONAL_INJURY",
        side: input.side ?? "PLAINTIFF",
        jurisdiction: input.jurisdiction,
        dateOfInjury: input.dateOfInjury ? new Date(input.dateOfInjury) : null,
        mechanism: input.mechanism,
        diagnosis: input.diagnosis,
      },
    });

    await recordUsage(ctx, "CASE_CREATED", { caseId: created.id });
    await audit(ctx, "case.create", { type: "case", id: created.id, caseId: created.id, meta: { caseNumber } });

    return ok({ case: created });
  } catch (err) {
    return handleError(err);
  }
}
