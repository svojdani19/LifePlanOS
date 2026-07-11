import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, requireCase, audit } from "@/lib/tenant";
import { ok, handleError } from "@/lib/api";
import { extractText } from "@/lib/documents/extract";
import { extractGuidelineQuote, recomputeSocForCase } from "@/lib/engine/standardOfCare";

// User-supplied Standard-of-Care input: a free-text note, or an added source
// (pasted citation/passage or an uploaded article). Sources become cited
// guidance; notes join the evidence corpus. Adding one recomputes the
// assessment for the case (no network — reuses the located guidance).

const bodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), conditionName: z.string().min(1), text: z.string().min(1).max(4000) }),
  z.object({ kind: z.literal("source"), conditionName: z.string().min(1), text: z.string().min(1).max(6000), title: z.string().max(300).optional(), url: z.string().max(500).optional() }),
]);

// Trim a pasted passage to the sentence(s) pertinent to the condition.
function sourceQuote(text: string, conditionName: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 500) return clean;
  const q = extractGuidelineQuote(clean, conditionName, 480);
  return q?.quote ?? clean.slice(0, 479).trimEnd() + "…";
}

export async function GET(_req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    await requireCase(ctx, params.caseId);
    const inputs = await prisma.socUserInput.findMany({ where: { caseId: params.caseId }, orderBy: { createdAt: "asc" } });
    return ok({ inputs });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, { params }: { params: { caseId: string } }) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.edit");
    await requireCase(ctx, params.caseId);

    let data: { conditionName: string; kind: string; text: string; title?: string | null; url?: string | null; filename?: string | null };

    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      // Uploaded article → extract its text and lift the pertinent passage.
      const form = await req.formData();
      const conditionName = String(form.get("conditionName") ?? "").trim();
      const title = form.get("title") ? String(form.get("title")) : undefined;
      const file = form.get("file");
      if (!conditionName || !(file instanceof File)) return ok({ error: "conditionName and file are required." }, 400);
      const buffer = Buffer.from(await file.arrayBuffer());
      const ex = await extractText(buffer, file.type, file.name);
      if (!ex.text || ex.text.trim().length < 80) {
        return ok({ error: "Could not read text from that file (it may be a scan). Paste the relevant passage instead." }, 422);
      }
      data = { conditionName, kind: "source", text: sourceQuote(ex.text, conditionName), title: title || file.name, filename: file.name };
    } else {
      const parsed = bodySchema.parse(await req.json());
      data =
        parsed.kind === "note"
          ? { conditionName: parsed.conditionName, kind: "note", text: parsed.text.trim() }
          : { conditionName: parsed.conditionName, kind: "source", text: sourceQuote(parsed.text, parsed.conditionName), title: parsed.title || "Reviewer-added source", url: parsed.url };
    }

    const created = await prisma.socUserInput.create({
      data: { caseId: params.caseId, addedById: ctx.user.id, ...data },
    });
    // Fold the new input into the analysis (no network).
    await recomputeSocForCase(params.caseId).catch(() => {});
    await audit(ctx, "soc.input.add", { type: "socUserInput", id: created.id, caseId: params.caseId, meta: { kind: data.kind } });
    return ok({ input: created });
  } catch (err) {
    return handleError(err);
  }
}
