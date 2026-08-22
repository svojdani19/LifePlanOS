import { requireApiContext, requireCanonicalPermission } from "@/lib/tenant";
import { listCandidates } from "@/lib/learning/candidateService";
import { ok, handleError } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// The learning approval queue.
//
// Until now the learning loop had no route at all: candidates were promoted and
// evaluated by server code, and a passing evaluation wrote ADOPTED directly. A
// lesson began shaping every future case in the firm without anyone being able
// to see the queue, let alone approve or refuse an entry.
//
// Firm-scoped by construction — listCandidates takes firmId as a parameter, so
// there is no call shape that reads another tenant's lessons.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  try {
    const ctx = await requireApiContext();
    requireCanonicalPermission(ctx, "learning.view");

    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? undefined;
    const approvalClass = url.searchParams.get("class") ?? undefined;
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

    const candidates = await listCandidates(ctx.firm.id, { status, approvalClass, limit });
    return ok({ candidates });
  } catch (err) {
    return handleError(err);
  }
}
