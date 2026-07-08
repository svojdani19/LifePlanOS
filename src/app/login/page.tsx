"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AuthShell } from "@/components/AuthShell";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      setError(data.error ?? "Login failed");
      setLoading(false);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <AuthShell title="Welcome back" subtitle="Log in to your firm workspace.">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">Work email</label>
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label">Password</label>
          <input
            className="input"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-primary w-full" disabled={loading}>
          {loading ? "Signing in…" : "Log in"}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-600">
        New firm?{" "}
        <Link href="/signup" className="font-semibold text-brand-700 hover:underline">
          Get started
        </Link>
      </p>
    </AuthShell>
  );
}
