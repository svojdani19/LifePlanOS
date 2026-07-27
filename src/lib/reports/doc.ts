import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  Footer,
  Header,
  PageNumber,
  AlignmentType,
  BorderStyle,
} from "docx";
import { reportKit } from "@/lib/export/report";

// ─────────────────────────────────────────────────────────────────────────────
// Report Library — neutral document model (docs/22 §2).
//
// A report is composed as an ordered list of typed blocks; three renderers
// (DOCX via the existing report design kit, semantic HTML for previews, and
// RFC-4180 CSV for the first table) turn the same ReportDoc into each output
// format. Composition never touches a renderer and renderers never invent
// content — every word in the output exists in the block list.
// ─────────────────────────────────────────────────────────────────────────────

export type Block =
  | {
      kind: "h1" | "h2" | "p" | "labeled" | "bullet" | "source" | "pagebreak";
      text?: string;
      label?: string;
      italics?: boolean;
    }
  | { kind: "table"; header: string[]; rows: string[][]; caption?: string };

export interface ReportDoc {
  reportId: string;
  title: string;
  subtitle?: string;
  caseLabel: string;
  blocks: Block[];
  draft: boolean;
  disclosures: string[];
}

// Same draft wording as the legacy Life Care Plan export (report.ts).
export const DRAFT_BANNER = "DRAFT — NOT FOR SERVICE OR PRODUCTION";

// ── DOCX ─────────────────────────────────────────────────────────────────────

const kit = reportKit;

function docxTable(block: Extract<Block, { kind: "table" }>): Table {
  const widths = block.header.length ? Math.floor(100 / block.header.length) : undefined;
  const rows: TableRow[] = [
    kit.rowOf(block.header.map((h) => kit.td(h, { header: true, width: widths }))),
  ];
  block.rows.forEach((r, i) => {
    const fill = i % 2 ? kit.ALT : "FFFFFF";
    rows.push(kit.rowOf(block.header.map((_, c) => kit.td(r[c] ?? "", { fill, width: widths }))));
  });
  return kit.table(rows);
}

function docxBlock(b: Block): (Paragraph | Table)[] {
  switch (b.kind) {
    case "h1":
      return [kit.h1(b.text ?? "")];
    case "h2":
      return [kit.h2(b.text ?? "")];
    case "p":
      return [kit.p(b.text ?? "", { italics: b.italics })];
    case "labeled":
      return [kit.labeled(b.label ?? "", b.text ?? "")];
    case "bullet":
      return [kit.bullet(b.text ?? "")];
    case "source":
      return [kit.sourceLine(b.text ?? "")];
    case "pagebreak":
      return [new Paragraph({ pageBreakBefore: true, children: [] })];
    case "table": {
      const out: (Paragraph | Table)[] = [];
      if (b.caption) out.push(kit.caption(b.caption));
      out.push(docxTable(b));
      return out;
    }
  }
}

/**
 * Render a ReportDoc to a .docx buffer using the existing report design kit:
 * a firm-neutral title page (title, subtitle, case label, generated date, and
 * the standard draft banner when applicable), the disclosures as italic
 * paragraphs, then the blocks, with a running "LifePlanOS · <title> · page"
 * footer mirroring the legacy report's footer style.
 */
export async function renderDocx(doc: ReportDoc): Promise<Buffer> {
  const body: (Paragraph | Table)[] = [];

  // ── Title page (firm-neutral) ──────────────────────────────────────────────
  if (doc.draft) {
    body.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 200 },
        children: [new TextRun({ text: DRAFT_BANNER, bold: true, size: 26, color: "B91C1C" })],
      }),
    );
  }
  body.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: doc.draft ? 240 : 720, after: 40 },
      children: [new TextRun({ text: doc.title, bold: true, size: 40, color: kit.INK })],
    }),
  );
  if (doc.subtitle) {
    body.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 60 },
        children: [new TextRun({ text: doc.subtitle, size: 30, color: kit.INK })],
      }),
    );
  }
  body.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 240, after: 40 },
      children: [new TextRun({ text: doc.caseLabel, bold: true, size: 26, color: kit.NAVY })],
    }),
  );
  body.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 360 },
      children: [new TextRun({ text: `Generated ${kit.fmtDate(new Date())}`, size: 20, color: kit.GREY })],
    }),
  );

  // ── Disclosures ────────────────────────────────────────────────────────────
  for (const d of doc.disclosures) body.push(kit.p(d, { italics: true }));

  // ── Blocks ─────────────────────────────────────────────────────────────────
  for (const b of doc.blocks) body.push(...docxBlock(b));

  // ── Running footer, mirroring report.ts footer style ───────────────────────
  const runningFooter = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: kit.RULE, space: 4 } },
        children: [
          ...(doc.draft ? [new TextRun({ text: "DRAFT   ·   ", bold: true, size: 15, color: "B91C1C" })] : []),
          new TextRun({ text: `LifePlanOS   ·   ${doc.title}   ·   Page `, size: 15, color: kit.GREY }),
          new TextRun({ children: [PageNumber.CURRENT], size: 15, color: kit.GREY }),
          new TextRun({ text: " of ", size: 15, color: kit.GREY }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 15, color: kit.GREY }),
        ],
      }),
    ],
  });
  const emptyHeader = new Header({ children: [new Paragraph({ children: [] })] });

  const document = new Document({
    styles: { default: { document: { run: { font: kit.FONT, size: kit.BODY, color: kit.INK } } } },
    sections: [
      {
        properties: {
          titlePage: true,
          page: { margin: { top: 1440, bottom: 1440, left: 1620, right: 1620, header: 720, footer: 620 } },
        },
        headers: { default: emptyHeader, first: emptyHeader },
        footers: { default: runningFooter, first: runningFooter },
        children: body,
      },
    ],
  });
  return Packer.toBuffer(document);
}

// ── HTML ─────────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlTable(b: Extract<Block, { kind: "table" }>): string {
  const out: string[] = [];
  if (b.caption) out.push(`<p class="report-caption">${escapeHtml(b.caption)}</p>`);
  out.push('<table class="report-table">');
  out.push("<thead><tr>" + b.header.map((h) => `<th>${escapeHtml(h)}</th>`).join("") + "</tr></thead>");
  out.push("<tbody>");
  for (const r of b.rows) out.push("<tr>" + b.header.map((_, c) => `<td>${escapeHtml(r[c] ?? "")}</td>`).join("") + "</tr>");
  out.push("</tbody></table>");
  return out.join("");
}

function htmlBlock(b: Block): string {
  switch (b.kind) {
    case "h1":
      return `<h1 class="report-h1">${escapeHtml(b.text ?? "")}</h1>`;
    case "h2":
      return `<h2 class="report-h2">${escapeHtml(b.text ?? "")}</h2>`;
    case "p":
      return b.italics
        ? `<p class="report-p"><em>${escapeHtml(b.text ?? "")}</em></p>`
        : `<p class="report-p">${escapeHtml(b.text ?? "")}</p>`;
    case "labeled":
      return `<p class="report-labeled"><strong>${escapeHtml(b.label ?? "")}.</strong> ${escapeHtml(b.text ?? "")}</p>`;
    case "bullet":
      return `<ul class="report-bullets"><li>${escapeHtml(b.text ?? "")}</li></ul>`;
    case "source":
      return `<p class="report-source"><em>${escapeHtml(b.text ?? "")}</em></p>`;
    case "pagebreak":
      return '<hr class="report-pagebreak" />';
    case "table":
      return htmlTable(b);
  }
}

/**
 * Render a ReportDoc as semantic, self-contained HTML (preview). All text is
 * escaped; no inline styles and no external assets — styling is left to the
 * host page via the report-* classes.
 */
export function renderHtml(doc: ReportDoc): string {
  const parts: string[] = ['<div class="report">'];
  if (doc.draft) parts.push(`<div class="report-draft-banner">${escapeHtml(DRAFT_BANNER)}</div>`);
  parts.push(`<h1 class="report-title">${escapeHtml(doc.title)}</h1>`);
  if (doc.subtitle) parts.push(`<p class="report-subtitle">${escapeHtml(doc.subtitle)}</p>`);
  parts.push(`<p class="report-case-label">${escapeHtml(doc.caseLabel)}</p>`);
  for (const d of doc.disclosures) parts.push(`<p class="report-disclosure"><em>${escapeHtml(d)}</em></p>`);
  // Merge consecutive single-item bullet lists into one list for semantics.
  const rendered = doc.blocks.map(htmlBlock).join("\n").replace(/<\/ul>\n<ul class="report-bullets">/g, "\n");
  parts.push(rendered);
  parts.push("</div>");
  return parts.join("\n");
}

// ── CSV ──────────────────────────────────────────────────────────────────────

const csvCell = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Render the FIRST table block of the document as RFC-4180 CSV (same quoting
 * rules as the legacy buildCostCsv). Throws when the document has no table —
 * CSV is only offered for table-bearing reports.
 */
export function renderCsv(doc: ReportDoc): string {
  const t = doc.blocks.find((b): b is Extract<Block, { kind: "table" }> => b.kind === "table");
  if (!t) throw new Error(`Report "${doc.reportId}" contains no table block; CSV export is not available.`);
  const lines = [t.header.map(csvCell).join(",")];
  for (const r of t.rows) lines.push(t.header.map((_, c) => csvCell(r[c] ?? "")).join(","));
  return lines.join("\n");
}
