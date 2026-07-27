// One-time backfill: classify existing FutureCareItems' origin by matching
// their service against the template libraries. Inference only — items whose
// service matches no library row keep the default TEMPLATE_CONDITION with a
// null templateRuleId (honestly unclassified rather than guessed).
import { prisma } from "../src/lib/db";
import { CONDITION_CARE, BASELINE_CARE } from "../src/lib/engine/careLibrary";
import { GENERAL_CARE } from "../src/lib/engine/specialty";

const ruleId = (scope: string, svc: string) => `${scope}:${svc.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

async function main() {
  const index = new Map<string, { origin: "TEMPLATE_CONDITION" | "TEMPLATE_BASELINE" | "TEMPLATE_SPECIALTY"; conditionKey: string | null; templateRuleId: string }>();
  for (const t of GENERAL_CARE) index.set(t.service.trim().toLowerCase(), { origin: "TEMPLATE_SPECIALTY", conditionKey: null, templateRuleId: ruleId("specialty", t.service) });
  for (const [k, list] of Object.entries(CONDITION_CARE)) for (const t of list) index.set(t.service.trim().toLowerCase(), { origin: "TEMPLATE_CONDITION", conditionKey: k, templateRuleId: ruleId(k, t.service) });
  for (const t of BASELINE_CARE) index.set(t.service.trim().toLowerCase(), { origin: "TEMPLATE_BASELINE", conditionKey: null, templateRuleId: ruleId("baseline", t.service) });

  const items = await prisma.futureCareItem.findMany({ select: { id: true, service: true, templateRuleId: true } });
  let tagged = 0, unmatched = 0;
  for (const it of items) {
    if (it.templateRuleId) continue;
    const hit = index.get(it.service.trim().toLowerCase());
    if (!hit) { unmatched++; continue; }
    await prisma.futureCareItem.update({ where: { id: it.id }, data: hit });
    tagged++;
  }
  console.log(`Backfilled origin on ${tagged} item(s); ${unmatched} unmatched (left unclassified).`);
  await prisma.$disconnect();
}
main();
