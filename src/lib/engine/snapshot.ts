// ─────────────────────────────────────────────────────────────────────────────
// Case snapshots & version comparison (P3). A snapshot is a compact JSON digest
// of the case's clinical/economic state, captured on each report export so any
// two report versions can be compared: records added/removed, chronology,
// diagnoses, recommendation additions/removals, frequency/duration/code/
// pricing/literature changes, physician-review changes, totals, assumptions.
// buildSnapshotPayload/diffSnapshots are pure and unit-tested; persistence
// lives in the export route and the snapshots API.
// ─────────────────────────────────────────────────────────────────────────────

export interface SnapshotPayload {
  documents: { id: string; filename: string; type: string }[];
  chronology: { date: string; provider: string | null; summary: string }[];
  conditions: { name: string; relatedness: string }[];
  items: {
    service: string;
    category: string;
    cptCode: string | null;
    probability: string;
    frequencyPerYear: number;
    durationYears: number | null;
    isLifetime: boolean;
    unitCost: number;
    lifetimeCost: number;
    presentValue: number;
    pricingSource: string | null;
    physicianStatus: string;
    literature: string[]; // citation titles
  }[];
  assumptions: { lifeExpectancyYears: number; discountRate: number; medicalInflation: number; geographicFactor: number };
  totals: { lifetime: number; presentValue: number };
}

interface CaseLike {
  documents: { id: string; filename: string; type: string }[];
  chronologyEvents: { eventDate: Date | string; provider: string | null; summary: string }[];
  conditions: { name: string; relatedness: string }[];
  futureCareItems: {
    service: string; category: string; cptCode: string | null; probability: string;
    frequencyPerYear: number; durationYears: number | null; isLifetime: boolean;
    unitCost: number; lifetimeCost: number; presentValue: number;
    pricingSource: string | null; physicianStatus: string; citation?: unknown;
    supersededAt?: Date | null;
  }[];
}

export function buildSnapshotPayload(c: CaseLike, assumptionsIn: SnapshotPayload["assumptions"], totals: SnapshotPayload["totals"]): SnapshotPayload {
  const current = c.futureCareItems.filter((i) => !i.supersededAt);
  // Life expectancy may be derived from the clock (DOB → remaining years);
  // round so two snapshots minutes apart don't diff on floating-point noise.
  const assumptions = { ...assumptionsIn, lifeExpectancyYears: Math.round(assumptionsIn.lifeExpectancyYears * 100) / 100 };
  return {
    documents: c.documents.map((d) => ({ id: d.id, filename: d.filename, type: d.type })),
    chronology: c.chronologyEvents.map((e) => ({ date: new Date(e.eventDate).toISOString().slice(0, 10), provider: e.provider, summary: e.summary.slice(0, 140) })),
    conditions: c.conditions.map((x) => ({ name: x.name, relatedness: x.relatedness })),
    items: current.map((i) => ({
      service: i.service,
      category: i.category,
      cptCode: i.cptCode,
      probability: i.probability,
      frequencyPerYear: i.frequencyPerYear,
      durationYears: i.durationYears,
      isLifetime: i.isLifetime,
      unitCost: i.unitCost,
      lifetimeCost: i.lifetimeCost,
      presentValue: i.presentValue,
      pricingSource: i.pricingSource,
      physicianStatus: i.physicianStatus,
      literature: ((Array.isArray(i.citation) ? i.citation : i.citation ? [i.citation] : []) as { title?: string }[]).map((cc) => cc.title ?? "").filter(Boolean),
    })),
    assumptions,
    totals,
  };
}

// ── Diff ─────────────────────────────────────────────────────────────────────
export interface FieldChange { service: string; field: string; from: unknown; to: unknown }
export interface SnapshotDiff {
  recordsAdded: string[];
  recordsRemoved: string[];
  chronologyAdded: number;
  chronologyRemoved: number;
  diagnosesAdded: string[];
  diagnosesRemoved: string[];
  relatednessChanged: { name: string; from: string; to: string }[];
  itemsAdded: string[];
  itemsRemoved: string[];
  fieldChanges: FieldChange[]; // frequency/duration/code/pricing/cost per item
  reviewChanges: { service: string; from: string; to: string }[];
  literatureChanges: { service: string; added: string[]; removed: string[] }[];
  assumptionChanges: { field: string; from: number; to: number }[];
  totalChange: { lifetimeFrom: number; lifetimeTo: number; pvFrom: number; pvTo: number };
}

const ITEM_FIELDS: (keyof SnapshotPayload["items"][number])[] = ["cptCode", "probability", "frequencyPerYear", "durationYears", "isLifetime", "unitCost", "pricingSource"];

export function diffSnapshots(a: SnapshotPayload, b: SnapshotPayload): SnapshotDiff {
  const byName = <T,>(arr: T[], key: (t: T) => string) => new Map(arr.map((t) => [key(t).toLowerCase(), t]));
  const docsA = byName(a.documents, (d) => d.filename);
  const docsB = byName(b.documents, (d) => d.filename);
  const condA = byName(a.conditions, (c) => c.name);
  const condB = byName(b.conditions, (c) => c.name);
  const itemA = byName(a.items, (i) => i.service);
  const itemB = byName(b.items, (i) => i.service);
  const chronoKey = (e: { date: string; provider: string | null }) => `${e.date}|${e.provider ?? ""}`;
  const chronoA = new Set(a.chronology.map(chronoKey));
  const chronoB = new Set(b.chronology.map(chronoKey));

  const fieldChanges: FieldChange[] = [];
  const reviewChanges: SnapshotDiff["reviewChanges"] = [];
  const literatureChanges: SnapshotDiff["literatureChanges"] = [];
  for (const [k, ia] of itemA) {
    const ib = itemB.get(k);
    if (!ib) continue;
    for (const f of ITEM_FIELDS) {
      if ((ia[f] ?? null) !== (ib[f] ?? null)) fieldChanges.push({ service: ia.service, field: f as string, from: ia[f], to: ib[f] });
    }
    if (ia.physicianStatus !== ib.physicianStatus) reviewChanges.push({ service: ia.service, from: ia.physicianStatus, to: ib.physicianStatus });
    const litA = new Set(ia.literature);
    const litB = new Set(ib.literature);
    const added = [...litB].filter((t) => !litA.has(t));
    const removed = [...litA].filter((t) => !litB.has(t));
    if (added.length || removed.length) literatureChanges.push({ service: ia.service, added, removed });
  }

  const assumptionChanges: SnapshotDiff["assumptionChanges"] = [];
  for (const f of ["lifeExpectancyYears", "discountRate", "medicalInflation", "geographicFactor"] as const) {
    if (a.assumptions[f] !== b.assumptions[f]) assumptionChanges.push({ field: f, from: a.assumptions[f], to: b.assumptions[f] });
  }

  return {
    recordsAdded: [...docsB.keys()].filter((k) => !docsA.has(k)).map((k) => docsB.get(k)!.filename),
    recordsRemoved: [...docsA.keys()].filter((k) => !docsB.has(k)).map((k) => docsA.get(k)!.filename),
    chronologyAdded: [...chronoB].filter((k) => !chronoA.has(k)).length,
    chronologyRemoved: [...chronoA].filter((k) => !chronoB.has(k)).length,
    diagnosesAdded: [...condB.keys()].filter((k) => !condA.has(k)).map((k) => condB.get(k)!.name),
    diagnosesRemoved: [...condA.keys()].filter((k) => !condB.has(k)).map((k) => condA.get(k)!.name),
    relatednessChanged: [...condA.entries()].filter(([k, ca]) => condB.has(k) && condB.get(k)!.relatedness !== ca.relatedness).map(([k, ca]) => ({ name: ca.name, from: ca.relatedness, to: condB.get(k)!.relatedness })),
    itemsAdded: [...itemB.keys()].filter((k) => !itemA.has(k)).map((k) => itemB.get(k)!.service),
    itemsRemoved: [...itemA.keys()].filter((k) => !itemB.has(k)).map((k) => itemA.get(k)!.service),
    fieldChanges,
    reviewChanges,
    literatureChanges,
    assumptionChanges,
    totalChange: { lifetimeFrom: a.totals.lifetime, lifetimeTo: b.totals.lifetime, pvFrom: a.totals.presentValue, pvTo: b.totals.presentValue },
  };
}
