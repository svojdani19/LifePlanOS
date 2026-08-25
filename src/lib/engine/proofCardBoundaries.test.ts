import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildProofCard } from "@/lib/engine/proofCard";
import type { LedgerRow } from "@/lib/engine/evidenceLedger";

// ─────────────────────────────────────────────────────────────────────────────
// Role, tenant and redaction boundaries around the attorney proof card.
//
// The card is a NARROWING of what an attorney already sees, not a widening: it
// summarises the same per-item ledger the dossier below it renders. These pin
// the properties that make that true, because the failure mode — a "concise"
// view that reaches for evidence the role is not entitled to, or quotes an
// unrelated record — is invisible until somebody reads a deposition transcript.
// ─────────────────────────────────────────────────────────────────────────────

const SRC = join(process.cwd(), "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
/** Comments quote the old behaviour verbatim; matching them would be vacuous. */
const stripComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

const row = (over: Partial<LedgerRow> = {}): LedgerRow =>
  ({
    futureCareItemId: "item-1", conditionId: null, claim: "NECESSITY", stance: "SUPPORTS",
    strength: "OBJECTIVE", sourceKind: "RECORD_CLAIM", sourceDocumentId: "doc-1", encounterId: "e",
    chronologyEventId: null, page: 1, field: "assessment", quote: "q", recordedOn: null,
    sourceFingerprint: null, verbatim: true, producerVersion: "v1", ...over,
  }) as LedgerRow;

describe("the proof card never widens what a role may see", () => {
  it("renders no monetary field, so pricing redaction has nothing to leak", () => {
    const view = stripComments(read("components/case/ProofCardView.tsx"));
    for (const money of ["presentValue", "lifetimeCost", "unitCost", "annualCost", "lowCost", "highCost", "formatMoney"]) {
      expect(view, money).not.toContain(money);
    }
  });

  it("is rendered only in the attorney view, from the item's own dossier", () => {
    const workspace = stripComments(read("components/case/CaseWorkspace.tsx"));
    // The card is inside an `attorneyView &&` guard…
    expect(workspace).toMatch(/attorneyView && \(\(\) => \{[\s\S]{0,600}?ProofCardView/);
    // …and it is fed the per-item ledger, never a raw document blob.
    expect(workspace).toMatch(/ledger: \(dossier\.ledger \?\? \[\]\)/);
    for (const raw of ["extractedText", "documents.map", "rawText"]) {
      expect(workspace.match(/ProofCardView[\s\S]{0,400}/)?.[0] ?? "", raw).not.toContain(raw);
    }
  });

  it("selects from ledger rows only — there is no text search in the module", () => {
    const mod = stripComments(read("lib/engine/proofCard.ts"));
    // No document text, no regex scanning, no indexOf over a blob.
    for (const f of ["extractedText", "indexOf(", "RegExp"]) {
      expect(mod, f).not.toContain(f);
    }
  });

  it("cannot show another item's evidence even when handed it", () => {
    const card = buildProofCard({
      item: { id: "item-1", supportClass: "RECORD_RECOMMENDED" },
      ledger: [row({ futureCareItemId: "item-2", quote: "another recommendation's proof", strength: "DIAGNOSIS" })],
    });
    expect(card.strongestSupport).toBeNull();
    expect(card.strongestOpposing).toBeNull();
  });

  it("scopes by item id before ranking, not after", () => {
    // A stronger row belonging to another item must not win and then be
    // filtered out — it must never be a candidate.
    const card = buildProofCard({
      item: { id: "item-1", supportClass: "RECORD_RECOMMENDED" },
      ledger: [
        row({ futureCareItemId: "item-2", strength: "DIAGNOSIS", quote: "stronger, but not ours" }),
        row({ futureCareItemId: "item-1", strength: "REPORTED", quote: "weaker, and ours" }),
      ],
    });
    expect(card.strongestSupport?.quote).toBe("weaker, and ours");
  });

  it("links a source document only through the case-scoped document route", () => {
    const view = stripComments(read("components/case/ProofCardView.tsx"));
    // The route enforces tenant and case scope; a bare storage URL would not.
    expect(view).toMatch(/\/api\/cases\/\$\{caseId\}\/documents\/\$\{citation\.sourceDocumentId\}\/view/);
    expect(view).not.toMatch(/https?:\/\//);
  });

  it("says explicitly when nothing contradicts the item", () => {
    // Silence would read as "nothing to worry about"; the absence of a search
    // is not the absence of a problem.
    const view = stripComments(read("components/case/ProofCardView.tsx"));
    expect(view).toContain("No accepted record in this case argues against it.");
  });

  it("keeps the full clinical workspace out of the attorney card", () => {
    const view = stripComments(read("components/case/ProofCardView.tsx"));
    // The dossier's clinical buckets stay in the dossier.
    for (const bucket of ["guidelines", "literature", "potentialChallenges", "objectiveFindings", "priorHistory"]) {
      expect(view, bucket).not.toContain(bucket);
    }
  });
});
