"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AuthShell } from "@/components/AuthShell";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, totp: totp || undefined }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      if (data.mfaRequired) setMfaRequired(true);
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
          <label className="label">Work Email</label>
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
        {mfaRequired && (
          <div>
            <label className="label">Two-Factor Code</label>
            <input
              className="input tracking-widest"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6-digit code or backup code"
              autoFocus
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
            />
            <p className="mt-1 text-xs text-ink-500">Enter the code from your authenticator app, or a saved backup code.</p>
          </div>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-primary w-full" disabled={loading}>
          {loading ? "Signing in…" : mfaRequired ? "Verify & Log In" : "Log In"}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-600">
        New firm?{" "}
        <Link href="/signup" className="font-semibold text-brand-700 hover:underline">
          Get Started
        </Link>
      </p>
    </AuthShell>
  );
}
