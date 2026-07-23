// Physician Learning analytics (Reliability Phase 8) — aggregates the review
// ledger (RecommendationTransition) and approval-invalidation metadata into a
// quality-improvement scorecard. Read-only.
//   npx tsx scripts/review-analytics.ts
import { prisma } from "../src/lib/db";

async function main() {
  const transitions = await prisma.recommendationTransition.findMany({
    select: { newStatus: true, priorStatus: true, comment: true, modifiedFields: true, materialChange: true, itemId: true },
  });
  const items = await prisma.futureCareItem.findMany({ select: { id: true, category: true, service: true } });
  const catOf = new Map(items.map((i) => [i.id, i.category]));
  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  const rejectionsByCategory = new Map<string, number>();
  const modifiedFieldCounts = new Map<string, number>();
  let approvals = 0, rejections = 0, modifications = 0, reopens = 0, invalidations = 0;
  for (const t of transitions) {
    if (t.newStatus === "PHYSICIAN_APPROVED") approvals++;
    if (t.newStatus === "PHYSICIAN_REJECTED") { rejections++; count(rejectionsByCategory, catOf.get(t.itemId) ?? "UNKNOWN"); }
    if (t.newStatus === "PHYSICIAN_MODIFIED") { modifications++; for (const f of (t.modifiedFields as string[] | null) ?? []) count(modifiedFieldCounts, f); }
    if (t.priorStatus?.startsWith("PHYSICIAN") && t.newStatus === "AI_DRAFT") reopens++;
  }
  invalidations = await prisma.auditLog.count({ where: { action: "reasoning.approval_invalidated" } });
  const top = (m: Map<string, number>, n = 5) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  console.log("── Physician Learning scorecard ─────────────────────────────");
  console.log(`Review actions: ${approvals} approved · ${modifications} modified · ${rejections} rejected · ${reopens} reopened`);
  console.log(`Approval invalidations (material change after sign-off): ${invalidations}`);
  console.log("Most-corrected parameters:", top(modifiedFieldCounts).map(([k, v]) => `${k}×${v}`).join(", ") || "(none)");
  console.log("Most-rejected categories:", top(rejectionsByCategory).map(([k, v]) => `${k}×${v}`).join(", ") || "(none)");
  const mods = transitions.filter((t) => t.comment).slice(-5);
  console.log("Recent documented reasons:"); for (const m of mods) console.log("  •", m.comment!.slice(0, 90));
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
