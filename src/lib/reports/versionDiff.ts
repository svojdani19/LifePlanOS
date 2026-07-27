// ─────────────────────────────────────────────────────────────────────────────
// Report version changes — when new material enters the pipeline after a
// report has been generated, the next version must SHOW what changed rather
// than leave the reader to hunt for it. Deterministic: compares the current
// case state (snapshot payload) against the snapshot captured with the prior
// export of the same report type, via the existing diffSnapshots engine.
// Rendered both as a document section ("Changes Since Prior Version") and in
// the Report Library UI. Never invents a change; empty diff says so honestly.
// ─────────────────────────────────────────────────────────────────────────────

import type { SnapshotDiff } from "@/lib/engine/snapshot";
import type { Block } from "./doc";

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

/** True when the diff contains anything a reader would call a change. */
export function isMaterialDiff(d: SnapshotDiff): boolean {
  return (
    d.recordsAdded.length > 0 || d.recordsRemoved.length > 0 ||
    d.chronologyAdded > 0 || d.chronologyRemoved > 0 ||
    d.diagnosesAdded.length > 0 || d.diagnosesRemoved.length > 0 ||
    d.relatednessChanged.length > 0 || d.itemsAdded.length > 0 ||
    d.itemsRemoved.length > 0 || d.fieldChanges.length > 0 ||
    d.reviewChanges.length > 0 || d.literatureChanges.length > 0 ||
    d.assumptionChanges.length > 0 ||
    Math.round(d.totalChange.pvFrom) !== Math.round(d.totalChange.pvTo) ||
    Math.round(d.totalChange.lifetimeFrom) !== Math.round(d.totalChange.lifetimeTo)
  );
}

/**
 * Render the diff as a report section. `priorLabel` names what is being
 * compared against (e.g. "v3 (final), exported January 5, 2026").
 */
export function changesSection(d: SnapshotDiff, priorLabel: string): Block[] {
  const blocks: Block[] = [
    { kind: "h1", text: "Changes Since Prior Version" },
    { kind: "p", text: `This section compares the present version against ${priorLabel}. It is generated deterministically from the structured case record so that revisions are transparent to every reader.`, italics: true },
  ];
  if (!isMaterialDiff(d)) {
    blocks.push({ kind: "p", text: "No material changes from the prior version: the underlying records, diagnoses, recommendations, physician decisions, costs, and assumptions are unchanged." });
    return blocks;
  }
  if (d.recordsAdded.length) blocks.push({ kind: "labeled", label: "New records reviewed", text: d.recordsAdded.join("; ") });
  if (d.recordsRemoved.length) blocks.push({ kind: "labeled", label: "Records no longer present", text: d.recordsRemoved.join("; ") });
  if (d.chronologyAdded > 0) blocks.push({ kind: "labeled", label: "Chronology", text: `${d.chronologyAdded} new event(s) added to the medical chronology${d.chronologyRemoved ? `; ${d.chronologyRemoved} removed` : ""}.` });
  if (d.diagnosesAdded.length) blocks.push({ kind: "labeled", label: "Diagnoses added", text: d.diagnosesAdded.join("; ") });
  if (d.diagnosesRemoved.length) blocks.push({ kind: "labeled", label: "Diagnoses removed", text: d.diagnosesRemoved.join("; ") });
  for (const r of d.relatednessChanged) blocks.push({ kind: "labeled", label: "Relatedness changed", text: `${r.name}: ${r.from} → ${r.to}` });
  if (d.itemsAdded.length) blocks.push({ kind: "labeled", label: "Recommendations added", text: d.itemsAdded.join("; ") });
  if (d.itemsRemoved.length) blocks.push({ kind: "labeled", label: "Recommendations removed", text: d.itemsRemoved.join("; ") });
  if (d.fieldChanges.length) {
    blocks.push({
      kind: "table",
      caption: "Changed recommendation parameters",
      header: ["Recommendation", "Parameter", "Prior", "Current"],
      rows: d.fieldChanges.map((c) => [c.service, String(c.field), String(c.from ?? "—"), String(c.to ?? "—")]),
    });
  }
  if (d.reviewChanges.length) {
    blocks.push({
      kind: "table",
      caption: "Physician review changes",
      header: ["Recommendation", "Prior status", "Current status"],
      rows: d.reviewChanges.map((c) => [c.service, c.from, c.to]),
    });
  }
  for (const l of d.literatureChanges) {
    const parts = [l.added.length ? `added: ${l.added.join("; ")}` : "", l.removed.length ? `removed: ${l.removed.join("; ")}` : ""].filter(Boolean).join(" · ");
    blocks.push({ kind: "labeled", label: `Literature (${l.service})`, text: parts });
  }
  for (const a of d.assumptionChanges) blocks.push({ kind: "labeled", label: `Assumption: ${a.field}`, text: `${a.from} → ${a.to}` });
  const t = d.totalChange;
  if (Math.round(t.pvFrom) !== Math.round(t.pvTo) || Math.round(t.lifetimeFrom) !== Math.round(t.lifetimeTo)) {
    const pvDelta = t.pvTo - t.pvFrom;
    blocks.push({
      kind: "labeled",
      label: "Totals movement",
      text: `Present value ${money(t.pvFrom)} → ${money(t.pvTo)} (${pvDelta >= 0 ? "+" : "−"}${money(Math.abs(pvDelta))}); lifetime ${money(t.lifetimeFrom)} → ${money(t.lifetimeTo)}.`,
    });
  }
  return blocks;
}
