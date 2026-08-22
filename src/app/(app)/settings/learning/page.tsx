import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireContext, canCanonicalPermission } from "@/lib/tenant";
import { listCandidates } from "@/lib/learning/candidateService";
import { hasVerifiedCredential } from "@/lib/authz/credentialGate";
import { parseApprovalClass } from "@/lib/learning/approvalClass";
import { LearningQueue } from "@/components/learning/LearningQueue";

// ─────────────────────────────────────────────────────────────────────────────
// The learning approval queue.
//
// The approval API existed with no way to reach it: candidates were promoted
// and evaluated by server code, and nobody could see the queue, let alone
// approve or refuse an entry. A gate nobody can operate is not a gate.
//
// Deliberately small — the existing settings-page shell, the existing table
// conventions, one new link from the Firm Admin hub. No navigation redesign.
//
// The page shows every candidate the firm has. What a given reader may DO with
// one depends on the candidate's own class, and is decided server-side on every
// request; the flags below only decide which buttons are worth rendering.
// ─────────────────────────────────────────────────────────────────────────────

export default async function LearningPage() {
  const ctx = await requireContext();
  // Canonical evaluation, not the legacy 14-permission role map: the learning
  // keys are organisation-scoped and credential-aware, and widening the legacy
  // union to reach them would change what every legacy role can do.
  if (!canCanonicalPermission(ctx, "learning.view")) redirect("/dashboard");

  const [candidates, physicianCredentialed] = await Promise.all([
    listCandidates(ctx.firm.id, { limit: 100 }),
    hasVerifiedCredential(ctx, "PHYSICIAN"),
  ]);

  // Who may adopt what:
  //   editorial (STYLE) — the platform operator, the product's designated
  //     all-access authority. A firm administrator sees the queue and cannot
  //     adopt from it; adopting is a standing change to how every future case
  //     in the firm is processed, not a per-case decision.
  //   clinical (FACT)   — a credentialed physician. Holding the seat is not
  //     holding the credential.
  // The routes enforce both again, regardless of what is rendered here.
  // learning.approve is platformOnly, and authorize() denies platformOnly keys
  // at step 1 for every firm user — so this can never be true on this surface,
  // and asking it would only render a control the server refuses. Editorial
  // lessons are decided by the platform operator on the platform surface.
  const canApproveStyle = false;
  const canApproveClinical = canCanonicalPermission(ctx, "learning.approve_clinical") && physicianCredentialed;

  const rows = candidates.map((c) => ({
    id: c.id,
    guidance: c.guidance,
    mechanism: c.mechanism,
    failureCode: c.failureCode,
    documentClass: c.documentClass,
    scope: c.scope,
    supportCount: c.supportCount,
    status: c.status,
    approvalClass: parseApprovalClass(c.approvalClass),
    safetyClean: c.safetyClean ?? null,
    approvedAt: c.approvedAt ? c.approvedAt.toISOString() : null,
    approverCredential: c.approverCredential,
    rejectedAt: c.rejectedAt ? c.rejectedAt.toISOString() : null,
    rejectionReason: c.rejectionReason,
  }));

  return (
    <div>
      <Link href="/firm-admin" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-800">
        <ArrowLeft className="h-4 w-4" /> Firm Admin
      </Link>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-900">Learned Lessons</h1>
        <p className="mt-1 text-sm text-ink-600">
          Corrections this firm made, generalised into fact-free guidance and measured against held-out cases. Passing that
          measurement earns a lesson the right to be considered — never adoption. A person adopts it, and which person depends on
          what the lesson changes.
        </p>
      </div>
      <LearningQueue
        rows={rows}
        canApproveStyle={canApproveStyle}
        canApproveClinical={canApproveClinical}
        physicianCredentialed={physicianCredentialed}
      />
    </div>
  );
}
