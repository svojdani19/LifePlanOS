import { describe, it, expect } from "vitest";
import { REPORT_FLAGS, REPORT_FLAG_BY_ID, flagEnabled, reportEnabled, type ReportFlagKey } from "@/lib/flags";

describe("REPORT_FLAGS defaults", () => {
  it("pilot posture: four established reports on, everything else off", () => {
    expect(REPORT_FLAGS["report.medical_chronology"]).toBe(true);
    expect(REPORT_FLAGS["report.medical_summary"]).toBe(true);
    expect(REPORT_FLAGS["report.provider_matrix"]).toBe(true);
    expect(REPORT_FLAGS["report.medical_cost_projection"]).toBe(true);
    const off: ReportFlagKey[] = [
      "report.vocational_assessment", "report.forensic_economist", "report.medical_necessity",
      "report.causation", "report.defense_rebuttal", "report.custom", "report.damages_summary",
      "report.report_level_attestation",
    ];
    for (const key of off) expect(REPORT_FLAGS[key]).toBe(false);
    expect(Object.keys(REPORT_FLAGS)).toHaveLength(12);
  });
});

describe("flagEnabled", () => {
  it("no firm features → default", () => {
    expect(flagEnabled(null, "report.medical_chronology")).toBe(true);
    expect(flagEnabled(undefined, "report.vocational_assessment")).toBe(false);
    expect(flagEnabled({}, "report.forensic_economist")).toBe(false);
  });

  it("firm override wins: on for a default-off flag", () => {
    const features = { "report.vocational_assessment": true };
    expect(flagEnabled(features, "report.vocational_assessment")).toBe(true);
  });

  it("firm override wins: off for a default-on flag", () => {
    const features = { "report.medical_chronology": false };
    expect(flagEnabled(features, "report.medical_chronology")).toBe(false);
  });

  it("malformed Json → default", () => {
    expect(flagEnabled("not-an-object", "report.medical_chronology")).toBe(true);
    expect(flagEnabled(42, "report.vocational_assessment")).toBe(false);
    expect(flagEnabled(["report.medical_chronology"], "report.medical_chronology")).toBe(true);
    // non-boolean override value is ignored → default
    expect(flagEnabled({ "report.medical_chronology": "yes" }, "report.medical_chronology")).toBe(true);
    expect(flagEnabled({ "report.vocational_assessment": 1 }, "report.vocational_assessment")).toBe(false);
  });

  it("unknown key → false, even with a firm 'override'", () => {
    const bogus = "report.does_not_exist" as ReportFlagKey;
    expect(flagEnabled(null, bogus)).toBe(false);
    expect(flagEnabled({ "report.does_not_exist": true }, bogus)).toBe(false);
  });
});

describe("REPORT_FLAG_BY_ID / reportEnabled", () => {
  it("null-key ids are never disabled, whatever the firm Json says", () => {
    for (const id of ["LIFE_CARE_PLAN", "TESTIMONY_PACK", "PHYSICIAN_REVIEW_REPORT"]) {
      expect(REPORT_FLAG_BY_ID[id]).toBeNull();
      expect(reportEnabled(null, id)).toBe(true);
      expect(reportEnabled({ "report.custom": false, LIFE_CARE_PLAN: false }, id)).toBe(true);
    }
  });

  it("legacy COST_PROJECTION alias shares the medical_cost_projection flag", () => {
    expect(REPORT_FLAG_BY_ID.COST_PROJECTION).toBe("report.medical_cost_projection");
    expect(REPORT_FLAG_BY_ID.MEDICAL_COST_PROJECTION).toBe("report.medical_cost_projection");
    expect(reportEnabled(null, "COST_PROJECTION")).toBe(true);
    expect(reportEnabled({ "report.medical_cost_projection": false }, "COST_PROJECTION")).toBe(false);
    expect(reportEnabled({ "report.medical_cost_projection": false }, "MEDICAL_COST_PROJECTION")).toBe(false);
  });

  it("gated ids follow their flag defaults and overrides", () => {
    expect(reportEnabled(null, "VOCATIONAL_ASSESSMENT")).toBe(false);
    expect(reportEnabled({ "report.vocational_assessment": true }, "VOCATIONAL_ASSESSMENT")).toBe(true);
    expect(reportEnabled(null, "MEDICAL_CHRONOLOGY")).toBe(true);
    expect(reportEnabled({ "report.medical_chronology": false }, "MEDICAL_CHRONOLOGY")).toBe(false);
  });

  it("every mapped flag key exists in REPORT_FLAGS", () => {
    for (const key of Object.values(REPORT_FLAG_BY_ID)) {
      if (key !== null) expect(key in REPORT_FLAGS).toBe(true);
    }
  });
});
