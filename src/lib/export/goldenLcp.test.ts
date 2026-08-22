// ─────────────────────────────────────────────────────────────────────────────
// Golden-file regression test for the Life Care Plan DOCX (buildReportDocx).
//
// Locks word/document.xml against unintended drift: the report is built from a
// complete deterministic in-memory fixture (goldenFixture.ts) with the clock
// frozen, the DOCX is unzipped (jszip — the same library `docx` writes with),
// the XML is normalized, and the result is compared byte-for-byte to the
// committed fixture at __fixtures__/golden-lcp.xml.
//
// Normalization rules (see normalizeXml):
//   1. strip any w:rsid* attributes,
//   2. collapse whitespace between tags.
// Dates need no stripping — the clock is frozen (Date only; real timers stay,
// which jszip's async zip generation needs) so `new Date()` in the report is
// deterministic.
//
// First run (fixture missing): writes the fixture and passes with a note.
// Later runs: any mismatch fails with a readable diff of the first differing
// regions. If the change is INTENTIONAL, delete the fixture to regenerate:
//   rm src/lib/export/__fixtures__/golden-lcp.xml && npx vitest run src/lib/export/goldenLcp.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import JSZip from "jszip";

// The report's ONLY database access is `prisma` from "@/lib/db" (case +
// clinicalReasoningAssessment + validationFinding). Stub all three so the test
// never touches a database.
// Clinical-evidence binding has its own dedicated suite; here the verifier is
// mocked as satisfied so the golden render exercises gate composition +
// language, not fingerprint recomputation.
vi.mock("@/lib/engine/attestationBinding", () => ({
  loadClinicalBindingState: vi.fn(async () => new Map()),
  verifyAttestationClinicalBinding: vi.fn(() => ({ ok: true, reasons: [] })),
}));

vi.mock("@/lib/db", async () => {
  const { goldenCase, goldenAssessments, GOLDEN_CASE_ID } = await import("./goldenFixture");
  return {
    prisma: {
      case: {
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
          if (where.id !== GOLDEN_CASE_ID) throw new Error(`No Case found for id ${where.id}`);
          return goldenCase();
        },
        // Professional-authority gate: the golden case belongs to the golden firm.
        findFirst: async ({ where }: { where: { id: string; firmId: string } }) =>
          where.id === GOLDEN_CASE_ID && where.firmId === "firm-golden" ? { id: GOLDEN_CASE_ID, firmId: "firm-golden" } : null,
      },
      clinicalReasoningAssessment: {
        findMany: async () => goldenAssessments(),
      },
      validationFinding: {
        findMany: async () => [],
        count: async () => 0,
      },
      // A real client always has this model. Omitting it from the double made
      // the loader report the store UNREADABLE — which is now a distinct and
      // much louder state than "this case has no recorded bases", and the right
      // one for a stub that cannot answer. The golden case genuinely has none,
      // so the double says so explicitly.
      recommendationBasis: {
        findMany: async () => [],
      },
      // ── Professional-authority gate lookups (all served from the fixture so
      //    the REAL gate runs and authorizes the golden expert render) ────────
      futureCareItem: {
        findMany: async () => goldenCase().futureCareItems,
      },
      condition: {
        findMany: async () => goldenCase().conditions,
      },
      attestation: {
        findMany: async () => goldenCase().attestations,
      },
      user: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          where.id === "user-golden-md" ? { id: "user-golden-md", role: "PHYSICIAN_REVIEWER" } : null,
      },
      userRoleAssignment: {
        findFirst: async () => null,
      },
      userCredential: {
        findMany: async () => [{ category: "PHYSICIAN", status: "ORG_VERIFIED", expiresAt: null }],
      },
    },
  };
});

import { buildReportDocx } from "./report";
import { GOLDEN_CASE_ID, GOLDEN_TOTALS, goldenAttestationHash } from "./goldenFixture";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "__fixtures__");
const FIXTURE_PATH = path.join(FIXTURE_DIR, "golden-lcp.xml");

const FROZEN_NOW = new Date("2026-01-02T12:00:00Z");

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

/** Normalization: strip revision-save ids, collapse inter-tag whitespace. */
function normalizeXml(xml: string): string {
  return xml
    .replace(/ ?w:rsid[A-Za-z]*="[^"]*"/g, "")
    .replace(/>\s+</g, "><")
    .trim();
}

async function buildNormalizedXml(opts: { draft?: boolean } = {}): Promise<{ documentXml: string; footerXmls: string[] }> {
  const { buffer } = await buildReportDocx(GOLDEN_CASE_ID, "PLAINTIFF", opts);
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file("word/document.xml");
  expect(docFile, "DOCX is missing word/document.xml").toBeTruthy();
  const documentXml = normalizeXml(await docFile!.async("string"));
  const footerNames = Object.keys(zip.files).filter((n) => /^word\/footer\d+\.xml$/.test(n));
  const footerXmls = await Promise.all(footerNames.map(async (n) => normalizeXml(await zip.file(n)!.async("string"))));
  return { documentXml, footerXmls };
}

/** Readable diff: first differing <w:p> regions between actual and expected. */
function diffSummary(actual: string, expected: string, maxRegions = 3): string {
  const a = actual.split("</w:p>");
  const b = expected.split("</w:p>");
  const lines: string[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && lines.length < maxRegions * 3; i++) {
    if ((a[i] ?? "") !== (b[i] ?? "")) {
      const trim = (s: string | undefined) => {
        const t = (s ?? "(missing)").replace(/\s+/g, " ");
        return t.length > 300 ? t.slice(0, 150) + " … " + t.slice(-140) : t;
      };
      lines.push(`--- region #${i} ---`, `  expected: ${trim(b[i])}`, `  actual:   ${trim(a[i])}`);
    }
  }
  if (a.length !== b.length) lines.push(`(paragraph count differs: actual ${a.length}, expected ${b.length})`);
  return lines.join("\n");
}

/** Assert `needles` appear in `haystack` in the given order. */
function expectInOrder(haystack: string, needles: string[]): void {
  let from = 0;
  for (const needle of needles) {
    const idx = haystack.indexOf(needle, from);
    expect(idx, `expected "${needle}" to appear (in order) in document.xml`).toBeGreaterThanOrEqual(0);
    from = idx + needle.length;
  }
}

let finalDoc: { documentXml: string; footerXmls: string[] };

beforeAll(async () => {
  // Freeze ONLY Date (title-page report date, running-header date, patient
  // age). Timers stay real so jszip/docx async zip generation is unaffected.
  vi.useFakeTimers({ now: FROZEN_NOW, toFake: ["Date"] });
  finalDoc = await buildNormalizedXml();
}, 60_000);

afterAll(() => {
  vi.useRealTimers();
});

describe("golden Life Care Plan DOCX", () => {
  it("matches the committed golden fixture (word/document.xml, normalized)", () => {
    if (!existsSync(FIXTURE_PATH)) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(FIXTURE_PATH, finalDoc.documentXml, "utf8");
      console.log(`[goldenLcp] Golden fixture created at ${FIXTURE_PATH} (${finalDoc.documentXml.length} bytes). Commit it; subsequent runs compare against it.`);
      return;
    }
    const expected = readFileSync(FIXTURE_PATH, "utf8");
    if (finalDoc.documentXml !== expected) {
      const summary = diffSummary(finalDoc.documentXml, expected);
      expect.fail(
        `Life Care Plan output drifted — if intentional, delete the fixture to regenerate (rm ${path.relative(process.cwd(), FIXTURE_PATH)}).\nFirst differing regions:\n${summary}`,
      );
    }
  });

  it("renders the report sections in order", () => {
    expectInOrder(finalDoc.documentXml, [
      "LIFE CARE PLAN",
      "Executive Summary",
      "Medical Chronology",
      "Future Medical Needs",
      "The following schedule summarizes the projected future medical care by category", // "Life Care Plan" cost-table region
      "Assumptions",
      "Conclusions",
      "Physician Attestation",
      "References Relied Upon",
    ]);
  });

  it("states the fixture's present-value total", () => {
    expect(finalDoc.documentXml).toContain(money(GOLDEN_TOTALS.presentValue)); // $115,360
    expect(finalDoc.documentXml).toContain(money(GOLDEN_TOTALS.lifetime)); // $140,840
  });

  it("renders the verified attestation with signer name and SHA-256 hash", () => {
    const hash = goldenAttestationHash();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(finalDoc.documentXml).toContain("Jonathan A. Meyer, MD");
    expect(finalDoc.documentXml).toContain(`Attestation integrity hash (SHA-256): ${hash}`);
  });

  it("keeps the REJECTED item out of the cost schedule and discloses it in Limitations", () => {
    const xml = finalDoc.documentXml;
    const rejectedService = "Surveillance MRI of the lumbar spine";

    const tableStart = xml.indexOf("The following schedule summarizes the projected future medical care by category");
    const tableEnd = xml.indexOf("TOTAL FUTURE MEDICAL CARE");
    expect(tableStart).toBeGreaterThanOrEqual(0);
    expect(tableEnd).toBeGreaterThan(tableStart);
    expect(xml.slice(tableStart, tableEnd)).not.toContain(rejectedService);

    // Disclosed in the Limitations section, marked as physician-rejected.
    const limitationsStart = xml.indexOf("The following contingencies are foreseeable");
    expect(limitationsStart).toBeGreaterThan(tableEnd);
    const limitations = xml.slice(limitationsStart, limitationsStart + 4000);
    expect(limitations).toContain(`${rejectedService} — not endorsed on physician review.`);
    // The pending contingency is disclosed there too.
    expect(limitations).toContain("Lumbar transforaminal epidural steroid injection — pending physician confirmation.");
  });

  it("carries the firm name and the confidentiality footer", () => {
    expect(finalDoc.documentXml).toContain("Meridian Life Care Planning"); // title page + signature block
    const someFooterHasBanner = finalDoc.footerXmls.some((f) => f.includes("PREPARED IN ANTICIPATION OF LITIGATION"));
    expect(someFooterHasBanner, "no footer XML carries the confidentiality banner").toBe(true);
  });

  it("shows the DRAFT banner only in draft mode", async () => {
    const banner = "DRAFT — NOT FOR SERVICE OR PRODUCTION";
    expect(finalDoc.documentXml).not.toContain(banner);

    const draft = await buildNormalizedXml({ draft: true });
    expect(draft.documentXml).toContain(banner);
    expect(draft.documentXml).toContain("Appendix G — Unresolved Issues (Draft)");
  }, 60_000);
});
