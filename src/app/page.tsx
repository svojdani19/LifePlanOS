import Link from "next/link";
import { ShieldCheck, Activity, FileText, Scale, Stethoscope } from "lucide-react";

const MODULES = [
  { icon: Activity, title: "Records & Timeline", body: "Sorted, cited, accessible." },
  { icon: Stethoscope, title: "Future Care Engine", body: "Prognosis — backed by science." },
  { icon: Scale, title: "Cost Projection", body: "Every pathway, quantified." },
  { icon: ShieldCheck, title: "Deposition Analysis", body: "Dual-sided prep and counter." },
  { icon: FileText, title: "Report Generator", body: "Evidence-based, physician validated, complete." },
];

export default function LandingPage() {
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
          <Link href="/login" className="btn-ghost">
            Log In
          </Link>
          <Link href="/signup" className="btn-primary">
            Get Started
          </Link>
        </nav>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 pt-16 pb-20 text-center">
        <span className="inline-block rounded-full bg-brand-100 px-3 py-1 text-xs font-semibold text-brand-800">
          Life Care Plans. Made Easy.
        </span>
        <h1 className="mx-auto mt-6 max-w-3xl text-5xl font-extrabold tracking-tight text-ink-900">
          Automate the work.<br />Keep the control.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-ink-600">
          Everything from Intake to Reports —<br />engineered to simplify.
        </p>
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

      <footer className="mt-8 border-t border-ink-200 py-8 text-center text-xs text-ink-500">
        LifePlanOS — HIPAA-ready, BAA-ready architecture. The platform maximizes defensibility, not damages.
      </footer>
    </div>
  );
}
