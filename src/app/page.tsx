import Link from "next/link";
import { ShieldCheck, Activity, FileText, Scale, Stethoscope, ArrowRight } from "lucide-react";

// The seven-step workflow the product actually implements — shown as the
// hero's responsive sequence.
const WORKFLOW = [
  "Upload records",
  "Build chronology",
  "Map diagnoses & evidence",
  "Develop future care",
  "Project costs",
  "Physician review",
  "Export report",
];

const MODULES = [
  { icon: Activity, title: "Records & Timeline", body: "Sorted, cited, accessible." },
  { icon: Stethoscope, title: "Future Care Engine", body: "Prognosis — backed by science." },
  { icon: Scale, title: "Cost Projection", body: "Every pathway, quantified." },
  { icon: ShieldCheck, title: "Deposition Analysis", body: "Dual-sided prep and counter." },
  { icon: FileText, title: "Report Generator", body: "Evidence-based, physician validated, complete." },
];

const BENEFITS = [
  { title: "Evidence traceability", body: "Every recommendation links back to page-cited records, guidelines, and literature." },
  { title: "Clinical oversight", body: "Physician review gates every plan; approvals are invalidated when material facts change." },
  { title: "Faster report production", body: "From records to a structured, court-ready draft in a fraction of the manual time." },
  { title: "Cost transparency", body: "Editable assumptions, an audit ledger for every change, and disclosed contingencies." },
  { title: "Auditability", body: "Every action is firm-scoped, logged, and versioned — including supersession history." },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      {/* Nav */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-white">
            <Activity className="h-5 w-5" aria-hidden />
          </div>
          <span className="text-lg font-bold tracking-tight text-ink-900">LifePlanOS</span>
        </div>
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/login" className="btn-ghost">Log In</Link>
          <Link href="/signup" className="btn-primary">Get Started</Link>
        </nav>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 pb-14 pt-16 text-center">
        <span className="inline-block rounded-full bg-brand-100 px-3 py-1 text-xs font-semibold text-brand-800">
          Life Care Plans. Made Easy.
        </span>
        <h1 className="mx-auto mt-6 max-w-3xl text-5xl font-extrabold tracking-tight text-ink-900">
          The operating system for life care planning.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-ink-600">
          From medical records to physician-reviewed future care, cost projections, and defensible reports.
        </p>
      </section>

      {/* Workflow sequence */}
      <section className="mx-auto max-w-6xl px-6 pb-16" aria-label="How it works">
        <ol className="flex flex-wrap items-center justify-center gap-y-3">
          {WORKFLOW.map((step, i) => (
            <li key={step} className="flex items-center">
              {i > 0 && <ArrowRight className="mx-2 h-4 w-4 shrink-0 text-ink-300" aria-hidden />}
              <span className="flex items-center gap-2 rounded-full border border-ink-200 bg-white px-3 py-1.5 text-sm text-ink-700">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-600 text-[11px] font-semibold text-white" aria-hidden>{i + 1}</span>
                {step}
              </span>
            </li>
          ))}
        </ol>
      </section>

      {/* Modules */}
      <section className="mx-auto max-w-6xl px-6 pb-16">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {MODULES.map((m) => (
            <div key={m.title} className="card p-5">
              <m.icon className="h-6 w-6 text-brand-600" aria-hidden />
              <h3 className="mt-3 text-sm font-semibold text-ink-900">{m.title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-ink-600">{m.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Benefits */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {BENEFITS.map((b) => (
            <div key={b.title}>
              <h3 className="text-sm font-semibold text-ink-900">{b.title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-ink-600">{b.body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="mt-8 border-t border-ink-200 py-8 text-center text-xs text-ink-500">
        LifePlanOS — firm-scoped data isolation with a complete audit trail. Clinical opinions remain the reviewing physician&apos;s.
      </footer>
    </div>
  );
}
