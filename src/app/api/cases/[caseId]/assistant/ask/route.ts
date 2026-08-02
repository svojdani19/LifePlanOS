import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { syncAttention, answerCaseQuestion, type AnswerItem } from "@/lib/engine/attention";
import { providerInfo, LlmConfigError } from "@/lib/llm";
import { ok, handleError } from "@/lib/api";

// Case-specific review Q&A. Answers ONLY from the current case's structured
// findings + readiness (never fabricates, never approves). Deterministic; an LLM
// rephrasing layer can sit behind this once credentialed + BAA-acknowledged.

export async function POST(req: Request, { params: paramsPromise }: { params: Promise<{ caseId: string }> }) {
  const params = await paramsPromise;
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);

    // Resolve provider provenance up front. In production a misconfigured
    // provider is a hard error (never silent mock) → explicit 503, no PHI.
    let provider: { name: string; model: string | null };
    try {
      provider = providerInfo();
    } catch (err) {
      if (err instanceof LlmConfigError) {
        return ok({ error: "AI assistant unavailable: provider not configured" }, 503);
      }
      throw err;
    }

    const body = (await req.json().catch(() => ({}))) as { question?: string };
    const question = (body.question ?? "").trim();
    if (!question) return ok({ error: "Ask a question about this case." }, 400);

    const { active, readiness, counts } = await syncAttention(params.caseId, ctx.firm.id, ctx.user.id);
    const answerItems: AnswerItem[] = active.map((i) => ({
      severity: i.severity as AnswerItem["severity"], category: i.category, title: i.title, summary: i.summary,
      suggestedAction: i.suggestedAction, exportBlocking: i.exportBlocking, entityType: i.entityType, entityId: i.entityId,
    }));
    const answer = answerCaseQuestion(question, { active: answerItems, readiness, counts });
    await audit(ctx, "assistant.ask", {
      type: "case", id: params.caseId, caseId: params.caseId,
      meta: { provider: provider.name, model: provider.model },
    });
    return ok({ question, ...answer });
  } catch (err) {
    return handleError(err);
  }
}
