"use client";

import { useEffect, useState, useCallback } from "react";
import { UserPlus, Copy, Check } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { formatDate, initials } from "@/lib/utils";

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
}

export function TeamManager({ currentUserId }: { currentUserId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invite, setInvite] = useState({ name: "", email: "", role: "PLANNER" });
  const [error, setError] = useState<string | null>(null);
  const [lastInviteLink, setLastInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
          <UserPlus className="h-4 w-4 text-brand-600" /> Invite a teammate
        </h2>
        <form onSubmit={sendInvite} className="mt-4 space-y-3">
          <input
            className="input"
            placeholder="Full name"
            required
            value={invite.name}
            onChange={(e) => setInvite({ ...invite, name: e.target.value })}
          />
          <input
            className="input"
            type="email"
            placeholder="Work email"
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
          <button className="btn-primary w-full">Send invitation</button>
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
            {members.map((m) => (
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
                  {m.id !== currentUserId && m.status !== "SUSPENDED" && (
                    <button onClick={() => revoke(m.id)} className="text-xs font-medium text-red-600 hover:underline">
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
