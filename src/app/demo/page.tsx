import { notFound } from "next/navigation";
import { demoModeEnabled, DEMO_PERSONAS, DEMO_FIRM_NAME } from "@/lib/demo/config";
import { WORKSPACES } from "@/lib/workspaces";
import { DemoLoginCard } from "./DemoLoginCard";

// Public demo launcher (docs/28 §6). Only rendered when demo mode is enabled;
// otherwise the route 404s so nothing leaks on real deployments.
export const dynamic = "force-dynamic";

export const metadata = { title: "Demo — LifePlanOS" };

export default function DemoPage() {
  if (!demoModeEnabled()) notFound();

  return (
    <main className="min-h-screen bg-slate-100">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <p className="text-xs font-semibold uppercase tracking-widest text-cyan-700">LifePlanOS demo environment</p>
        <h1 className="mt-2 text-3xl font-bold text-slate-900">{DEMO_FIRM_NAME}</h1>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-600">
          A fully synthetic tenant for exploring every role-specific workspace. All people, cases, records, and
          figures are fictional. Pick a persona to sign in with one click — each lands in its own workspace over the
          same eight staged demo cases.
        </p>
        <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {DEMO_PERSONAS.map((p) => (
            <DemoLoginCard
              key={p.email}
              email={p.email}
              name={p.name}
              label={WORKSPACES[p.preferredWorkspace]?.label ?? p.preferredWorkspace}
              description={p.description}
            />
          ))}
        </div>
        <p className="mt-10 text-xs text-slate-400">
          Demo data can be rebuilt at any time with <span className="font-mono">npx tsx scripts/demo-reset.ts --confirm</span>.
        </p>
      </div>
    </main>
  );
}
