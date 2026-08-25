"use client";

import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActionStatus } from "@/lib/ui/requestAction";

/**
 * The visible, announced outcome of the last action.
 *
 * Replaces `alert()`, which a screen reader announces detached from the control
 * that caused it, a keyboard user must dismiss before touching anything else,
 * and an embedded browser — where this app is reviewed — suppresses entirely,
 * so the failure was invisible.
 *
 * `role="alert"` on an error carries an implicit `aria-live="assertive"`, which
 * is right: the action did not happen and the user is about to act on the
 * assumption it did. Success is `role="status"` (polite) so a routine save does
 * not interrupt whatever is being read.
 */
export function ActionStatusBar({ status, onDismiss }: { status: ActionStatus | null; onDismiss: () => void }) {
  if (!status) return null;
  const isError = status.kind === "error";
  const Icon = isError ? AlertCircle : CheckCircle2;
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        isError ? "border-red-200 bg-red-50 text-red-900" : "border-emerald-200 bg-emerald-50 text-emerald-900",
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      {/* The detail is kept in full: a message a user cannot act on is no
          better than the modal this replaces. */}
      <p className="min-w-0 flex-1 break-words">{status.message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss message"
        className="focusable -m-1 rounded p-1 text-current opacity-60 hover:opacity-100"
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
