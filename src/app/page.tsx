import Link from "next/link";
import { ShieldCheck, Activity, FileText, Scale, Stethoscope, ArrowRight } from "lucide-react";
import { PLANS, PLAN_ORDER } from "@/lib/subscription/plans";
import { formatMoney } from "@/lib/utils";
import { getContext } from "@/lib/tenant";

const MODULES = [
  { icon: Activity, title: "Chronology engine", body: "Sorted, cited, accessible." },
  { icon: Stethoscope, title: "Future care engine", body: "Prognosis, probable and possible — backed by records." },
  { icon: Scale, title: "Cost projection", body: "Every pathway, quantified." },
  { icon: ShieldCheck, title: "Vulnerability Review", body: "Full prep and counter." },
  { icon: FileText, title: "Report generator", body: "Complete, ready-for-review, validated." },
];

export default async function LandingPage() {
  const ctx = await getContext();
  return (
    <div className="min-h-screen">
      {/* Nav */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-white">
            <Activity className="h-5 w-5" />
          </div>
          <span className="text-lg font-bold tracking-tight text-ink-900">LifePlanOS</span>
        </div>
        <nav className="flex items-center gap-3 text-sm">
          {ctx ? (
            <Link href="/dashboard" className="btn-primary">
              Open dashboard <ArrowRight className="h-4 w-4" />
            </Link>
          ) : (
            <>
              <Link href="/login" className="btn-ghost">
                Log in
              </Link>
              <Link href="/signup" className="btn-primary">
                Get started
              </Link>
            </>
          )}
        </nav>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 pt-16 pb-20 text-center">
        <span className="inline-block rounded-full bg-brand-100 px-3 py-1 text-xs font-semibold text-brand-800">
          Life Care Plans. Automated.
        </span>
        <h1 className="mx-auto mt-6 max-w-3xl text-5xl font-extrabold tracking-tight text-ink-900">
          Automate the work. Keep the control.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-ink-600">
          Everything from Intake to Reports —<br />engineered to simplify.
        </p>
        <div className="mt-9 flex justify-center gap-3">
          <Link href="/signup" className="btn-primary px-6 py-3 text-base">
            Get started
          </Link>
          <Link href="/login" className="btn-outline px-6 py-3 text-base">
            Log in
          </Link>
        </div>
      </section>

      {/* Modules */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {MODULES.map((m) => (
            <div key={m.title} className="card p-5">
              <m.icon className="h-6 w-6 text-brand-600" />
              <h3 className="mt-3 text-sm font-semibold text-ink-900">{m.title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-ink-600">{m.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <h2 className="text-center text-3xl font-bold tracking-tight text-ink-900">Simple firm pricing</h2>
        <p className="mt-2 text-center text-ink-600">One straightforward subscription per firm.</p>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {PLAN_ORDER.map((tier) => {
            const plan = PLANS[tier];
            const featured = tier === "SMALL_FIRM";
            return (
              <div
                key={tier}
                className={
                  "card flex flex-col p-6 " + (featured ? "ring-2 ring-brand-500" : "")
                }
              >
                {featured && (
                  <span className="mb-3 self-start rounded-full bg-brand-600 px-3 py-1 text-xs font-semibold text-white">
                    Most popular
                  </span>
                )}
                <h3 className="text-lg font-bold text-ink-900">{plan.name}</h3>
                <p className="mt-1 text-sm text-ink-600">{plan.blurb}</p>
                <div className="mt-5 flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold text-ink-900">{formatMoney(plan.monthlyPrice)}</span>
                  <span className="text-sm text-ink-500">/mo</span>
                </div>
                <ul className="mt-5 space-y-2 text-sm text-ink-700">
                  <li>{plan.seatLimit} seats</li>
                  <li>{plan.caseLimit === null ? "Unlimited cases" : `${plan.caseLimit} active cases`}</li>
                  {plan.features.map((f) => (
                    <li key={f} className="flex gap-2">
                      <span className="text-brand-600">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link href={`/signup?tier=${tier}`} className="btn-primary mt-6">
                  Start with {plan.name}
                </Link>
              </div>
            );
          })}
        </div>
      </section>

      <footer className="border-t border-ink-200 py-8 text-center text-xs text-ink-500">
        LifePlanOS — HIPAA-ready, BAA-ready architecture. The platform maximizes defensibility, not damages.
      </footer>
    </div>
  );
}
