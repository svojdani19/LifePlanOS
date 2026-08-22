"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";

// The approval queue's interactive half. Approve / reject post to the routes
// that already enforce the class gate; this component only decides which
// controls are worth showing, and says plainly why one is unavailable.

export interface LearningRow {
  id: string;
  guidance: string;
  mechanism: string;
  failureCode: string;
  documentClass: string | null;
  scope: string;
  supportCount: number;
  status: string;
  approvalClass: "STYLE" | "CLINICAL";
  safetyClean: boolean | null;
  approvedAt: string | null;
  approverCredential: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  ADOPTED: "success",
  APPROVAL_PENDING: "warning",
  DRAFT: "info",
  EVALUATED: "info",
  REJECTED_BY_REVIEWER: "danger",
  REJECTED_NO_IMPROVEMENT: "danger",
  RETIRED: "neutral",
};

export function LearningQueue({
  rows,
  canApproveStyle,
  canApproveClinical,
  physicianCredentialed,
}: {
  rows: LearningRow[];
  canApproveStyle: boolean;
  canApproveClinical: boolean;
  physicianCredentialed: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const act = useCallback(
    async (id: string, action: "approve" | "reject", body: Record<string, unknown>) => {
      setBusy(`${id}:${action}`);
      setErr(null);
      try {
        const res = await fetch(`/api/learning/candidates/${id}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok || payload.error) setErr(payload.error ?? "The decision could not be recorded.");
        else router.refresh();
      } finally {
        setBusy(null);
      }
    },
    [router],
  );

  const mayDecide = (row: LearningRow) => (row.approvalClass === "CLINICAL" ? canApproveClinical : canApproveStyle);

  const whyNot = (row: LearningRow) =>
    row.approvalClass === "CLINICAL"
      ? physicianCredentialed
        ? "Adopting a clinical lesson is a physician act; your role does not carry it."
        : "This lesson changes what the program asserts about care. It needs a verified physician credential."
      // Was "requires firm-administrator access", which did not match what the
      // server enforces: a firm administrator may see this queue and cannot
      // adopt from it.
      : "Adopting an editorial lesson is a standing change to how every future case is processed, so it rests with the platform operator rather than with firm administration.";

  const pending = rows.filter((r) => r.status === "APPROVAL_PENDING");
  const decided = rows.filter((r) => r.status !== "APPROVAL_PENDING");

  return (
    <div className="space-y-6">
      {err && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}

      <section className="card p-5">
        <h2 className="text-sm font-semibold text-ink-900">Awaiting approval {pending.length ? `(${pending.length})` : ""}</h2>
        {pending.length === 0 ? (
          <p className="mt-2 text-xs text-ink-500">Nothing is waiting. Lessons appear here once they clear held-out evaluation.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {pending.map((row) => (
              <li key={row.id} className="rounded-lg bg-ink-50/70 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={row.approvalClass === "CLINICAL" ? "danger" : "info"}>
                    {row.approvalClass === "CLINICAL" ? "clinical" : "editorial"}
                  </Badge>
                  <span className="font-mono text-[11px] text-ink-500">{row.mechanism.toLowerCase().replace(/_/g, " ")}</span>
                  <span className="text-ink-500">
                    {row.failureCode.toLowerCase().replace(/_/g, " ")}
                    {row.documentClass ? ` · ${row.documentClass.toLowerCase().replace(/_/g, " ")}` : ""}
                  </span>
                  <span className="ml-auto text-ink-500">{row.supportCount} supporting correction{row.supportCount === 1 ? "" : "s"}</span>
                </div>
                <p className="mt-2 text-ink-800">{row.guidance}</p>
                {row.safetyClean !== true && (
                  <p className="mt-1 text-red-700">This candidate did not clear the safety metrics and cannot be adopted.</p>
                )}
                <div className="mt-2 border-t border-ink-100 pt-2">
                  {mayDecide(row) ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        className="rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                        disabled={busy !== null || row.safetyClean !== true}
                        onClick={() => void act(row.id, "approve", {})}
                      >
                        {busy === `${row.id}:approve` ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null} Adopt
                      </button>
                      <button
                        className="rounded-md border border-ink-300 bg-white px-2.5 py-1 text-xs font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
                        disabled={busy !== null}
                        onClick={() => {
                          const reason = window.prompt("Why is this lesson being refused? The reason is recorded with the decision.");
                          if (reason && reason.trim()) void act(row.id, "reject", { reason });
                        }}
                      >
                        {busy === `${row.id}:reject` ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null} Refuse
                      </button>
                    </div>
                  ) : (
                    <p className="text-ink-500">{whyNot(row)}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-5">
        <h2 className="text-sm font-semibold text-ink-900">Decided</h2>
        <p className="mt-1 text-xs text-ink-500">
          What the firm accepted, and what it declined. A refusal keeps its row and its reason: what a firm chose not to learn
          belongs beside what it did.
        </p>
        {decided.length === 0 ? (
          <p className="mt-2 text-xs text-ink-500">No decisions recorded yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {decided.map((row) => (
              <li key={row.id} className="rounded-lg bg-ink-50/40 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status.toLowerCase().replace(/_/g, " ")}</Badge>
                  <Badge tone={row.approvalClass === "CLINICAL" ? "danger" : "info"}>
                    {row.approvalClass === "CLINICAL" ? "clinical" : "editorial"}
                  </Badge>
                  <span className="text-ink-700">{row.guidance}</span>
                </div>
                {row.approvedAt && (
                  <p className="mt-1 text-ink-500">
                    Adopted {new Date(row.approvedAt).toLocaleDateString()}
                    {row.approverCredential ? ` · ${row.approverCredential}` : ""}
                  </p>
                )}
                {row.rejectedAt && <p className="mt-1 text-ink-500">Refused {new Date(row.rejectedAt).toLocaleDateString()} — {row.rejectionReason}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
