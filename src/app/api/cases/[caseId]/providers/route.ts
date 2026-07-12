import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { extractProviders, newSuggestions, normalizeProviderName, type DocForRoster, type ChronoForRoster } from "@/lib/engine/providerRoster";
import { ok, handleError } from "@/lib/api";

// Treating-provider roster (EPIC-011). GET returns the curated roster and, when
// ?refresh=1, first seeds any NEW providers parsed from the records. POST adds a
// user-entered provider.
export async function GET(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);

    if (new URL(req.url).searchParams.get("refresh") === "1") {
      const [docs, chrono, existing] = await Promise.all([
        prisma.document.findMany({ where: { caseId: params.caseId }, select: { id: true, filename: true, authorName: true, authorCredentials: true, authorRole: true, facility: true, providers: true } }),
        prisma.chronologyEvent.findMany({ where: { caseId: params.caseId }, select: { provider: true, facility: true, sourcePage: true, sourceDocumentId: true } }),
        prisma.treatingProvider.findMany({ where: { caseId: params.caseId }, select: { nameKey: true } }),
      ]);
      const extracted = extractProviders(docs as DocForRoster[], chrono as ChronoForRoster[]);
      const toAdd = newSuggestions(extracted, new Set(existing.map((e) => e.nameKey)));
      if (toAdd.length) {
        await prisma.treatingProvider.createMany({
          data: toAdd.map((p) => ({ caseId: params.caseId, firmId: ctx.firm.id, name: p.name, nameKey: p.nameKey, credentials: p.credentials, specialty: p.specialty, facility: p.facility, sourceDocumentIds: p.sourceDocumentIds as never, status: "SUGGESTED" as const })),
        });
      }
    }
    const providers = await prisma.treatingProvider.findMany({
      where: { caseId: params.caseId, firmId: ctx.firm.id },
      include: { interviewFindings: { orderBy: { createdAt: "asc" } } },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    });
    return ok({ providers });
  } catch (err) {
    return handleError(err);
  }
}

const addSchema = z.object({ name: z.string().min(2), credentials: z.string().optional(), specialty: z.string().optional(), facility: z.string().optional(), contact: z.string().optional() });
export async function POST(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.edit");
    await requireCase(ctx, params.caseId);
    const input = addSchema.parse(await req.json());
    const provider = await prisma.treatingProvider.create({
      data: { caseId: params.caseId, firmId: ctx.firm.id, name: input.name, nameKey: normalizeProviderName(input.name), credentials: input.credentials, specialty: input.specialty, facility: input.facility, contact: input.contact, status: "CONFIRMED", addedById: ctx.user.id },
    });
    await audit(ctx, "provider.add", { type: "treatingProvider", id: provider.id, caseId: params.caseId });
    return ok({ provider });
  } catch (err) {
    return handleError(err);
  }
}
