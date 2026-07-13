import { requireApiContext, requirePermission, requireCase } from "@/lib/tenant";
import { syncAttention, answerCaseQuestion, type AnswerItem } from "@/lib/engine/attention";
import { ok, handleError } from "@/lib/api";

// Case-specific review Q&A. Answers ONLY from the current case's structured
// findings + readiness (never fabricates, never approves). Deterministic; an LLM
// rephrasing layer can sit behind this once credentialed + BAA-acknowledged.

export async function POST(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const body = (await req.json().catch(() => ({}))) as { question?: string };
    const question = (body.question ?? "").trim();
    if (!question) return ok({ error: "Ask a question about this case." }, 400);

    const { active, readiness, counts } = await syncAttention(params.caseId, ctx.firm.id, ctx.user.id);
    const answerItems: AnswerItem[] = active.map((i) => ({
      severity: i.severity as AnswerItem["severity"], category: i.category, title: i.title, summary: i.summary,
      suggestedAction: i.suggestedAction, exportBlocking: i.exportBlocking, entityType: i.entityType, entityId: i.entityId,
    }));
    const answer = answerCaseQuestion(question, { active: answerItems, readiness, counts });
    return ok({ question, ...answer });
  } catch (err) {
    return handleError(err);
  }
}
