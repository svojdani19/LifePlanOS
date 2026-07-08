"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AuthShell } from "@/components/AuthShell";

const TIERS = [
  { value: "SOLO", label: "Solo — $3,000/mo" },
  { value: "SMALL_FIRM", label: "Small Firm — $7,000/mo" },
  { value: "ENTERPRISE", label: "Enterprise — $10,000/mo" },
];

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupInner />
    </Suspense>
  );
}

function SignupInner() {
  const router = useRouter();
  const params = useSearchParams();
  const initialTier = params.get("tier") ?? "SOLO";

  const [form, setForm] = useState({
    firmName: "",
    adminName: "",
    email: "",
    password: "",
    state: "",
    tier: TIERS.some((t) => t.value === initialTier) ? initialTier : "SOLO",
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      setError(data.error ?? "Sign up failed");
      setLoading(false);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <AuthShell title="Start your firm workspace" subtitle="Create your firm account to get started.">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">Firm name</label>
          <input className="input" required value={form.firmName} onChange={(e) => set("firmName", e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Your name</label>
            <input className="input" required value={form.adminName} onChange={(e) => set("adminName", e.target.value)} />
          </div>
          <div>
            <label className="label">State</label>
            <input className="input" value={form.state} onChange={(e) => set("state", e.target.value)} placeholder="CA" />
          </div>
        </div>
        <div>
          <label className="label">Work email</label>
          <input className="input" type="email" required value={form.email} onChange={(e) => set("email", e.target.value)} />
        </div>
        <div>
          <label className="label">Password</label>
          <input
            className="input"
            type="password"
            required
            minLength={8}
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
            placeholder="At least 8 characters"
          />
        </div>
        <div>
          <label className="label">Plan</label>
          <select className="input" value={form.tier} onChange={(e) => set("tier", e.target.value)}>
            {TIERS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-primary w-full" disabled={loading}>
          {loading ? "Creating workspace…" : "Create firm workspace"}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-600">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-brand-700 hover:underline">
          Log in
        </Link>
      </p>
    </AuthShell>
  );
}
