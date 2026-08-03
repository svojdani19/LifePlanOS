// Draft and unattested Life Care Plan output must carry NO first-person
// medical opinion and NO signature block; verified final output must carry the
// verified signer and the signed attestation text. Built on the same
// deterministic golden fixture as the golden regression, with the signer's
// credential toggleable so both sides of the professional-authority gate are
// exercised through the REAL gate.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import JSZip from "jszip";

const state = vi.hoisted(() => ({ credentialed: true }));

vi.mock("@/lib/db", async () => {
  const { goldenCase, goldenAssessments, GOLDEN_CASE_ID } = await import("./goldenFixture");
  return {
    prisma: {
      case: {
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
          if (where.id !== GOLDEN_CASE_ID) throw new Error(`No Case found for id ${where.id}`);
          return goldenCase();
        },
        findFirst: async ({ where }: { where: { id: string; firmId: string } }) =>
          where.id === GOLDEN_CASE_ID && where.firmId === "firm-golden" ? { id: GOLDEN_CASE_ID, firmId: "firm-golden" } : null,
      },
      clinicalReasoningAssessment: { findMany: async () => goldenAssessments() },
      validationFinding: { findMany: async () => [] },
      futureCareItem: { findMany: async () => goldenCase().futureCareItems },
      condition: { findMany: async () => goldenCase().conditions },
      attestation: { findMany: async () => goldenCase().attestations },
      user: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          where.id === "user-golden-md" ? { id: "user-golden-md", role: "PHYSICIAN_REVIEWER" } : null,
      },
      userRoleAssignment: { findFirst: async () => null },
      userCredential: {
        findMany: async () => (state.credentialed ? [{ category: "PHYSICIAN", status: "ORG_VERIFIED", expiresAt: null }] : []),
      },
    },
  };
});

import { buildReportDocx } from "./report";
import { GOLDEN_CASE_ID, goldenAttestationHash } from "./goldenFixture";

async function documentText(opts: { draft?: boolean }, credentialed: boolean): Promise<string> {
  state.credentialed = credentialed;
  const { buffer } = await buildReportDocx(GOLDEN_CASE_ID, "PLAINTIFF", opts);
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")!.async("string");
  // Strip tags and decode basic entities → running text for phrase assertions.
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#8217;/g, "'");
}

const FIRST_PERSON = [
  "it is my opinion",
  "my review of the records",
  "I have been asked",
  "I have personally reviewed",
  "based upon my professional training",
  "My qualifications",
  "I reserve the right",
];

beforeAll(() => {
  vi.useFakeTimers({ now: new Date("2026-01-02T12:00:00Z"), toFake: ["Date"] });
});
afterAll(() => {
  vi.useRealTimers();
  state.credentialed = true;
});

describe("expert voice is rendered only from verified authority", () => {
  it("a FINAL render without a credentialed signer is neutral: no first-person opinion, no signature block", async () => {
    const text = await documentText({}, false);
    for (const phrase of FIRST_PERSON) expect(text, `should not contain "${phrase}"`).not.toContain(phrase);
    expect(text).not.toContain("Respectfully submitted");
    expect(text).not.toContain("Signed electronically by");
    expect(text).not.toContain("Physician Attestation");
    expect(text).toContain("The current record-supported projection identifies");
    expect(text).toContain("subject to review and adoption by the appropriately credentialed professional");
    expect(text).toContain("No professional attestation is currently attached");
    expect(text).toContain("Preparation & Review Status");
    expect(text).toContain("DRAFT, not signed");
  });

  it("a DRAFT render is neutral even when a valid attestation exists", async () => {
    const text = await documentText({ draft: true }, true);
    for (const phrase of FIRST_PERSON) expect(text, `should not contain "${phrase}"`).not.toContain(phrase);
    expect(text).not.toContain("Respectfully submitted");
    expect(text).not.toContain("Signed electronically by");
    expect(text).toContain("DRAFT — NOT FOR SERVICE OR PRODUCTION");
    expect(text).toContain("No professional attestation is currently attached");
  });

  it("a verified FINAL render carries the signer, the signed statement, and its integrity hash", async () => {
    const text = await documentText({}, true);
    expect(text).toContain("it is my opinion");
    expect(text).toContain("Jonathan A. Meyer, MD");
    expect(text).toContain("I have personally reviewed the medical records");
    expect(text).toContain("Respectfully submitted");
    expect(text).toContain(`Attestation integrity hash (SHA-256): ${goldenAttestationHash()}`);
    expect(text).not.toContain("No professional attestation is currently attached");
    expect(text).not.toContain("DRAFT, not signed");
  });

  it("the verified voice never falls back to the case creator as the expert signer", async () => {
    // The golden fixture's creator is a paralegal seat; the signer is the
    // attesting physician. Verified output must name the physician in the
    // signature area, and neutral output must not attribute opinions to anyone.
    const verified = await documentText({}, true);
    const signatureRegion = verified.slice(verified.indexOf("Respectfully submitted"));
    expect(signatureRegion).toContain("Jonathan A. Meyer, MD");
  });
});
