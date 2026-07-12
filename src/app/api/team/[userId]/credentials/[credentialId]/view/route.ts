import { prisma } from "@/lib/db";
import { requireApiContext } from "@/lib/tenant";
import { getObject } from "@/lib/storage";
import { handleError } from "@/lib/api";

// Stream a credential document through an authenticated, firm-scoped route
// (never served statically).
export async function GET(_req: Request, { params }: { params: { userId: string; credentialId: string } }) {
  try {
    const ctx = await requireApiContext();
    const cred = await prisma.userCredential.findFirst({ where: { id: params.credentialId, userId: params.userId, firmId: ctx.firm.id } });
    if (!cred?.storageKey) return new Response("Not found", { status: 404 });
    const buf = await getObject(cred.storageKey);
    const ext = cred.filename.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() ?? "";
    const contentType = ext === ".pdf" ? "application/pdf" : ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";
    return new Response(new Uint8Array(buf), { headers: { "Content-Type": contentType, "Content-Disposition": `inline; filename="${cred.filename.replace(/"/g, "")}"` } });
  } catch (err) {
    return handleError(err);
  }
}
