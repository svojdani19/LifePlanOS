import { getContext } from "@/lib/tenant";
import { destroySession } from "@/lib/auth/session";
import { audit } from "@/lib/tenant";
import { ok } from "@/lib/api";

export async function POST() {
  const ctx = await getContext();
  if (ctx) await audit(ctx, "auth.logout");
  await destroySession();
  return ok({ ok: true });
}
