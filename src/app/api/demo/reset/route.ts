import { ok, handleError } from "@/lib/api";
import { requireApiContext, TenantError } from "@/lib/tenant";
import { isPlatformAdmin } from "@/lib/authz/platform";
import { demoModeEnabled } from "@/lib/demo/config";
import { resetDemoFirm } from "@/lib/demo/seed";

// Demo reset API (docs/28 §6 — platform-admin surface). Gated three ways:
// demo mode must be enabled, the caller must be an authenticated demo-tenant
// ADMIN or hold the explicit DB platform-admin grant, and the caller must be
// signed into the demo tenant itself (Firm.isDemo). The deletion path
// additionally refuses any firm whose isDemo flag is not true. Audited as
// "demo.reset" under the recreated firm.

export const maxDuration = 300;

export async function POST() {
  try {
    if (!demoModeEnabled()) return ok({ error: "Not found." }, 404);

    const ctx = await requireApiContext();
    if (ctx.user.role !== "ADMIN" && !(await isPlatformAdmin(ctx.user.id))) {
      throw new TenantError("Only administrators may reset the demo environment.", "FORBIDDEN", 403);
    }
    if (!ctx.firm.isDemo) {
      throw new TenantError("Demo reset is only available from within the demo tenant.", "FORBIDDEN", 403);
    }

    const summary = await resetDemoFirm({ userId: ctx.user.id, email: ctx.user.email });
    return ok({ reset: true, summary });
  } catch (err) {
    return handleError(err);
  }
}
