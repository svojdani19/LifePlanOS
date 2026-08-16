// Every flagged record must say WHY it is flagged and WHAT to do. A card that
// says only "needs review" is a dead end — and, on the reference case, it was
// the state of all 180 flagged records.
//
// Synthetic data only.
import { describe, expect, it } from "vitest";
import { guidanceFor, type GuidanceInput } from "@/lib/records/reviewGuidance";

const base = (over: Partial<GuidanceInput> = {}): GuidanceInput => ({
  status: "AI_AUDIT_PASSED",
  auditResult: "PASS",
  dateStatus: "DOCUMENTED",
  auditVersion: "2026-08-17.scoped-findings",
  unresolvedDisputes: 0,
  contradictedFields: [],
  findings: [],
  ...over,
});

describe("every state explains itself", () => {
  it("never returns an empty reason or an empty next step", () => {
    const states: GuidanceInput[] = [
      base(),
      base({ dateStatus: "UNKNOWN" }),
      base({ status: "STALE" }),
      base({ status: "GENERATION_LOSS" }),
      base({ auditResult: "SOURCE_CONFLICT", unresolvedDisputes: 2 }),
      base({ auditResult: "SOURCE_CONFLICT", auditVersion: null }),
      base({ auditResult: "EXTRACTION_INCOMPLETE" }),
      base({ auditResult: "FAILED" }),
      base({ auditResult: "NEEDS_HUMAN_REVIEW" }),
      base({ contradictedFields: ["date"] }),
      base({ corroboration: { result: "NOT_CORROBORATED", unreproducedFields: ["billedAmount"] } }),
    ];
    for (const s of states) {
      const g = guidanceFor(s);
      expect(g.why.length, JSON.stringify(s)).toBeGreaterThan(30);
      expect(g.steps.length, JSON.stringify(s)).toBeGreaterThan(0);
      expect(g.steps.every((x) => x.length > 10)).toBe(true);
    }
  });
});

describe("the reason matches the evidence", () => {
  it("names the contradicted field and refuses attestation until it is fixed", () => {
    const g = guidanceFor(base({ contradictedFields: ["date"], auditResult: "SOURCE_CONFLICT" }));
    expect(g.kind).toBe("CONTRADICTED_FIELD");
    expect(g.why).toMatch(/contradicts the date/);
    expect(g.canAttest).toBe(false); // the button is disabled, not refused on click
    expect(g.steps.join(" ")).toMatch(/Correct/);
  });

  it("says plainly when the earlier run did not record its reason", () => {
    const g = guidanceFor(base({ auditResult: "SOURCE_CONFLICT", auditVersion: null }));
    expect(g.kind).toBe("LEGACY_CONFLICT");
    expect(g.why).toMatch(/did not record what the disagreement was/);
    // It still offers a way forward rather than stranding the reviewer.
    expect(g.canAttest).toBe(true);
    expect(g.steps.join(" ")).toMatch(/Re-extracting|cited page/);
  });

  it("tells a reviewer that a document problem is not theirs to correct", () => {
    const g = guidanceFor(base({ auditResult: "EXTRACTION_INCOMPLETE" }));
    expect(g.kind).toBe("DOCUMENT_INCOMPLETE");
    expect(g.why).toMatch(/sound in itself/);
    expect(g.steps[0]).toMatch(/Nothing needs correcting/);
    expect(g.canAttest).toBe(true);
  });

  it("blocks attestation on an unsettled disagreement and on an integrity failure", () => {
    expect(guidanceFor(base({ auditResult: "SOURCE_CONFLICT", unresolvedDisputes: 3 })).canAttest).toBe(false);
    expect(guidanceFor(base({ auditResult: "FAILED" })).canAttest).toBe(false);
  });

  it("prefers the most specific evidence when several apply", () => {
    // A contradicted field outranks a generic conflict and an unknown date.
    const g = guidanceFor(base({ auditResult: "SOURCE_CONFLICT", unresolvedDisputes: 2, dateStatus: "UNKNOWN", contradictedFields: ["provider"] }));
    expect(g.kind).toBe("CONTRADICTED_FIELD");
    expect(g.why).toMatch(/the provider/);
  });

  it("uses the recorded stale reason rather than inventing one", () => {
    const g = guidanceFor(base({ status: "STALE", staleReason: "One-time provenance upgrade: …" }));
    expect(g.why).toMatch(/provenance upgrade/);
  });

  it("names the field and page behind a low-confidence-OCR flag", () => {
    const g = guidanceFor(
      base({
        auditResult: "NEEDS_HUMAN_REVIEW",
        claimWarnings: [{ field: "assessment", page: 12, warning: "low-confidence OCR — requires human review" }],
      }),
    );
    expect(g.kind).toBe("LOW_CONFIDENCE_OCR");
    expect(g.why).toMatch(/the assessment \(p\. 12\) was read from/);
    expect(g.canAttest).toBe(true);
  });

  it("explains carried-forward wording and what it does and does not prove", () => {
    const g = guidanceFor(
      base({
        auditResult: "NEEDS_HUMAN_REVIEW",
        claimWarnings: [
          { field: "assessment", page: 4, warning: "text appears carried forward from an earlier note; not evidence it was observed again here" },
          { field: "plan", page: 5, warning: "text appears carried forward from an earlier note; not evidence it was observed again here" },
        ],
      }),
    );
    expect(g.kind).toBe("CARRIED_FORWARD");
    expect(g.why).toMatch(/the assessment and plan \(pp\. 4, 5\) repeat wording/);
    expect(g.why).toMatch(/not evidence the finding was observed again/);
    // Both outcomes are offered: the entry may be a faithful copy of the note.
    expect(g.steps.join(" ")).toMatch(/Verify it as it stands/);
  });

  it("says field names the way a person would read them", () => {
    const g = guidanceFor(base({ contradictedFields: ["objectiveFindings", "pastMedicalHistory"] }));
    expect(g.why).toMatch(/the objective findings and past medical history/);
  });

  it("admits when the check that fired was recorded against the document, not the entry", () => {
    const g = guidanceFor(base({ auditResult: "NEEDS_HUMAN_REVIEW" }));
    expect(g.kind).toBe("REVIEW_FLAG");
    // No guessing at a cause it cannot see.
    expect(g.why).not.toMatch(/commonly|probably|likely/i);
    expect(g.why).toMatch(/recorded against the document/);
  });

  it("does not turn a claim warning on a passing record into an exception", () => {
    // Warnings are evidence for a flag that the audit already raised; they may
    // never raise one themselves, or every carried-forward line would become a
    // review obligation.
    const g = guidanceFor(base({ claimWarnings: [{ field: "plan", page: 3, warning: "text appears carried forward from an earlier note" }] }));
    expect(g.kind).toBe("CLEAN");
  });

  it("tells a clean record it still needs a person", () => {
    const g = guidanceFor(base());
    expect(g.kind).toBe("CLEAN");
    expect(g.why).toMatch(/still needs a person/);
    expect(g.canAttest).toBe(true);
  });
});
