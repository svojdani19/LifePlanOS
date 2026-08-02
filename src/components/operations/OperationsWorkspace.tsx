"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { PageHeader } from "@/components/ui/PageHeader";
import { cn, formatDate, formatMoney } from "@/lib/utils";
import { ENGAGEMENT_TRANSITIONS, type EngagementStatus } from "@/lib/engagements/service";

// ─────────────────────────────────────────────────────────────────────────────
// Operations workspace (MDIP docs/28, Agent B). Five tabs over the firm's
// engagements. Decisions:
//   - Invoices are DERIVED from engagements (engagement-fee-as-invoice v1):
//     no invoice model, no UsageRecord changes — an authorized engagement with
//     a fee IS the receivable; DELIVERED/COMPLETED = due, CANCELLED = void.
//   - Case identity is the case NUMBER only (no client names — separation of
//     duties for billing seats).
//   - Actions call the per-case engagements API; a 403 renders the server's
//     refusal verbatim instead of hiding the row.
// ─────────────────────────────────────────────────────────────────────────────

interface EngagementRow {
  id: string;
  caseId: string;
  caseNumber: string;
  reportType: string;
  status: string;
  feeEstimate: number | null;
  feeStructure: string | null;
  estimatedCompletionDate: string | null;
  authorizedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationStatus: string | null;
  missingRequirements: string[];
  createdAt: string;
  assignedPlannerId: string | null;
  assignedPhysicianId: string | null;
  assignedVocationalExpertId: string | null;
  assignedEconomistId: string | null;
  assignedQaReviewerId: string | null;
}

interface UserRow {
  id: string;
  name: string;
  role: string;
}

interface PricingEntry {
  fixed?: number;
  hourly?: number;
  rush?: number;
  turnaroundDays?: number;
}

interface Props {
  engagements: EngagementRow[];
  users: UserRow[];
  pricing: Record<string, PricingEntry>;
  reportTypes: { id: string; name: string }[];
  permissions: { authorize: boolean; manage: boolean; pricing: boolean };
}

type Tab = "engagements" | "pricing" | "invoices" | "capacity" | "deadlines";

const TABS: { id: Tab; label: string }[] = [
  { id: "engagements", label: "Engagements" },
  { id: "pricing", label: "Pricing" },
  { id: "invoices", label: "Invoices" },
  { id: "capacity", label: "Capacity" },
  { id: "deadlines", label: "Deadlines" },
];

const STATUS_TONE: Record<string, BadgeTone> = {
  RECOMMENDED: "info",
  AWAITING_AUTHORIZATION: "warning",
  RECORDS_PENDING: "warning",
  AUTHORIZED: "brand",
  ASSIGNMENT_PENDING: "warning",
  IN_PROGRESS: "info",
  QA_REVIEW: "ai",
  DELIVERED: "success",
  COMPLETED: "success",
  CANCELLED: "neutral",
};

const OPEN_STATUSES = new Set(["AUTHORIZED", "ASSIGNMENT_PENDING", "IN_PROGRESS", "QA_REVIEW", "DELIVERED"]);
const AUTHORIZABLE = new Set(["RECOMMENDED", "AWAITING_AUTHORIZATION", "RECORDS_PENDING"]);
const ASSIGNABLE = new Set(["AUTHORIZED", "ASSIGNMENT_PENDING", "IN_PROGRESS"]);
const TERMINAL = new Set(["COMPLETED", "CANCELLED"]);

const ASSIGN_SLOTS = [
  { key: "plannerId", field: "assignedPlannerId", label: "Planner" },
  { key: "physicianId", field: "assignedPhysicianId", label: "Physician" },
  { key: "vocationalExpertId", field: "assignedVocationalExpertId", label: "Vocational" },
  { key: "economistId", field: "assignedEconomistId", label: "Economist" },
  { key: "qaReviewerId", field: "assignedQaReviewerId", label: "QA" },
] as const;

function statusLabel(s: string): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c: string) => c.toUpperCase());
}

function reportLabel(s: string): string {
  return s.replace(/_/g, " ");
}

export function OperationsWorkspace({ engagements, users, pricing, reportTypes, permissions }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("engagements");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const userNames = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])), [users]);
  const open = engagements.filter((e) => OPEN_STATUSES.has(e.status));

  async function callAction(row: EngagementRow, body: Record<string, unknown>, okText: string) {
    setBusyId(row.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/cases/${row.caseId}/engagements?id=${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({
          kind: "error",
          text:
            res.status === 403
              ? `Not permitted: ${data.error ?? "your role cannot perform this action."}`
              : data.error ?? "Action failed.",
        });
      } else {
        setNotice({ kind: "ok", text: okText });
        router.refresh();
      }
    } catch {
      setNotice({ kind: "error", text: "Network error — the action was not applied." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <PageHeader
          title="Operations"
          subtitle="Engagement pipeline, pricing, invoicing, capacity, and deadlines — commercial operations without clinical access."
          metrics={[
            { label: "Open engagements", value: String(open.length) },
            { label: "Awaiting authorization", value: String(engagements.filter((e) => AUTHORIZABLE.has(e.status)).length) },
            { label: "Delivered", value: String(engagements.filter((e) => e.status === "DELIVERED" || e.status === "COMPLETED").length) },
          ]}
        />
      </div>

      <div className="mb-4 inline-flex rounded-lg bg-ink-100 p-1" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition",
              tab === t.id ? "bg-white text-ink-900 shadow-sm" : "text-ink-500 hover:text-ink-800",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {notice && (
        <div
          className={cn(
            "mb-4 rounded-md border px-3 py-2 text-sm",
            notice.kind === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800",
          )}
        >
          {notice.text}
        </div>
      )}

      {tab === "engagements" && (
        <EngagementsTab
          engagements={engagements}
          users={users}
          userNames={userNames}
          permissions={permissions}
          busyId={busyId}
          onAction={callAction}
        />
      )}
      {tab === "pricing" && (
        <PricingTab initial={pricing} reportTypes={reportTypes} canEdit={permissions.pricing} onSaved={() => router.refresh()} />
      )}
      {tab === "invoices" && <InvoicesTab engagements={engagements} />}
      {tab === "capacity" && <CapacityTab engagements={engagements} userNames={userNames} />}
      {tab === "deadlines" && <DeadlinesTab engagements={engagements} />}
    </div>
  );
}

// ── Engagements ──────────────────────────────────────────────────────────────

function EngagementsTab({
  engagements,
  users,
  userNames,
  permissions,
  busyId,
  onAction,
}: {
  engagements: EngagementRow[];
  users: UserRow[];
  userNames: Record<string, string>;
  permissions: Props["permissions"];
  busyId: string | null;
  onAction: (row: EngagementRow, body: Record<string, unknown>, okText: string) => Promise<void>;
}) {
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [assignDraft, setAssignDraft] = useState<Record<string, string>>({});
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  if (engagements.length === 0) {
    return (
      <div className="rounded-lg border border-ink-200 bg-white p-8 text-center text-sm text-ink-500">
        No engagements yet. Engagements are created from a case&apos;s damages evaluation or requested by the case team.
      </div>
    );
  }

  function assigneeSummary(row: EngagementRow): string {
    const names = ASSIGN_SLOTS.map((s) => row[s.field]).filter((id): id is string => !!id).map((id) => userNames[id] ?? "Unknown");
    return names.length ? names.join(", ") : "—";
  }

  function advanceOptions(status: string): EngagementStatus[] {
    return (ENGAGEMENT_TRANSITIONS[status as EngagementStatus] ?? []).filter(
      // AUTHORIZED is reached via the authorize action; CANCELLED via cancel.
      (s) => s !== "CANCELLED" && s !== "AUTHORIZED" && s !== "RECORDS_PENDING",
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-ink-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
          <tr>
            <th className="px-4 py-2.5">Case</th>
            <th className="px-4 py-2.5">Report</th>
            <th className="px-4 py-2.5">Status</th>
            <th className="px-4 py-2.5">Fee</th>
            <th className="px-4 py-2.5">ECD</th>
            <th className="px-4 py-2.5">Assignees</th>
            <th className="px-4 py-2.5 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {engagements.map((row) => (
            <>
              <tr key={row.id} className="border-b border-ink-100 last:border-b-0">
                <td className="px-4 py-2.5 font-medium text-ink-900">{row.caseNumber}</td>
                <td className="px-4 py-2.5 text-ink-700">{reportLabel(row.reportType)}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{statusLabel(row.status)}</Badge>
                  {row.status === "RECORDS_PENDING" && row.missingRequirements.length > 0 && (
                    <span className="ml-2 text-xs text-amber-700">missing: {row.missingRequirements.join(", ").toLowerCase()}</span>
                  )}
                  {row.status === "CANCELLED" && row.cancellationStatus && (
                    <span className="ml-2 text-xs text-ink-500" title={row.cancellationStatus}>
                      {row.cancellationStatus.length > 40 ? `${row.cancellationStatus.slice(0, 40)}…` : row.cancellationStatus}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-ink-700">
                  {row.feeEstimate != null ? formatMoney(row.feeEstimate) : "—"}
                  {row.feeStructure && <span className="ml-1 text-xs text-ink-400">{row.feeStructure.toLowerCase()}</span>}
                </td>
                <td className="px-4 py-2.5 text-ink-700">{formatDate(row.estimatedCompletionDate)}</td>
                <td className="px-4 py-2.5 text-ink-700">{assigneeSummary(row)}</td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {AUTHORIZABLE.has(row.status) && (
                      <ActionButton
                        label={row.status === "RECORDS_PENDING" ? "Re-check records" : "Authorize"}
                        disabled={!permissions.authorize || busyId === row.id}
                        title={permissions.authorize ? undefined : "Requires report.export or team.manage"}
                        onClick={() => onAction(row, { action: "authorize" }, `Engagement for ${row.caseNumber} authorized.`)}
                      />
                    )}
                    {ASSIGNABLE.has(row.status) && (
                      <ActionButton
                        label={assigningId === row.id ? "Close" : "Assign"}
                        disabled={!permissions.manage || busyId === row.id}
                        title={permissions.manage ? undefined : "Requires team.manage or case.edit"}
                        onClick={() => {
                          setCancellingId(null);
                          if (assigningId === row.id) {
                            setAssigningId(null);
                          } else {
                            setAssigningId(row.id);
                            setAssignDraft(
                              Object.fromEntries(ASSIGN_SLOTS.map((s) => [s.key, row[s.field] ?? ""])),
                            );
                          }
                        }}
                      />
                    )}
                    {advanceOptions(row.status).map((next) => (
                      <ActionButton
                        key={next}
                        label={`→ ${statusLabel(next)}`}
                        disabled={!permissions.manage || busyId === row.id}
                        title={permissions.manage ? undefined : "Requires team.manage or case.edit"}
                        onClick={() =>
                          onAction(row, { action: "advance", status: next }, `${row.caseNumber} moved to ${statusLabel(next)}.`)
                        }
                      />
                    ))}
                    {!TERMINAL.has(row.status) && (
                      <ActionButton
                        label={cancellingId === row.id ? "Close" : "Cancel"}
                        danger
                        disabled={!permissions.manage || busyId === row.id}
                        title={permissions.manage ? undefined : "Requires team.manage or case.edit"}
                        onClick={() => {
                          setAssigningId(null);
                          setCancelReason("");
                          setCancellingId(cancellingId === row.id ? null : row.id);
                        }}
                      />
                    )}
                  </div>
                </td>
              </tr>
              {assigningId === row.id && (
                <tr key={`${row.id}-assign`} className="border-b border-ink-100 bg-ink-50/60">
                  <td colSpan={7} className="px-4 py-3">
                    <div className="flex flex-wrap items-end gap-3">
                      {ASSIGN_SLOTS.map((slot) => (
                        <label key={slot.key} className="text-xs text-ink-600">
                          {slot.label}
                          <select
                            className="mt-1 block rounded-md border border-ink-200 bg-white px-2 py-1.5 text-sm"
                            value={assignDraft[slot.key] ?? ""}
                            onChange={(e) => setAssignDraft((d) => ({ ...d, [slot.key]: e.target.value }))}
                          >
                            <option value="">— unassigned —</option>
                            {users.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.name} ({u.role})
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                      <button
                        className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                        disabled={busyId === row.id}
                        onClick={async () => {
                          const body: Record<string, unknown> = { action: "assign" };
                          for (const slot of ASSIGN_SLOTS) body[slot.key] = assignDraft[slot.key] || null;
                          await onAction(row, body, `Experts assigned on ${row.caseNumber}.`);
                          setAssigningId(null);
                        }}
                      >
                        Save assignments
                      </button>
                    </div>
                  </td>
                </tr>
              )}
              {cancellingId === row.id && (
                <tr key={`${row.id}-cancel`} className="border-b border-ink-100 bg-red-50/50">
                  <td colSpan={7} className="px-4 py-3">
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="grow text-xs text-ink-600">
                        Cancellation reason (required)
                        <input
                          className="mt-1 block w-full rounded-md border border-ink-200 bg-white px-2 py-1.5 text-sm"
                          value={cancelReason}
                          onChange={(e) => setCancelReason(e.target.value)}
                          placeholder="e.g. Client withdrew the engagement request"
                        />
                      </label>
                      <button
                        className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                        disabled={busyId === row.id || cancelReason.trim().length === 0}
                        onClick={async () => {
                          await onAction(row, { action: "cancel", reason: cancelReason.trim() }, `Engagement on ${row.caseNumber} cancelled.`);
                          setCancellingId(null);
                        }}
                      >
                        Confirm cancellation
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  title,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}) {
  return (
    <button
      className={cn(
        "rounded-md border px-2 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40",
        danger ? "border-red-200 text-red-700 hover:bg-red-50" : "border-ink-200 text-ink-700 hover:bg-ink-50",
      )}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {label}
    </button>
  );
}

// ── Pricing ──────────────────────────────────────────────────────────────────

function PricingTab({
  initial,
  reportTypes,
  canEdit,
  onSaved,
}: {
  initial: Record<string, PricingEntry>;
  reportTypes: { id: string; name: string }[];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>(() =>
    Object.fromEntries(
      reportTypes.map((rt) => [
        rt.id,
        {
          fixed: initial[rt.id]?.fixed?.toString() ?? "",
          hourly: initial[rt.id]?.hourly?.toString() ?? "",
          rush: initial[rt.id]?.rush?.toString() ?? "",
          turnaroundDays: initial[rt.id]?.turnaroundDays?.toString() ?? "",
        },
      ]),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const FIELDS = [
    { key: "fixed", label: "Fixed fee ($)" },
    { key: "hourly", label: "Hourly ($)" },
    { key: "rush", label: "Rush fee ($)" },
    { key: "turnaroundDays", label: "Turnaround (days)" },
  ] as const;

  async function save() {
    setSaving(true);
    setMessage(null);
    const pricing: Record<string, Record<string, number>> = {};
    for (const [reportType, entry] of Object.entries(draft)) {
      const out: Record<string, number> = {};
      for (const f of FIELDS) {
        const raw = entry[f.key]?.trim();
        if (!raw) continue;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          setMessage({ kind: "error", text: `Invalid ${f.label.toLowerCase()} for ${reportType}: "${raw}"` });
          setSaving(false);
          return;
        }
        out[f.key] = n;
      }
      if (Object.keys(out).length > 0) pricing[reportType] = out;
    }
    try {
      const res = await fetch("/api/firm/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pricing }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({
          kind: "error",
          text: res.status === 403 ? `Not permitted: ${data.error ?? "pricing changes require firm settings access."}` : data.error ?? "Save failed.",
        });
      } else {
        setMessage({ kind: "ok", text: "Pricing configuration saved." });
        onSaved();
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — pricing was not saved." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-ink-200 bg-white">
      <div className="flex items-center justify-between border-b border-ink-200 bg-ink-50 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-ink-900">Engagement pricing per report type</div>
          <div className="text-xs text-ink-500">
            Drives fee estimates and estimated completion dates for new engagements. Every change is audited.
          </div>
        </div>
        <button
          className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          onClick={save}
          disabled={saving || !canEdit}
          title={canEdit ? undefined : "Requires firm.settings (firm administrator)"}
        >
          {saving ? "Saving…" : "Save pricing"}
        </button>
      </div>
      {!canEdit && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          Read-only: changing pricing requires firm settings access (firm administrator).
        </div>
      )}
      {message && (
        <div
          className={cn(
            "border-b px-4 py-2 text-xs",
            message.kind === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800",
          )}
        >
          {message.text}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2.5">Report type</th>
              {FIELDS.map((f) => (
                <th key={f.key} className="px-4 py-2.5">
                  {f.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {reportTypes.map((rt) => (
              <tr key={rt.id} className="border-b border-ink-100 last:border-b-0">
                <td className="px-4 py-2 font-medium text-ink-800">{rt.name}</td>
                {FIELDS.map((f) => (
                  <td key={f.key} className="px-4 py-2">
                    <input
                      className="w-28 rounded-md border border-ink-200 px-2 py-1 text-sm disabled:bg-ink-50"
                      inputMode="decimal"
                      disabled={!canEdit}
                      value={draft[rt.id]?.[f.key] ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [rt.id]: { ...d[rt.id], [f.key]: e.target.value } }))}
                      placeholder="—"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Invoices (derived — engagement-fee-as-invoice v1) ────────────────────────

function InvoicesTab({ engagements }: { engagements: EngagementRow[] }) {
  // An invoice line is any engagement that was authorized with a fee estimate.
  const rows = engagements.filter((e) => e.feeEstimate != null && e.authorizedAt != null);
  const invoiceStatus = (e: EngagementRow) =>
    e.status === "CANCELLED" ? "Void" : e.status === "DELIVERED" || e.status === "COMPLETED" ? "Due" : "Pending";
  const tone: Record<string, BadgeTone> = { Void: "neutral", Due: "success", Pending: "warning" };
  const totalDue = rows.filter((e) => invoiceStatus(e) === "Due").reduce((s, e) => s + (e.feeEstimate ?? 0), 0);

  return (
    <div className="rounded-lg border border-ink-200 bg-white">
      <div className="flex items-center justify-between border-b border-ink-200 bg-ink-50 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-ink-900">Invoices derived from engagements</div>
          <div className="text-xs text-ink-500">
            v1: the authorized engagement fee is the invoice — no separate invoice ledger. Due on delivery; void on cancellation.
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold text-ink-900">{formatMoney(totalDue)}</div>
          <div className="text-xs text-ink-500">Total due</div>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-ink-500">No billable engagements yet — invoices appear once an engagement with a fee is authorized.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2.5">Invoice</th>
              <th className="px-4 py-2.5">Case</th>
              <th className="px-4 py-2.5">Report</th>
              <th className="px-4 py-2.5">Authorized</th>
              <th className="px-4 py-2.5">Amount</th>
              <th className="px-4 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="border-b border-ink-100 last:border-b-0">
                <td className="px-4 py-2.5 font-mono text-xs text-ink-600">ENG-{e.id.slice(0, 8).toUpperCase()}</td>
                <td className="px-4 py-2.5 font-medium text-ink-900">{e.caseNumber}</td>
                <td className="px-4 py-2.5 text-ink-700">{reportLabel(e.reportType)}</td>
                <td className="px-4 py-2.5 text-ink-700">{formatDate(e.authorizedAt)}</td>
                <td className="px-4 py-2.5 text-ink-900">{formatMoney(e.feeEstimate ?? 0)}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={tone[invoiceStatus(e)]}>{invoiceStatus(e)}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Capacity ─────────────────────────────────────────────────────────────────

function CapacityTab({ engagements, userNames }: { engagements: EngagementRow[]; userNames: Record<string, string> }) {
  const openRows = engagements.filter((e) => !TERMINAL.has(e.status));
  const counts = new Map<string, { total: number; roles: Map<string, number> }>();
  for (const e of openRows) {
    for (const slot of ASSIGN_SLOTS) {
      const id = e[slot.field];
      if (!id) continue;
      const entry = counts.get(id) ?? { total: 0, roles: new Map<string, number>() };
      entry.total += 1;
      entry.roles.set(slot.label, (entry.roles.get(slot.label) ?? 0) + 1);
      counts.set(id, entry);
    }
  }
  const rows = [...counts.entries()].sort((a, b) => b[1].total - a[1].total);
  const unassigned = openRows.filter((e) => ASSIGN_SLOTS.every((s) => !e[s.field])).length;

  return (
    <div className="rounded-lg border border-ink-200 bg-white">
      <div className="border-b border-ink-200 bg-ink-50 px-4 py-3">
        <div className="text-sm font-semibold text-ink-900">Open engagements per assignee</div>
        <div className="text-xs text-ink-500">
          {openRows.length} open engagement{openRows.length === 1 ? "" : "s"} · {unassigned} fully unstaffed
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-ink-500">No experts are assigned to open engagements yet.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2.5">Assignee</th>
              <th className="px-4 py-2.5">Open engagements</th>
              <th className="px-4 py-2.5">Roles</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([userId, entry]) => (
              <tr key={userId} className="border-b border-ink-100 last:border-b-0">
                <td className="px-4 py-2.5 font-medium text-ink-900">{userNames[userId] ?? "Unknown user"}</td>
                <td className="px-4 py-2.5 text-ink-700">{entry.total}</td>
                <td className="px-4 py-2.5 text-ink-600">
                  {[...entry.roles.entries()].map(([role, n]) => `${role} ×${n}`).join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Deadlines ────────────────────────────────────────────────────────────────

function DeadlinesTab({ engagements }: { engagements: EngagementRow[] }) {
  const rows = engagements
    .filter((e) => !TERMINAL.has(e.status) && e.estimatedCompletionDate != null)
    .sort((a, b) => (a.estimatedCompletionDate! < b.estimatedCompletionDate! ? -1 : 1));
  const now = Date.now();

  return (
    <div className="rounded-lg border border-ink-200 bg-white">
      <div className="border-b border-ink-200 bg-ink-50 px-4 py-3">
        <div className="text-sm font-semibold text-ink-900">Estimated completion dates</div>
        <div className="text-xs text-ink-500">Open engagements sorted by ECD — earliest first.</div>
      </div>
      {rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-ink-500">
          No open engagements carry an estimated completion date. Set turnaround days in Pricing so new engagements get one automatically.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2.5">ECD</th>
              <th className="px-4 py-2.5">Case</th>
              <th className="px-4 py-2.5">Report</th>
              <th className="px-4 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const overdue = new Date(e.estimatedCompletionDate!).getTime() < now;
              return (
                <tr key={e.id} className="border-b border-ink-100 last:border-b-0">
                  <td className={cn("px-4 py-2.5 font-medium", overdue ? "text-red-700" : "text-ink-900")}>
                    {formatDate(e.estimatedCompletionDate)}
                    {overdue && <Badge tone="danger" className="ml-2">Overdue</Badge>}
                  </td>
                  <td className="px-4 py-2.5 text-ink-700">{e.caseNumber}</td>
                  <td className="px-4 py-2.5 text-ink-700">{reportLabel(e.reportType)}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={STATUS_TONE[e.status] ?? "neutral"}>{statusLabel(e.status)}</Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
