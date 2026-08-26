import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACES } from "@/lib/workspaces";

// ─────────────────────────────────────────────────────────────────────────────
// Accessibility properties that are invisible until somebody uses a screen
// reader, and that a layout change can silently undo.
//
// Asserted against the source rather than a rendered tree because the target
// component is 5,700 lines with a large data contract; the properties here are
// structural (does this control carry a name, is this icon hidden, is a
// non-interactive thing rendered as a button) and the source is where they are
// decided.
//
// Comments are stripped first: several of them quote the old markup verbatim,
// and matching those would make every assertion here vacuous.
// ─────────────────────────────────────────────────────────────────────────────

const SRC = join(process.cwd(), "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const stripComments = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

const workspace = () => stripComments(read("components/case/CaseWorkspace.tsx"));
const sidebar = () => stripComments(read("components/Sidebar.tsx"));
/**
 * The Records document row, its actions menu and its detail pane moved out of
 * CaseWorkspace into their own module when the Records tab was restructured.
 * The PROPERTIES asserted below did not move — they are checked wherever the
 * markup now lives, so a relocation cannot quietly drop an accessible name.
 */
const recordsUi = () => stripComments(read("components/case/records/RecordsWorkspace.tsx"));
const recordsSurface = () => workspace() + "\n" + recordsUi();

describe("filter chips announce their state", () => {
  it("FilterChip is a toggle, not a plain button", () => {
    const chip = workspace().match(/function FilterChip\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(chip).toBeTruthy();
    expect(chip).toContain("aria-pressed={active}");
  });

  it("its accessible name carries the label AND the count", () => {
    const chip = workspace().match(/function FilterChip\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(chip).toMatch(/aria-label=\{`\$\{label\}, \$\{count\} item/);
    // The visible count is then decorative — announcing it twice is worse than
    // announcing it once.
    expect(chip).toMatch(/<span aria-hidden="true"[^>]*>\{count\}<\/span>/);
  });

  it("its icon is decorative", () => {
    const chip = workspace().match(/function FilterChip\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(chip).toContain('<Icon aria-hidden="true"');
  });
});

describe("a control nobody can operate is not a button", () => {
  it("renders a read-only document type as text, not an inert button", () => {
    const src = recordsSurface();
    // The old shape: a <button> whose onClick was `() => canEdit && …`, so a
    // reader without edit rights got a focusable control that did nothing.
    expect(src).not.toMatch(/onClick=\{\(\) => canEdit && setEditingId/);
    // The read-only branch is a span carrying the type as text.
    expect(src).toMatch(/<span className="sr-only">Record type: /);
  });

  it("gives the reclassify control a name that says what it does, and to which record", () => {
    // The control moved into the actions menu; the name must still identify
    // both the action and the file it acts on.
    expect(recordsUi()).toMatch(/aria-label=\{`Change the record type of \$\{filename\}`\}/);
  });
});

describe("icon-only actions carry names", () => {
  const ICON_ONLY = [
    "Remove additional diagnosis",
    "Remove additional specialty",
    "Edit the summary of the",
    "Save the edited summary",
    "Cancel editing this summary",
    "Remove this source",
    "Remove this note",
    "Remove this finding",
    "Dismiss the suggested diagnosis",
  ];

  it.each(ICON_ONLY)("%s has an accessible name", (name) => {
    expect(workspace()).toContain(name);
  });

  it("opens a document with the filename in the name, not just 'Open document'", () => {
    const src = recordsSurface();
    expect(src).toMatch(/aria-label=\{`Open \$\{(?:d\.)?filename\} in a new tab`\}/);
    expect(src).not.toContain('title="Open document"');
    // The menu that contains it is named for the record too, so the item is
    // never announced without context.
    expect(recordsUi()).toMatch(/aria-label=\{`Actions for \$\{filename\}`\}/);
  });

  it("marks the icons inside those actions decorative", () => {
    const src = recordsSurface();
    // Every lucide icon that sits inside a labelled control should be hidden,
    // or the reader announces the glyph name after the label.
    for (const icon of ["<X aria-hidden", "<Pencil aria-hidden", "<Check aria-hidden", "<ExternalLink aria-hidden"]) {
      expect(src, icon).toContain(icon);
    }
  });
});

describe("the workspace rail is navigable", () => {
  it("does not render the same icon for every workspace", () => {
    const src = sidebar();
    expect(src).toContain("WORKSPACE_ICON");
    expect(src).not.toMatch(/<BriefcaseBusiness className="h-\[18px\]/);
  });

  it("maps every workspace in the registry to its own icon", () => {
    const src = sidebar();
    const table = src.match(/const WORKSPACE_ICON[\s\S]*?\n\};/)?.[0] ?? "";
    expect(table).toBeTruthy();
    const hrefs = Object.values(WORKSPACES).map((w) => w.href);
    for (const href of hrefs) {
      expect(table, href).toContain(`"${href}"`);
    }
    // …and the icons are distinct, or the mapping has not achieved anything.
    const icons = [...table.matchAll(/:\s*([A-Z]\w+),/g)].map((m) => m[1]);
    expect(icons.length).toBe(hrefs.length);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("falls back rather than rendering nothing for an unknown workspace", () => {
    expect(sidebar()).toMatch(/WORKSPACE_ICON\[href\] \?\? BriefcaseBusiness/);
  });

  it("keeps every nav label available to a screen reader at narrow widths", () => {
    const src = sidebar();
    // `hidden lg:inline` removes the label from the accessibility tree below
    // lg, leaving an icon with no name. `sr-only` keeps the name and the
    // layout both.
    expect(src).not.toMatch(/className="hidden truncate lg:inline"/);
    expect(src).not.toMatch(/className="hidden lg:inline">\{item\.label\}/);
    expect(src.match(/max-lg:sr-only/g) ?? []).toHaveLength(3);
  });

  it("keeps logout and notifications reachable at narrow widths", () => {
    const src = sidebar();
    // Both were `hidden lg:block`: below lg there was no way to log out at all.
    expect(src).not.toMatch(/hidden rounded-md p-1\.5[^"]*lg:block/);
    expect(src).not.toMatch(/<span className="hidden lg:block">\s*<NotificationBell/);
    expect(src).toMatch(/aria-label="Log out"/);
  });
});

describe("focus is visible on the controls that were touched", () => {
  it("every newly-labelled control carries the shared focus style", () => {
    const src = workspace();
    // `focusable` is the project's visible focus-ring utility. A control that
    // is keyboard-reachable but shows nothing on focus is unusable without a
    // mouse.
    // Split on the tag rather than regex-matching the whole opening tag: JSX
    // attribute values contain `>` (arrow functions), so `[^>]*` truncates the
    // tag before its className and the assertion passes on nothing.
    const buttons = recordsSurface().split("<button").slice(1).map((chunk) => chunk.split("</button>")[0]);
    const labelled = buttons.filter((b) => b.includes("aria-label="));
    expect(labelled.length).toBeGreaterThan(5);
    for (const button of labelled) {
      expect(button, button.slice(0, 120)).toMatch(/focusable|btn-/);
    }
  });

  it("the status bar's dismiss control is named and focusable", () => {
    const bar = stripComments(read("components/case/ActionStatusBar.tsx"));
    expect(bar).toContain('aria-label="Dismiss message"');
    expect(bar).toContain("focusable");
  });
});

describe("the action status region is announced", () => {
  it("uses role=alert for errors and a polite status for success", () => {
    const bar = stripComments(read("components/case/ActionStatusBar.tsx"));
    expect(bar).toMatch(/role=\{isError \? "alert" : "status"\}/);
    expect(bar).toMatch(/aria-live=\{isError \? "assertive" : "polite"\}/);
  });

  it("no window.alert remains in the workspace", () => {
    // A modal the screen reader announces out of context, the keyboard user
    // must dismiss before doing anything else, and embedded browsers suppress.
    expect(workspace()).not.toMatch(/\balert\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The caution path the batch panel points at must actually exist, and must
// show the caution rather than a count of cautions.
//
// The panel now tells a reviewer that cautioned records "wait under 'Ready to
// confirm — read the note on each before signing' in the record list, where
// each one shows its own requirement, its source page and its own review
// action." That is a claim about another component, and a claim about a real
// surface is the only kind worth making — describing a path that does not
// exist would be worse than the aggregate it replaced.
// ─────────────────────────────────────────────────────────────────────────────
describe("the document-grain caution surface", () => {
  const src = () => workspace();

  it("groups cautioned records under the heading the batch panel names", () => {
    const heading = "Ready to confirm — read the note on each before signing";
    // Both halves: the group exists, and the panel points at that exact name.
    expect(src()).toContain(`foldedGroup("caution", "${heading}"`);
    expect(src()).toContain(heading);
  });

  it("shows each cautioned record's OWN requirement, not a code or a count", () => {
    // "What this needs: {e.guidance.requirement}" — the actual caution text.
    expect(src()).toMatch(/What this needs:\s*<\/span>\s*\n?\s*\{e\.guidance\.requirement\}/);
  });

  it("shows the affected record's own source citation with its page", () => {
    expect(src()).toMatch(/\/api\/cases\/\$\{caseId\}\/documents\/\$\{e\.sourceDocumentId\}\/view/);
    expect(src()).toMatch(/Open the source at p\. \{e\.pageStart\}/);
  });

  it("does not describe the caution path as an exception queue", () => {
    // The amber caution block in the batch panel, from its opening count to the
    // heading it points at.
    // Match to the closing </p>: a non-greedy `)}` stops early, because the
    // caution-kinds fragment contains one.
    const panel = src().match(/\{cautions > 0 && \([\s\S]*?<\/p>/)?.[0] ?? "";
    expect(panel).toBeTruthy();
    // The wording must say explicitly that a caution is NOT an exception — the
    // count it used to be folded into — and must name the real surface.
    expect(panel).toMatch(/not \{cautions === 1 \? "an exception" : "exceptions"\}/);
    expect(panel).toContain("not appear in the exception count");
    expect(panel).toContain("Ready to confirm");
  });

  it("the batch panel's zero-eligible state counts cautions separately", () => {
    // It used to describe cautions as "exceptions needing an individual
    // decision", which is the same double-count in prose.
    expect(src()).toMatch(/carr\$\{cautions === 1 \? "ies" : "y"\} a caution to read before signing/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The Records restructure: properties that must survive the move.
//
// The Records tab became three modes with a detail pane. These pin the
// guarantees that are easy to lose in a presentation change and expensive to
// discover afterwards — a destructive action made easier to reach, a large
// document rendered in full, a filter that cannot be read back or reset.
// ─────────────────────────────────────────────────────────────────────────────
describe("the Records restructure keeps its guarantees", () => {
  const ui = () => stripComments(read("components/case/records/RecordsWorkspace.tsx"));
  const panel = () => workspace();

  it("Remove stays two-step and visually separated inside the menu", () => {
    const src = ui();
    // The menu item opens a confirmation; it does not delete on click.
    expect(src).toMatch(/onClick=\{\(\) => setConfirming\(true\)\}/);
    expect(src).toContain("Confirm remove");
    // …and the confirming branch is the only path that calls onRemove.
    const removeCalls = src.match(/onRemove\(\)/g) ?? [];
    expect(removeCalls).toHaveLength(1);
    // Separated by a rule from the ordinary items. The confirmation branch sits
    // between the rule and the trigger, so the window has to clear it.
    expect(src).toMatch(/my-1 border-t border-ink-100[\s\S]{0,1200}?Remove record/);
  });

  it("the actions menu closes on Escape and on an outside click", () => {
    const src = ui();
    expect(src).toMatch(/e\.key === "Escape"/);
    expect(src).toContain('document.addEventListener("mousedown"');
    // …and removes both listeners again.
    expect(src).toContain('document.removeEventListener("mousedown"');
    expect(src).toContain('document.removeEventListener("keydown"');
  });

  it("the menu is announced as a menu", () => {
    const src = ui();
    expect(src).toContain('aria-haspopup="menu"');
    expect(src).toContain('role="menu"');
    expect(src).toContain('role="menuitem"');
  });

  it("no list renders unbounded — every long list is paginated", () => {
    const src = ui();
    // The 625-page production assembles into hundreds of notes; a window over
    // them is what keeps the page usable.
    expect(src).toMatch(/export function Paginated</);
    expect(src).toMatch(/items\.slice\(clamped \* pageSize, clamped \* pageSize \+ pageSize\)/);
    // The review pane pages its notes before handing them to ExtractionBlock.
    expect(panel()).toMatch(/notes: noteSlice/);
  });

  it("excerpts are capped and labelled honestly", () => {
    const src = ui();
    expect(src).toMatch(/excerpts\.slice\(0, EXCERPTS_SHOWN\)/);
    expect(src).toMatch(/View all \{excerpts\.length\}/);
    // The payload carries no ranking, so they are not called "best".
    expect(src).toContain("not a ranking");
    expect(src).not.toMatch(/best \d* ?excerpts/i);
  });

  it("filter state is readable, resettable and announced", () => {
    const src = ui();
    expect(src).toContain('aria-pressed={on}');
    expect(src).toContain("Clear filters");
    expect(src).toMatch(/aria-live="polite"[\s\S]{0,200}?No filters applied/);
  });

  it("the modes are a tablist with a selected state", () => {
    const src = panel();
    expect(src).toContain('role="tablist"');
    expect(src).toMatch(/role="tab"[\s\S]{0,200}?aria-selected=\{mode === m\}/);
  });

  it("the detail pane can always be closed, and says what it belongs to", () => {
    const src = ui();
    expect(src).toContain('aria-label="Close document details"');
    expect(src).toMatch(/aria-label=\{`Details for \$\{title\}`\}/);
    // Full-screen below lg, so a narrow viewport is not left scrolling a
    // half-width pane.
    expect(src).toContain("max-lg:fixed max-lg:inset-0");
  });

  it("a coverage metric the client cannot compute says so rather than showing zero", () => {
    const src = ui();
    expect(src).toContain("Not measured");
    expect(src).toMatch(/l\.value === null \? "Not measured"/);
  });

  it("loading, empty and error states are explicit", () => {
    const src = ui();
    expect(src).toMatch(/export function StateNote/);
    expect(src).toMatch(/role=\{kind === "error" \? "alert" : "status"\}/);
  });

  it("the raw database error is no longer rendered to ordinary users", () => {
    const src = panel();
    // The banner states the consequence and keeps the driver message out.
    expect(src).toContain("Case setup is incomplete");
    expect(src).not.toMatch(/\{String\(data\.basisUnreadable\)\}/);
    expect(src).toContain("recorded in the server log");
  });
});

describe("no control is nested inside another control", () => {
  // A <button> inside a <button> is invalid HTML, produces a React hydration
  // error, and collapses two actions into one for assistive technology. The
  // action-summary card had exactly that: a help toggle inside a card button.
  it("the action summary card is a group, not a button", () => {
    const src = stripComments(read("components/case/records/RecordsWorkspace.tsx"));
    const summary = src.match(/export function ActionSummary\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(summary).toBeTruthy();
    // The card element itself must not be a button.
    expect(summary).not.toMatch(/<button[^>]*\n?\s*key=\{c\.key\}/);
    expect(summary).toMatch(/<div key=\{c\.key\} className=\{cn\("rounded-lg border/);
    // Its two controls are siblings.
    expect(summary).toContain("<HelpTip");
    expect(summary).toMatch(/aria-label=\{`Show the \$\{c\.count\}/);
  });
});
