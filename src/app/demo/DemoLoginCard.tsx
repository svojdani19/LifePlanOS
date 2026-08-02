"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  email: string;
  name: string;
  label: string;
  description: string;
}

/** One persona card with a one-click "Sign In as This Role" action. */
export function DemoLoginCard({ email, name, label, description }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setLoading(true);
    setError(null);
    const res = await fetch("/api/demo/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      setError(data.error ?? "Demo login failed.");
      setLoading(false);
      return;
    }
    router.push(data.redirect ?? "/dashboard");
    router.refresh();
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-cyan-700">{label}</div>
      <div className="mt-1 text-base font-semibold text-slate-900">{name}</div>
      <p className="mt-2 flex-1 text-sm leading-relaxed text-slate-600">{description}</p>
      <div className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
        <div className="truncate font-mono">{email}</div>
        <div className="mt-0.5">Password: set by <span className="font-mono">DEMO_PASSWORD</span></div>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <button
        onClick={signIn}
        disabled={loading}
        className="mt-4 w-full rounded-lg bg-cyan-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-800 disabled:opacity-60"
      >
        {loading ? "Signing in…" : "Sign In as This Role"}
      </button>
    </div>
  );
}
