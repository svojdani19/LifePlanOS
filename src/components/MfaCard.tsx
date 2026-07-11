"use client";

import { useState } from "react";
import { ShieldCheck, ShieldAlert, Loader2, Copy, Check } from "lucide-react";

type Step = "idle" | "setup" | "backup";

export function MfaCard({ enabled: initial }: { enabled: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [step, setStep] = useState<Step>("idle");
  const [secret, setSecret] = useState("");
  const [otpauthUri, setOtpauthUri] = useState("");
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showDisable, setShowDisable] = useState(false);

  async function call(action: string, extra?: Record<string, string>) {
    setBusy(true);
    setError(null);
    const r = await fetch("/api/auth/mfa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
    const data = await r.json();
    setBusy(false);
    if (!r.ok || data.error) { setError(data.error ?? "Something went wrong."); return null; }
    return data;
  }

  async function startSetup() {
    const d = await call("setup");
    if (d) { setSecret(d.secret); setOtpauthUri(d.otpauthUri); setCode(""); setStep("setup"); }
  }
  async function confirmEnable() {
    const d = await call("enable", { code });
    if (d) { setBackupCodes(d.backupCodes); setStep("backup"); setEnabled(true); }
  }
  async function disable() {
    const d = await call("disable", { code });
    if (d) { setEnabled(false); setShowDisable(false); setCode(""); setStep("idle"); }
  }

  return (
    <div className="card max-w-2xl p-6">
      <div className="flex items-center gap-3">
        <div className={`grid h-10 w-10 place-items-center rounded-lg ${enabled ? "bg-emerald-50 text-emerald-600" : "bg-ink-100 text-ink-400"}`}>
          {enabled ? <ShieldCheck className="h-5 w-5" /> : <ShieldAlert className="h-5 w-5" />}
        </div>
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-ink-900">Two-Factor Authentication</h2>
          <p className="text-xs text-ink-500">{enabled ? "Enabled — a code from your authenticator is required at login." : "Add a second factor (TOTP) to protect access to PHI."}</p>
        </div>
        {step === "idle" && !enabled && <button className="btn-primary" disabled={busy} onClick={startSetup}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enable"}</button>}
        {step === "idle" && enabled && !showDisable && <button className="btn-outline" onClick={() => { setShowDisable(true); setCode(""); setError(null); }}>Disable</button>}
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {/* Enrollment */}
      {step === "setup" && (
        <div className="mt-4 space-y-3 border-t border-ink-100 pt-4">
          <p className="text-sm text-ink-700">1. In your authenticator app (Google Authenticator, Authy, 1Password…), add an account and enter this setup key:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded-md bg-ink-50 px-3 py-2 font-mono text-sm text-ink-800">{secret}</code>
            <button className="btn-outline shrink-0" onClick={() => { navigator.clipboard?.writeText(secret); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}</button>
          </div>
          <p className="break-all text-xs text-ink-400">otpauth URI: {otpauthUri}</p>
          <p className="text-sm text-ink-700">2. Enter the 6-digit code it shows:</p>
          <div className="flex gap-2">
            <input className="input max-w-[180px] tracking-widest" inputMode="numeric" placeholder="000000" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
            <button className="btn-primary" disabled={busy || code.length < 6} onClick={confirmEnable}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify & Enable"}</button>
            <button className="btn-outline" onClick={() => setStep("idle")}>Cancel</button>
          </div>
        </div>
      )}

      {/* Backup codes (shown once) */}
      {step === "backup" && (
        <div className="mt-4 space-y-3 border-t border-ink-100 pt-4">
          <p className="text-sm font-medium text-ink-900">Two-factor is on. Save these one-time backup codes somewhere safe — each works once if you lose your authenticator:</p>
          <div className="grid grid-cols-2 gap-2 rounded-lg bg-ink-50 p-3 font-mono text-sm text-ink-800 sm:grid-cols-3">
            {backupCodes.map((c) => <span key={c}>{c}</span>)}
          </div>
          <button className="btn-primary" onClick={() => setStep("idle")}>I&apos;ve saved my backup codes</button>
        </div>
      )}

      {/* Disable confirm */}
      {showDisable && (
        <div className="mt-4 space-y-3 border-t border-ink-100 pt-4">
          <p className="text-sm text-ink-700">Enter a current authenticator code (or a backup code) to turn off two-factor:</p>
          <div className="flex gap-2">
            <input className="input max-w-[220px] tracking-widest" placeholder="code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
            <button className="py-1 text-sm font-medium text-red-600 hover:underline" disabled={busy} onClick={disable}>{busy ? "Disabling…" : "Turn off 2FA"}</button>
            <button className="btn-outline" onClick={() => setShowDisable(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
