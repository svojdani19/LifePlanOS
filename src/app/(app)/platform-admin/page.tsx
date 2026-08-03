import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ShieldAlert } from "lucide-react";
import { requireContext, audit } from "@/lib/tenant";
import { isPlatformAdmin, VIEW_AS_COOKIE } from "@/lib/authz/platform";
import { prisma } from "@/lib/db";
import { storageMode } from "@/lib/storage";
import { formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { TenantContextButton, ViewAsPanel } from "@/components/platform/ViewAs";
import { WORKSPACES } from "@/lib/workspaces";

// ─────────────────────────────────────────────────────────────────────────────
// Platform Admin Workspace (MDIP docs/28). Cross-tenant BY DESIGN: platform
// operations needs the roster of organizations (names, tiers, counts — no PHI
// beyond counts), system health, and the demo-environment controls. Access is
// deliberately NOT firm-role based: it requires an explicit, revocable DB
// grant — an ACTIVE, unexpired PLATFORM_SYSTEM_ADMINISTRATOR role assignment
// (src/lib/authz/platform.ts). No email allowlists. Everyone else is
// redirected to /dashboard, and every view of this page is audited.
// ─────────────────────────────────────────────────────────────────────────────

export default async function PlatformAdminPage() {
  const ctx = await requireContext();
  if (!(await isPlatformAdmin(ctx.user.id))) redirect("/dashboard");
  // Cross-tenant page view — audited with the real actor identity.
  await audit(ctx, "platform.admin_view", { type: "platform", id: "platform-admin" });

  const viewAsCookie = (await cookies()).get(VIEW_AS_COOKIE)?.value ?? null;
  const viewing = viewAsCookie && WORKSPACES[viewAsCookie] ? viewAsCookie : null;

  const [firms, latestValidationRun] = await Promise.all([
    prisma.firm.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        isDemo: true,
        authzRevision: true,
        createdAt: true,
        subscription: { select: { tier: true, status: true } },
        _count: { select: { users: true, cases: true } },
      },
    }),
    prisma.validationRun.findFirst({ orderBy: { createdAt: "desc" }, select: { engineVersion: true, createdAt: true } }),
  ]);

  const demoFirms = firms.filter((f) => f.isDemo);
  const demoEnabled = process.env.ENABLE_DEMO_MODE === "true" || process.env.ENABLE_DEMO_MODE === "1";
  // Feature-detect the demo-reset surfaces (they land with the demo agent):
  // source-tree checks, honest in dev; in a compiled deploy the CLI command is
  // shown as the reliable path.
  const resetApiPresent = existsSync(join(process.cwd(), "src/app/api/demo/reset/route.ts"));
  const resetScriptPresent = existsSync(join(process.cwd(), "scripts/demo-reset.ts"));

  return (
    <div>
      {/* ── Privileged-area warning ───────────────────────────────────────────── */}
      <div className="mb-5 flex items-start gap-3 rounded-xl border-2 border-red-300 bg-red-50 p-4">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-700" aria-hidden />
        <div>
          <p className="text-sm font-bold uppercase tracking-wide text-red-800">Privileged platform area</p>
          <p className="mt-0.5 text-sm text-red-900">
            This view is cross-tenant by design: it lists every organization on the platform (names, tiers, and counts only — no
            case content). Actions taken here affect all organizations and are audited.
          </p>
        </div>
      </div>

      <PageHeader
        title="Platform Administration"
        subtitle={`${firms.length} organization${firms.length === 1 ? "" : "s"} on this deployment`}
        metrics={[
          { label: "Organizations", value: String(firms.length) },
          { label: "Demo Orgs", value: String(demoFirms.length) },
          { label: "Storage", value: storageMode() },
        ]}
      />

      {/* ── View as (presentation only) ────────────────────────────────────────── */}
      <ViewAsPanel
        workspaces={Object.values(WORKSPACES).map((w) => ({ key: w.key, label: w.label, href: w.href }))}
        viewing={viewing}
      />

      {/* ── Organizations ─────────────────────────────────────────────────────── */}
      <h2 className="text-label mt-6">Organizations</h2>
      {firms.length === 0 ? (
        <div className="card mt-2 p-5 text-sm text-ink-500">No organizations exist yet.</div>
      ) : (
        <div className="card mt-2 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Organization</th>
                <th className="px-4 py-2.5 font-medium">Tier</th>
                <th className="px-4 py-2.5 font-medium">Users</th>
                <th className="px-4 py-2.5 font-medium">Cases</th>
                <th className="px-4 py-2.5 font-medium">Authz Rev</th>
                <th className="px-4 py-2.5 font-medium">Created</th>
                <th className="px-4 py-2.5 text-right font-medium">Support context</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {firms.map((f) => (
                <tr key={f.id} className="hover:bg-ink-50">
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-ink-800">{f.name}</span>
                    {f.isDemo && <Badge tone="ai" className="ml-2">demo</Badge>}
                    {f.id === ctx.firm.id && <Badge tone="brand" className="ml-2">current</Badge>}
                  </td>
                  <td className="px-4 py-2.5">
                    {f.subscription ? (
                      <span className="text-ink-600">
                        {f.subscription.tier.toLowerCase()}
                        <span className="ml-1 text-xs text-ink-400">({f.subscription.status.toLowerCase()})</span>
                      </span>
                    ) : (
                      <span className="text-ink-400">none</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{f._count.users}</td>
                  <td className="px-4 py-2.5 tabular-nums">{f._count.cases}</td>
                  <td className="px-4 py-2.5 tabular-nums text-ink-500">{f.authzRevision}</td>
                  <td className="px-4 py-2.5 text-ink-500">{formatDate(f.createdAt)}</td>
                  <td className="px-4 py-2.5 text-right">
                    {f.id !== (ctx.actorFirmId ?? ctx.user.firmId) && (
                      <TenantContextButton firmId={f.id} active={ctx.supportMode === true && f.id === ctx.firm.id} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {/* ── System health ───────────────────────────────────────────────────── */}
        <div className="card p-5">
          <h3 className="h-section">System Health</h3>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-ink-600">Storage mode</dt>
              <dd><Badge tone={storageMode() === "s3" ? "success" : "neutral"}>{storageMode() === "s3" ? "S3 (encrypted bucket)" : "local disk"}</Badge></dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-ink-600">Latest clinical-validation run</dt>
              <dd className="text-right text-ink-800">
                {latestValidationRun ? (
                  <span>{latestValidationRun.engineVersion} <span className="text-xs text-ink-500">· {formatDate(latestValidationRun.createdAt)}</span></span>
                ) : (
                  <span className="text-ink-400">no runs recorded</span>
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-ink-600">Demo mode flag</dt>
              <dd><Badge tone={demoEnabled ? "info" : "neutral"}>{demoEnabled ? "enabled" : "disabled"}</Badge></dd>
            </div>
          </dl>
        </div>

        {/* ── Demo environment ────────────────────────────────────────────────── */}
        <div className="card p-5">
          <h3 className="h-section">Demo Environment</h3>
          {demoFirms.length === 0 ? (
            <p className="mt-2 text-sm text-ink-500">
              No demo organization exists on this deployment. Seed one with <code className="rounded bg-ink-100 px-1 py-0.5 font-mono text-xs">npx tsx scripts/demo-seed.ts</code> once demo mode lands.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {demoFirms.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-ink-800">{f.name}</span>
                  <span className="text-xs text-ink-500">{f._count.users} users · {f._count.cases} cases</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 rounded-lg bg-ink-50 p-3 text-xs text-ink-600">
            <p className="font-semibold text-ink-800">Reset</p>
            {resetApiPresent ? (
              <p className="mt-1">Reset endpoint available: <code className="rounded bg-ink-100 px-1 py-0.5 font-mono">POST /api/demo/reset</code> (deletes the demo firm cascade and reseeds; audited).</p>
            ) : (
              <p className="mt-1">
                The one-click reset endpoint is not present on this build.
                {resetScriptPresent ? (
                  <> Run <code className="rounded bg-ink-100 px-1 py-0.5 font-mono">npx tsx scripts/demo-reset.ts</code> from the deployment host instead.</>
                ) : (
                  <> When the demo tooling lands, reset runs via <code className="rounded bg-ink-100 px-1 py-0.5 font-mono">scripts/demo-reset.ts</code> or <code className="rounded bg-ink-100 px-1 py-0.5 font-mono">POST /api/demo/reset</code>.</>
                )}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
