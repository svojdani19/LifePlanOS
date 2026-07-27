// ─────────────────────────────────────────────────────────────────────────────
// Attestation persistence. Wraps the pure attestation engine with the
// immutability rules: sign (superseding the physician's prior signature),
// verify-and-invalidate on material drift, and read with live verification.
// Attestation rows are never edited or deleted — status transitions only, each
// audited.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/db";
import {
  buildAttestationScope,
  attestationStatement,
  attestationContentHash,
  verifyAttestation,
  type AttestableItem,
  type AttestationScopeEntry,
} from "./attestation";

function currentItemsFor(caseId: string) {
  return prisma.futureCareItem.findMany({
    where: { caseId, supersededAt: null },
    select: {
      id: true,
      lineageId: true,
      version: true,
      service: true,
      category: true,
      probability: true,
      frequencyPerYear: true,
      durationYears: true,
      isLifetime: true,
      unitCost: true,
      presentValue: true,
      physicianStatus: true,
      supersededAt: true,
    },
  });
}

/**
 * Re-verify every ACTIVE attestation on the case against the current plan and
 * INVALIDATE the ones a material change has broken. Called after physician
 * review actions, per-item edits, and plan regeneration; safe to call often
 * (a holding attestation is untouched). Never throws into the caller's flow.
 */
export async function refreshCaseAttestations(caseId: string): Promise<void> {
  const active = await prisma.attestation.findMany({ where: { caseId, status: "ACTIVE" } });
  if (!active.length) return;
  const items = (await currentItemsFor(caseId)) as AttestableItem[];
  for (const att of active) {
    const verdict = verifyAttestation((att.scope as unknown as AttestationScopeEntry[]) ?? [], items);
    if (verdict.valid) continue;
    const reason = verdict.drift.map((d) => `${d.service}: ${d.reason}`).join("; ");
    await prisma.attestation.update({
      where: { id: att.id },
      data: { status: "INVALIDATED", invalidatedAt: new Date(), invalidatedReason: reason },
    });
    await prisma.auditLog.create({
      data: {
        firmId: att.firmId,
        action: "attestation.invalidated",
        targetType: "attestation",
        targetId: att.id,
        caseId,
        meta: { physicianName: att.physicianName, reason },
      },
    });
  }
}

export interface SignResult {
  attestation: { id: string; contentHash: string; itemCount: number; totalPresentValue: number; statementText: string };
  superseded: number;
}

/**
 * Sign: snapshot the physician's identity + credentials, pin the covered
 * recommendation versions, compose and hash the statement, supersede the
 * signer's prior ACTIVE attestation on this case. Throws when nothing is
 * attestable — a signature over zero reviewed items would be meaningless.
 */
export async function signAttestation(opts: {
  caseId: string;
  firmId: string;
  physician: { id: string; name: string; role: string };
  note?: string | null;
}): Promise<SignResult> {
  const { caseId, firmId, physician, note } = opts;
  const [kase, items, signer, latestSnapshot] = await Promise.all([
    prisma.case.findUniqueOrThrow({ where: { id: caseId }, select: { clientName: true, caseNumber: true } }),
    currentItemsFor(caseId),
    prisma.user.findUniqueOrThrow({
      where: { id: physician.id },
      select: { credentialSummary: true, credentials: { select: { type: true, label: true, filename: true }, orderBy: { createdAt: "asc" } } },
    }),
    prisma.caseSnapshot.findFirst({ where: { caseId }, orderBy: { version: "desc" }, select: { version: true } }),
  ]);

  const scope = buildAttestationScope(items as AttestableItem[]);
  if (!scope.length) {
    throw new Error("Nothing to attest: no current recommendation has been physician-approved or physician-modified yet.");
  }
  const totalPresentValue = scope.reduce((s, e) => s + e.presentValue, 0);
  const statementText = attestationStatement({
    physicianName: physician.name,
    credentialSummary: signer.credentialSummary,
    clientName: kase.clientName,
    caseNumber: kase.caseNumber,
    scope,
    totalPresentValue,
  });
  const contentHash = attestationContentHash(statementText, scope);

  const prior = await prisma.attestation.findMany({ where: { caseId, physicianId: physician.id, status: "ACTIVE" }, select: { id: true } });
  const created = await prisma.attestation.create({
    data: {
      firmId,
      caseId,
      physicianId: physician.id,
      physicianName: physician.name,
      physicianRole: physician.role,
      credentialSummary: signer.credentialSummary,
      credentialDocs: signer.credentials as never,
      statementText,
      physicianNote: note ?? null,
      scope: scope as never,
      itemCount: scope.length,
      totalPresentValue,
      caseVersion: latestSnapshot?.version ?? null,
      contentHash,
    },
  });
  if (prior.length) {
    await prisma.attestation.updateMany({
      where: { id: { in: prior.map((p) => p.id) } },
      data: { status: "SUPERSEDED", supersededById: created.id },
    });
  }
  return {
    attestation: {
      id: created.id,
      contentHash,
      itemCount: scope.length,
      totalPresentValue,
      statementText,
    },
    superseded: prior.length,
  };
}
