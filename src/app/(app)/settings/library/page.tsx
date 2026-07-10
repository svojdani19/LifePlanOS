import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { can } from "@/lib/rbac";
import { LibraryManager } from "@/components/LibraryManager";

export default async function LibraryPage() {
  const ctx = await requireContext();
  if (!can(ctx.user.role, "precedents.manage")) redirect("/dashboard");
  const precedents = await prisma.precedentPlan.findMany({ where: { firmId: ctx.firm.id }, orderBy: { createdAt: "desc" } });

  return (
    <div>
      <Link href="/settings" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-800">
        <ArrowLeft className="h-4 w-4" /> Firm Management
      </Link>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-900">LCP Precedent Library</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-600">
          Search every finalized life care plan your firm has uploaded or synced from an accessible server. This library
          is the precedent set the AI pipeline compares active cases against to surface the closest comparables.
        </p>
      </div>
      <LibraryManager initial={JSON.parse(JSON.stringify(precedents))} canManage={can(ctx.user.role, "precedents.manage")} />
    </div>
  );
}
