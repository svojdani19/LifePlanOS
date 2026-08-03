import { z } from "zod";
import { cookies } from "next/headers";
import { ok, handleError } from "@/lib/api";
import { requireApiContext, audit } from "@/lib/tenant";
import { isPlatformAdmin, requirePlatformAdmin, VIEW_AS_COOKIE } from "@/lib/authz/platform";
import { WORKSPACES } from "@/lib/workspaces";

// ─────────────────────────────────────────────────────────────────────────────
// Super Admin "View as" (presentation only). Sets/clears a small cookie naming
// a workspace key from src/lib/workspaces.ts. It does NOT alter permissions,
// credentials, or audit actor identity: the shell reads it to render a labeled
// banner and a sidebar entry, and each workspace page's own guard still decides
// access. Guarded by the explicit DB platform-admin grant; every change is
// audited as `platform.view_as` with the real actor.
// ─────────────────────────────────────────────────────────────────────────────

const schema = z.object({ workspace: z.string().min(1).max(64) });

export async function POST(req: Request) {
  try {
    const ctx = await requireApiContext();
    await requirePlatformAdmin(ctx);

    const { workspace } = schema.parse(await req.json());

    if (workspace === "clear") {
      (await cookies()).delete(VIEW_AS_COOKIE);
      await audit(ctx, "platform.view_as", { type: "workspace", id: "clear", meta: { workspace: "clear" } });
      return ok({ cleared: true, redirect: "/platform-admin" });
    }

    const def = WORKSPACES[workspace];
    if (!def) return ok({ error: "Unknown workspace." }, 400);

    (await cookies()).set(VIEW_AS_COOKIE, def.key, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      // Session cookie: view-as never outlives the browser session.
    });
    await audit(ctx, "platform.view_as", {
      type: "workspace",
      id: def.key,
      meta: { workspace: def.key, label: def.label, href: def.href },
    });
    return ok({ viewing: def.key, redirect: def.href });
  } catch (err) {
    return handleError(err);
  }
}

/** Current view-as state (used by the platform-admin panel). */
export async function GET() {
  try {
    const ctx = await requireApiContext();
    if (!(await isPlatformAdmin(ctx.user.id))) return ok({ viewing: null });
    const key = (await cookies()).get(VIEW_AS_COOKIE)?.value ?? null;
    return ok({ viewing: key && WORKSPACES[key] ? key : null });
  } catch (err) {
    return handleError(err);
  }
}
