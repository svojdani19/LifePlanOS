import type { CareCategory } from "@/generated/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Reference-source registry — the professional databases and guideline sources a
// certified life-care planner relies on, categorized by role:
//   • PRICING      — cost of a coded service, drug, or item (FAIR Health, GoodRx,
//                    Genworth, DME-Direct, RinellaPro, Healix, Rs Medical, …)
//   • GUIDELINE    — evidence-based treatment / medical-necessity guidance (ODG,
//                    Orthobullets, ICSI, AAPM)
//   • REFERENCE    — clinical reference texts (StatPearls, Healthline)
//   • UTILIZATION  — utilization / prevalence studies (Milliman)
//   • LITERATURE   — a specific peer-reviewed article (e.g. opioid weaning)
//
// This is the single source of truth for (a) which pricing source backs each
// care category, (b) which guideline/evidence sources apply to a recommendation,
// and (c) the References appendix. Live lookups (FAIR Health by CPT+ZIP, GoodRx,
// Genworth) are pluggable through the pricing seam (pricingProvider.ts) and stay
// dormant until credentialed; the labels here are what the report cites either
// way. Pure data + selectors — no network.
// ─────────────────────────────────────────────────────────────────────────────

export type SourceRole = "pricing" | "guideline" | "reference" | "utilization" | "literature";

export interface ReferenceSource {
  id: string;
  name: string;
  url?: string;
  role: SourceRole;
  /** short label for a recommendation's pricing-basis / evidence-basis line */
  label: string;
  /** full citation + methodology for the References appendix */
  citation: string;
  /** care categories this PRICING source values (pricing role only) */
  prices?: CareCategory[];
  /** body regions or care areas this GUIDELINE/REFERENCE source is apt for; empty = general */
  applies?: string[];
}

// ── Pricing sources ──────────────────────────────────────────────────────────
const CODED_SERVICES: CareCategory[] = [
  "PHYSICIAN_VISIT", "SPECIALIST_VISIT", "PRIMARY_CARE", "ORTHOPEDIC_SURGERY", "NEUROSURGERY",
  "NEUROLOGY", "PMR", "PAIN_MANAGEMENT", "PSYCH", "PHYSICAL_THERAPY", "OCCUPATIONAL_THERAPY",
  "SPEECH_THERAPY", "COGNITIVE_THERAPY", "INJECTION", "IMAGING", "FUTURE_SURGERY",
  "REVISION_SURGERY", "COMPLICATION_MANAGEMENT", "CASE_MANAGEMENT",
];

export const SOURCES: ReferenceSource[] = [
  {
    id: "fairhealth", name: "FAIR Health", url: "https://www.fairhealth.org", role: "pricing",
    label: "FAIR Health (80th percentile by CPT/ZIP)",
    citation: "FAIR Health (fairhealth.org) — actual billed charges by 5-digit CPT code and ZIP code; the 50th/80th percentile is the recognized amount under CLCP methodology.",
    prices: CODED_SERVICES,
  },
  {
    id: "goodrx", name: "GoodRx", url: "https://www.goodrx.com", role: "pricing",
    label: "GoodRx (median generic retail)",
    citation: "GoodRx (goodrx.com) — consumer retail pharmaceutical pricing; the median price of the generic (where available) is used.",
    prices: ["MEDICATION"],
  },
  {
    id: "genworth", name: "Genworth Cost of Care Survey", url: "https://www.genworth.com", role: "pricing",
    label: "Genworth Cost of Care Survey",
    citation: "Genworth Cost of Care Survey (genworth.com) — regional cost of home health aide, homemaker, and skilled-nursing care.",
    prices: ["ATTENDANT_CARE", "SKILLED_NURSING"],
  },
  {
    id: "dmedirect", name: "DME-Direct", url: "https://www.dme-direct.com", role: "pricing",
    label: "DME-Direct retail",
    citation: "DME-Direct (dme-direct.com) — durable medical equipment retail pricing.",
    prices: ["DME", "MOBILITY_AID", "ASSISTIVE_TECH", "SUPPLIES"],
  },
  {
    id: "rinellapro", name: "RinellaPro Prosthetics & Orthotics", url: "https://www.rinellapro.com", role: "pricing",
    label: "RinellaPro (prosthetics/orthotics)",
    citation: "Rinella Prosthetics and Orthopedics (rinellapro.com) — prosthetic and orthotic device and fitting pricing.",
    prices: ["ORTHOTICS_PROSTHETICS"],
  },
  {
    id: "healix", name: "Healix Pathology", url: "https://healixpathology.com", role: "pricing",
    label: "Healix Pathology (laboratory)",
    citation: "Healix Pathology (healixpathology.com/laboratory-services) — laboratory service pricing.",
    prices: ["LABS"],
  },
  {
    id: "newchoice", name: "New Choice Health", url: "https://www.newchoicehealth.com", role: "pricing",
    label: "New Choice Health (procedure cost)",
    citation: "New Choice Health (newchoicehealth.com) — market pricing for procedures such as spinal cord stimulator implantation.",
    prices: ["ASSISTIVE_TECH"],
  },
  {
    id: "rsmedical", name: "RS Medical", url: "https://www.rsmedical.com", role: "pricing",
    label: "RS Medical (TENS/NMS units)",
    citation: "RS Medical (rsmedical.com) — comparison pricing for TENS and neuromuscular-stimulation units.",
  },
  {
    id: "tenspros", name: "TENSpros", url: "https://www.tenspros.com", role: "pricing",
    label: "TENSpros (accessory supplies)",
    citation: "TENSpros (tenspros.com) — electrotherapy accessory supply-bundle pricing.",
  },
  {
    id: "organicell", name: "Organicell", url: "https://www.organicell.com", role: "pricing",
    label: "Organicell (regenerative)",
    citation: "Organicell (organicell.com) — regenerative-medicine product pricing.",
  },
  {
    id: "cemag", name: "Chiropractic Economics", role: "pricing",
    label: "Chiropractic Economics (Southern region)",
    citation: "Chiropractic Economics Magazine — regional (Southern) chiropractic and manual-therapy fee data.",
  },
  {
    id: "healthcost", name: "CostHelper Health", url: "https://health.costhelper.com", role: "pricing",
    label: "CostHelper Health (non-surgical program)",
    citation: "CostHelper Health (health.costhelper.com) — consumer pricing for non-surgical treatment programs.",
  },
  {
    id: "cms", name: "CMS fee schedules", url: "https://www.cms.gov", role: "pricing",
    label: "CMS RVU / DMEPOS / CLFS",
    citation: "Centers for Medicare & Medicaid Services (cms.gov) — RVU, DMEPOS, and clinical-laboratory fee schedules (secondary pricing benchmark).",
    prices: CODED_SERVICES,
  },

  // ── Guideline / evidence sources ───────────────────────────────────────────
  {
    id: "odg", name: "Official Disability Guidelines (ODG)", url: "https://www.odgbymcg.com/treatment", role: "guideline",
    label: "ODG (ODGbyMCG) treatment guidelines",
    citation: "Official Disability Guidelines (ODGbyMCG.com/treatment) — evidence-based medical treatment guidelines used to determine whether a diagnostic study or treatment is medically necessary now or in the future.",
    applies: [],
  },
  {
    id: "orthobullets", name: "Orthobullets", url: "https://www.orthobullets.com", role: "guideline",
    label: "Orthobullets clinical guidance",
    citation: "Orthobullets (orthobullets.com) — peer-reviewed orthopedic and spine clinical-practice guidance.",
    applies: ["knee", "hip", "shoulder", "ankle", "wrist", "lumbar", "cervical", "thoracic", "spine"],
  },
  {
    id: "aapm", name: "American Academy of Pain Management (AAPM)", role: "guideline",
    label: "AAPM pain-management guidance",
    citation: "American Academy of Pain Management (AAPM) — chronic-pain management guidance.",
    applies: ["pain"],
  },
  {
    id: "icsi", name: "Institute for Clinical Systems Improvement (ICSI)", role: "guideline",
    label: "ICSI clinical guidelines",
    citation: "Institute for Clinical Systems Improvement (ICSI) — evidence-based clinical guidelines.",
    applies: [],
  },
  {
    id: "statpearls", name: "StatPearls (NCBI Bookshelf)", url: "https://www.statpearls.com", role: "reference",
    label: "StatPearls (NCBI Bookshelf)",
    citation: "StatPearls, NCBI Bookshelf (statpearls.com / ncbi.nlm.nih.gov) — peer-reviewed clinical reference.",
    applies: [],
  },
  {
    id: "healthline", name: "Healthline", url: "https://www.healthline.com", role: "reference",
    label: "Healthline (consumer reference)",
    citation: "Healthline (healthline.com) — consumer clinical reference (supporting, not primary).",
    applies: [],
  },
  {
    id: "milliman", name: "Milliman", role: "utilization",
    label: "Milliman utilization/cost study",
    citation: "Milliman — Utilization and Cost of Lumbar Spinal Stenosis in a Commercially Insured Population.",
    applies: ["lumbar", "spine"],
  },
  {
    id: "moss-opioid-weaning", name: "Moss C et al. (2019)", role: "literature",
    label: "Moss C et al., opioid weaning (2019)",
    citation: "Moss C, et al. Weaning From Long-term Opioid Therapy. Clin Obstet Gynecol. 2019 Mar;62(1):98-109.",
    applies: ["pain", "opioid", "medication"],
  },
];

const byId = new Map(SOURCES.map((s) => [s.id, s]));
export const source = (id: string): ReferenceSource | undefined => byId.get(id);

/** The pricing source that values a care category (primary basis). */
export function pricingSourceFor(category: CareCategory): ReferenceSource {
  return SOURCES.find((s) => s.role === "pricing" && s.prices?.includes(category)) ?? byId.get("fairhealth")!;
}

// Guideline/evidence selection: ODG always applies (treatment necessity); add the
// specialty-apt guideline/reference/utilization/literature sources by category +
// body region so a recommendation cites what a physician of that field would.
const CAT_APPLIES: Partial<Record<CareCategory, string[]>> = {
  PAIN_MANAGEMENT: ["pain", "opioid"], INJECTION: ["pain"], MEDICATION: ["medication", "opioid", "pain"],
  ORTHOPEDIC_SURGERY: ["spine", "knee", "hip", "shoulder"], REVISION_SURGERY: ["spine", "knee", "hip"],
  NEUROSURGERY: ["spine", "lumbar", "cervical"], PMR: [], NEUROLOGY: [],
};

/** Evidence/guideline sources appropriate to a recommendation (ODG first). */
export function guidelineSourcesFor(category: CareCategory, region?: string): ReferenceSource[] {
  const tags = new Set<string>([...(CAT_APPLIES[category] ?? []), ...(region && region !== "general" ? [region.replace(/_/g, " "), region] : [])]);
  const apt = (s: ReferenceSource) => (s.applies?.length ? s.applies.some((a) => [...tags].some((t) => t.includes(a) || a.includes(t))) : true);
  const out: ReferenceSource[] = [byId.get("odg")!];
  for (const s of SOURCES) {
    if (s.id === "odg") continue;
    if ((s.role === "guideline" || s.role === "utilization" || s.role === "literature") && apt(s)) out.push(s);
  }
  return out;
}

/** The deduped list of sources actually relied upon for a plan's categories —
 *  drives the References appendix (only what's used, never the whole catalog). */
export function referencesFor(categories: CareCategory[], opts: { includeGuidelines?: boolean } = {}): ReferenceSource[] {
  const used = new Map<string, ReferenceSource>();
  for (const c of categories) {
    const p = pricingSourceFor(c);
    used.set(p.id, p);
    if (opts.includeGuidelines) for (const g of guidelineSourcesFor(c)) used.set(g.id, g);
  }
  // Always disclose ODG + the primary CLCP pricing spine when any care exists.
  if (categories.length) { used.set("odg", byId.get("odg")!); used.set("fairhealth", byId.get("fairhealth")!); }
  const order: SourceRole[] = ["guideline", "utilization", "literature", "reference", "pricing"];
  return [...used.values()].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
}
