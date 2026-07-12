"use client";

import { useEffect, useState, useCallback } from "react";
import { UserPlus, Copy, Check, FileText, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { formatDate, initials } from "@/lib/utils";

// Seats that may carry reviewer credentials (EPIC-011).
const MEDICAL_ROLES = new Set(["ADMIN", "PLANNER", "PHYSICIAN_REVIEWER"]);
const CRED_TYPES = [
  ["BOARD_CERTIFICATION", "Board certification"],
  ["CV", "Curriculum vitae"],
  ["LICENSE", "License"],
  ["OTHER", "Other"],
] as const;

// Per-seat credential documents + a rendered "board certified in …" summary that
// the report Qualifications section uses. Shown for medical-personnel seats.
function CredentialsRow({ userId, initialSummary }: { userId: string; initialSummary: string | null }) {
  const [creds, setCreds] = useState<{ id: string; type: string; label: string | null; filename: string }[] | null>(null);
  const [type, setType] = useState("BOARD_CERTIFICATION");
  const [label, setLabel] = useState("");
  const [summary, setSummary] = useState(initialSummary ?? "");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const res = await fetch(`/api/team/${userId}/credentials`);
    if (res.ok) setCreds((await res.json()).credentials ?? []);
  }, [userId]);
  useEffect(() => { load(); }, [load]);
  async function upload(file: File) {
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file); fd.append("type", type); if (label) fd.append("label", label);
    const res = await fetch(`/api/team/${userId}/credentials`, { method: "POST", body: fd });
    setBusy(false);
    if (res.ok) { setLabel(""); load(); }
  }
  return (
    <div className="space-y-3 rounded-lg bg-ink-50/70 p-3 text-sm">
      <div>
        <label className="text-xs font-medium text-ink-500">Credential summary (rendered in report Qualifications)</label>
        <div className="mt-1 flex gap-2">
          <input className="input flex-1 text-sm" placeholder="e.g. Board certified in Physical Medicine & Rehabilitation and Brain Injury Medicine" value={summary} onChange={(e) => setSummary(e.target.value)} />
          <button className="btn-outline px-3 py-1.5 text-xs" onClick={() => fetch(`/api/team/${userId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credentialSummary: summary || null }) })}>Save</button>
        </div>
      </div>
      <div>
        <label className="text-xs font-medium text-ink-500">Documents (board certification, CV, license)</label>
        <ul className="mt-1 space-y-1">
          {(creds ?? []).map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-ink-700">
              <FileText className="h-3.5 w-3.5 text-ink-400" />
              <a href={`/api/team/${userId}/credentials/${c.id}/view`} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 hover:underline">{c.filename}</a>
              <span className="text-xs text-ink-400">{(CRED_TYPES.find(([v]) => v === c.type)?.[1]) ?? c.type}{c.label ? ` · ${c.label}` : ""}</span>
              <button className="ml-auto text-ink-300 hover:text-red-600" onClick={async () => { await fetch(`/api/team/${userId}/credentials/${c.id}`, { method: "DELETE" }); load(); }}><X className="h-3.5 w-3.5" /></button>
            </li>
          ))}
          {creds && creds.length === 0 && <li className="text-xs text-ink-400">No credential documents uploaded.</li>}
        </ul>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select className="input w-44 text-sm" value={type} onChange={(e) => setType(e.target.value)}>
            {CRED_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input className="input w-52 text-sm" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <label className="btn-outline cursor-pointer px-3 py-1.5 text-xs">
            {busy ? "Uploading…" : "Upload"}
            <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
          </label>
        </div>
      </div>
    </div>
  );
}

const ROLES = [
  ["ADMIN", "Administrator"],
  ["PLANNER", "Life Care Planner"],
  ["PHYSICIAN_REVIEWER", "Physician Reviewer"],
  ["ATTORNEY_REVIEWER", "Attorney Reviewer"],
  ["PARALEGAL", "Paralegal"],
  ["BILLING_USER", "Billing"],
] as const;

const ROLE_LABEL = Object.fromEntries(ROLES) as Record<string, string>;

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  inviteToken: string | null;
  createdAt: string;
  credentialSummary?: string | null;
}

export function TeamManager({ currentUserId }: { currentUserId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invite, setInvite] = useState({ name: "", email: "", role: "PLANNER" });
  const [error, setError] = useState<string | null>(null);
  const [lastInviteLink, setLastInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [credsFor, setCredsFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/team");
    const data = await res.json();
    if (res.ok) setMembers(data.users);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invite),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Could not invite");
      return;
    }
    if (data.inviteToken) {
      setLastInviteLink(`${window.location.origin}/accept-invite?token=${data.inviteToken}`);
    }
    setInvite({ name: "", email: "", role: "PLANNER" });
    load();
  }

  async function changeRole(id: string, role: string) {
    await fetch(`/api/team/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    load();
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this teammate's access? Their sessions will be terminated.")) return;
    await fetch(`/api/team/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* Invite */}
      <div className="card h-fit p-6">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-900">
          <UserPlus className="h-4 w-4 text-brand-600" /> Invite a Teammate
        </h2>
        <form onSubmit={sendInvite} className="mt-4 space-y-3">
          <input
            className="input"
            placeholder="Full Name"
            required
            value={invite.name}
            onChange={(e) => setInvite({ ...invite, name: e.target.value })}
          />
          <input
            className="input"
            type="email"
            placeholder="Work Email"
            required
            value={invite.email}
            onChange={(e) => setInvite({ ...invite, email: e.target.value })}
          />
          <select className="input" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
            {ROLES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button className="btn-primary w-full">Send Invitation</button>
        </form>
        {lastInviteLink && (
          <div className="mt-4 rounded-lg bg-brand-50 p-3 text-xs">
            <p className="font-medium text-brand-800">Invite link (email in production):</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 text-ink-600">{lastInviteLink}</code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(lastInviteLink);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="rounded p-1 text-brand-700 hover:bg-brand-100"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Roster */}
      <div className="card lg:col-span-2 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-3 font-medium">Member</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {members.map((m) => [
              <tr key={m.id} className="hover:bg-ink-50">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="grid h-9 w-9 place-items-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800">
                      {initials(m.name)}
                    </div>
                    <div>
                      <p className="font-medium text-ink-900">{m.name}</p>
                      <p className="text-xs text-ink-500">{m.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  {m.id === currentUserId || m.status === "SUSPENDED" ? (
                    <span className="text-ink-700">{ROLE_LABEL[m.role]}</span>
                  ) : (
                    <select
                      className="rounded-md border border-ink-300 bg-white px-2 py-1 text-xs"
                      value={m.role}
                      onChange={(e) => changeRole(m.id, e.target.value)}
                    >
                      {ROLES.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="px-4 py-3">
                  <Badge tone={m.status === "ACTIVE" ? "green" : m.status === "INVITED" ? "amber" : "red"}>
                    {m.status.toLowerCase()}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-3">
                    {MEDICAL_ROLES.has(m.role) && m.status !== "SUSPENDED" && (
                      <button onClick={() => setCredsFor(credsFor === m.id ? null : m.id)} className="text-xs font-medium text-brand-700 hover:underline">
                        {credsFor === m.id ? "Hide credentials" : "Credentials"}
                      </button>
                    )}
                    {m.id !== currentUserId && m.status !== "SUSPENDED" && (
                      <button onClick={() => revoke(m.id)} className="text-xs font-medium text-red-600 hover:underline">
                        Revoke
                      </button>
                    )}
                  </div>
                </td>
              </tr>,
              credsFor === m.id ? (
                <tr key={m.id + "-creds"}>
                  <td colSpan={4} className="bg-ink-50/40 px-4 pb-4">
                    <CredentialsRow userId={m.id} initialSummary={m.credentialSummary ?? null} />
                  </td>
                </tr>
              ) : null,
            ]).flat().filter(Boolean)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
