import { prisma } from "@/lib/db";
import { requireApiContext, requirePermission, audit } from "@/lib/tenant";
import { extractText } from "@/lib/documents/extract";
import { putObject } from "@/lib/storage";
import { SAMPLE_PRECEDENTS } from "@/lib/precedents/samples";
import { Prisma } from "@/generated/prisma";
import { ok, handleError } from "@/lib/api";

// Firm LCP precedent library. GET lists/searches; POST uploads a finalized LCP
// (multipart) or seeds the built-in sample library ({ sample: true }).
export async function GET(req: Request) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "case.view");
    const q = new URL(req.url).searchParams.get("q")?.trim();
    const where: Prisma.PrecedentPlanWhereInput = { firmId: ctx.firm.id };
    if (q) {
      where.OR = ["title", "diagnosis", "icd10Code", "jurisdiction", "mechanism", "clientRef", "outcome", "extractedText"].map((f) => ({
        [f]: { contains: q, mode: "insensitive" as const },
      }));
    }
    const precedents = await prisma.precedentPlan.findMany({ where, orderBy: { createdAt: "desc" } });
    return ok({ precedents });
  } catch (err) {
    return handleError(err);
  }
}

const num = (v: FormDataEntryValue | null) => { const n = Number(v); return v != null && v !== "" && !isNaN(n) ? n : null; };
const str = (v: FormDataEntryValue | null) => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function POST(req: Request) {
  try {
    const ctx = await requireApiContext();
    requirePermission(ctx, "precedents.manage");
    const contentType = req.headers.get("content-type") ?? "";

    // Seed the built-in sample precedent library.
    if (contentType.includes("application/json")) {
      const body = await req.json().catch(() => ({}));
      if (body?.sample) {
        const existing = new Set((await prisma.precedentPlan.findMany({ where: { firmId: ctx.firm.id }, select: { title: true } })).map((p) => p.title));
        const toCreate = SAMPLE_PRECEDENTS.filter((s) => !existing.has(s.title));
        if (toCreate.length) {
          await prisma.precedentPlan.createMany({
            data: toCreate.map((s) => ({
              firmId: ctx.firm.id, createdById: ctx.user.id, source: "upload",
              title: s.title, clientRef: s.clientRef, diagnosis: s.diagnosis, icd10Code: s.icd10Code,
              injurySpecialty: s.injurySpecialty, jurisdiction: s.jurisdiction, mechanism: s.mechanism,
              age: s.age, sex: s.sex, lifeExpectancyYears: s.lifeExpectancyYears, lifetimeCost: s.lifetimeCost, presentValue: s.presentValue,
              careCategories: s.careCategories as unknown as Prisma.InputJsonValue, outcome: s.outcome,
              filename: s.filename, extractedText: s.text,
            })),
          });
        }
        await audit(ctx, "precedents.seed", { type: "precedentPlan", meta: { count: toCreate.length } });
        return ok({ created: toCreate.length });
      }
      return ok({ error: "Unsupported request" }, 400);
    }

    // Upload a finalized LCP file + metadata.
    const form = await req.formData();
    const file = form.get("file");
    let filename: string | null = null;
    let storageKey: string | null = null;
    let extractedText: string | null = null;
    if (file instanceof File) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : "";
      storageKey = await putObject(buffer, ext);
      filename = file.name;
      const ex = await extractText(buffer, file.type, file.name);
      extractedText = ex.text.slice(0, 8000) || null;
    }
    const careRaw = str(form.get("careCategories"));
    const careCategories = careRaw ? (() => { try { return JSON.parse(careRaw); } catch { return careRaw.split(/[;,]/).map((s) => s.trim()).filter(Boolean); } })() : [];

    const title = str(form.get("title")) || filename || "Untitled LCP";
    const created = await prisma.precedentPlan.create({
      data: {
        firmId: ctx.firm.id, createdById: ctx.user.id, source: "upload",
        title, clientRef: str(form.get("clientRef")), diagnosis: str(form.get("diagnosis")), icd10Code: str(form.get("icd10Code")),
        injurySpecialty: str(form.get("injurySpecialty")), jurisdiction: str(form.get("jurisdiction")), mechanism: str(form.get("mechanism")),
        age: num(form.get("age")) != null ? Math.round(num(form.get("age"))!) : null, sex: str(form.get("sex")),
        lifeExpectancyYears: num(form.get("lifeExpectancyYears")), lifetimeCost: num(form.get("lifetimeCost")), presentValue: num(form.get("presentValue")),
        careCategories: careCategories as unknown as Prisma.InputJsonValue, outcome: str(form.get("outcome")),
        filename, storageKey, extractedText,
      },
    });
    await audit(ctx, "precedents.create", { type: "precedentPlan", id: created.id });
    return ok({ precedent: created });
  } catch (err) {
    return handleError(err);
  }
}
