"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";

// The platform operator's editorial-lesson queue.
//
// STYLE approval sits with the operator because adopting a lesson is a standing
// change to how every future case in a firm is processed. It cannot run through
// canonical permissions: learning.approve is platformOnly, and authorize()
// denies those at step 1 for every firm user. It goes through the explicit
// platform grant instead, on this surface, cross-tenant by design and audited
// with both the actor's firm and the target's.

export interface PlatformLearningRow {
  id: string;
  firmId: string;
  firmName: string;
  guidance: string;
  mechanism: string;
  failureCode: string;
  supportCount: number;
  safetyClean: boolean | null;
}

export function PlatformLearningQueue({ rows }: { rows: PlatformLearningRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const decide = useCallback(
    async (id: string, action: "approve" | "reject", body: Record<string, unknown> = {}) => {
      setBusy(`${id}:${action}`);
      setErr(null);
      try {
        const res = await fetch(`/api/platform/learning/candidates/${id}/decide`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...body }),
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

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-ink-900">Editorial lessons awaiting adoption</h3>
        {rows.length > 0 && <Badge tone="warning">{rows.length}</Badge>}
      </div>
      <p className="mt-1 text-xs text-ink-500">
        Across every tenant. Adopting one changes how that firm&rsquo;s future cases are processed, which is why it rests here
        rather than with firm administration. Clinical lessons never appear on this surface — they need a credentialed physician
        on the firm&rsquo;s own review surface.
      </p>
      {err && <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}
      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-ink-500">Nothing awaiting adoption.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded-lg bg-ink-50/70 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="info">editorial</Badge>
                <span className="font-semibold text-ink-900">{row.firmName}</span>
                <span className="text-ink-500">
                  {row.mechanism.toLowerCase().replace(/_/g, " ")} · {row.failureCode.toLowerCase().replace(/_/g, " ")}
                </span>
                <span className="ml-auto text-ink-500">{row.supportCount} supporting correction{row.supportCount === 1 ? "" : "s"}</span>
              </div>
              <p className="mt-2 text-ink-800">{row.guidance}</p>
              {row.safetyClean !== true && <p className="mt-1 text-red-700">Did not clear the safety metrics and cannot be adopted.</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-2">
                <button
                  className="rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                  disabled={busy !== null || row.safetyClean !== true}
                  onClick={() => void decide(row.id, "approve")}
                >
                  {busy === `${row.id}:approve` ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null} Adopt
                </button>
                <button
                  className="rounded-md border border-ink-300 bg-white px-2.5 py-1 text-xs font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => {
                    const reason = window.prompt("Why is this lesson being refused? The reason is recorded with the decision.");
                    if (reason && reason.trim()) void decide(row.id, "reject", { reason });
                  }}
                >
                  {busy === `${row.id}:reject` ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null} Refuse
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
