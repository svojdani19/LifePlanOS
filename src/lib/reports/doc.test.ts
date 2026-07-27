import { describe, it, expect } from "vitest";
import { renderHtml, renderCsv, renderDocx, DRAFT_BANNER, escapeHtml, type ReportDoc } from "./doc";

const baseDoc = (over: Partial<ReportDoc> = {}): ReportDoc => ({
  reportId: "TEST_REPORT",
  title: "Test Report",
  subtitle: "A test document",
  caseLabel: "James Holloway · File LCP-2026-0007",
  draft: false,
  disclosures: ["This report is generated from the structured case record."],
  blocks: [
    { kind: "h1", text: "Section One" },
    { kind: "h2", text: "Subsection" },
    { kind: "p", text: "A plain paragraph." },
    { kind: "p", text: "An italic note.", italics: true },
    { kind: "labeled", label: "Finding", text: "The documented finding." },
    { kind: "bullet", text: "First bullet" },
    { kind: "bullet", text: "Second bullet" },
    { kind: "source", text: "Source: record on file, p. 3." },
    { kind: "pagebreak" },
    {
      kind: "table",
      caption: "A caption",
      header: ["Service", "Cost"],
      rows: [
        ["Follow-up visit", "$165"],
        ["MRI", "$1,200"],
      ],
    },
  ],
  ...over,
});

describe("renderHtml", () => {
  it("escapes all user text so markup cannot be injected", () => {
    const doc = baseDoc({
      blocks: [
        { kind: "p", text: '<script>alert("xss")</script> & <b>bold</b>' },
        { kind: "table", header: ["<th-inject>"], rows: [['"quoted" & <td>']] },
      ],
      caseLabel: "<img src=x onerror=alert(1)>",
    });
    const html = renderHtml(doc);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<th-inject>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("shows the draft banner exactly when the doc is a draft", () => {
    const draft = renderHtml(baseDoc({ draft: true }));
    expect(draft).toContain("report-draft-banner");
    expect(draft).toContain(DRAFT_BANNER);
    const final = renderHtml(baseDoc({ draft: false }));
    expect(final).not.toContain("report-draft-banner");
    expect(final).not.toContain(DRAFT_BANNER);
  });

  it("renders disclosures, title, subtitle, and all block kinds semantically", () => {
    const html = renderHtml(baseDoc());
    expect(html).toContain('<p class="report-disclosure"><em>This report is generated from the structured case record.</em></p>');
    expect(html).toContain('<h1 class="report-title">Test Report</h1>');
    expect(html).toContain("A test document");
    expect(html).toContain('<h1 class="report-h1">Section One</h1>');
    expect(html).toContain('<h2 class="report-h2">Subsection</h2>');
    expect(html).toContain("<em>An italic note.</em>");
    expect(html).toContain("<strong>Finding.</strong>");
    expect(html).toContain("<li>First bullet</li>");
    expect(html).toContain("<th>Service</th>");
    expect(html).toContain("<td>$1,200</td>");
    // No inline styles and no external assets.
    expect(html).not.toContain("style=");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });
});

describe("renderCsv", () => {
  it("emits the first table as RFC-4180 CSV with quoting for commas, quotes, and newlines", () => {
    const doc = baseDoc({
      blocks: [
        { kind: "p", text: "Preamble is skipped" },
        {
          kind: "table",
          header: ["Service", "Note"],
          rows: [
            ["Visit, follow-up", 'He said "stable"'],
            ["Multi\nline", "plain"],
          ],
        },
        { kind: "table", header: ["Second"], rows: [["ignored"]] },
      ],
    });
    const csv = renderCsv(doc);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Service,Note");
    expect(csv).toContain('"Visit, follow-up"');
    expect(csv).toContain('"He said ""stable"""');
    expect(csv).toContain('"Multi\nline"');
    // Only the FIRST table is exported.
    expect(csv).not.toContain("Second");
    expect(csv).not.toContain("ignored");
  });

  it("pads missing cells to the header width", () => {
    const doc = baseDoc({ blocks: [{ kind: "table", header: ["A", "B", "C"], rows: [["only-a"]] }] });
    expect(renderCsv(doc).split("\n")[1]).toBe("only-a,,");
  });

  it("throws when the document has no table block", () => {
    const doc = baseDoc({ blocks: [{ kind: "p", text: "no tables here" }] });
    expect(() => renderCsv(doc)).toThrow(/no table block/);
  });
});

describe("renderDocx", () => {
  it("produces a non-trivial .docx buffer from every block kind (smoke)", async () => {
    const buf = await renderDocx(baseDoc());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    // .docx files are zip archives: PK magic bytes.
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it("renders a draft document without throwing (draft banner path)", async () => {
    const buf = await renderDocx(baseDoc({ draft: true, subtitle: undefined }));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
  });
});

describe("escapeHtml", () => {
  it("escapes the five significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
