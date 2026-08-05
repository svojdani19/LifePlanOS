// records.verify — factual record review is a FIRM-ROLE capability:
//   • granted to the roles that perform factual record review,
//   • NEVER carried by platform/super-admin status alone,
//   • never attached to attorney/observer/external seats,
//   • and read-only support mode cannot exercise it.
import { describe, it, expect } from "vitest";
import {
  PLATFORM_SYSTEM_ADMINISTRATOR,
  FIRM_ADMINISTRATOR,
  CASE_MANAGER,
  MEDICAL_RECORD_ANALYST,
  LIFE_CARE_PLANNER,
  PHYSICIAN_REVIEWER_TEMPLATE,
  QUALITY_ASSURANCE_REVIEWER,
  VOCATIONAL_EXPERT,
  FORENSIC_ECONOMIST,
  EXTERNAL_EXPERT,
  ATTORNEY_CLIENT,
  INSURANCE_CLIENT,
  READ_ONLY_OBSERVER,
} from "./roles";
import { getDefinition } from "./registry";

describe("records.verify grants", () => {
  it("is a registered canonical permission", () => {
    expect(getDefinition("records.verify")).toBeTruthy();
  });

  it("is granted to the factual-review roles", () => {
    for (const t of [FIRM_ADMINISTRATOR, CASE_MANAGER, MEDICAL_RECORD_ANALYST, LIFE_CARE_PLANNER, PHYSICIAN_REVIEWER_TEMPLATE, QUALITY_ASSURANCE_REVIEWER]) {
      expect(t.permissions, t.key).toContain("records.verify");
    }
  });

  it("platform/super-admin status alone NEVER carries it", () => {
    expect(PLATFORM_SYSTEM_ADMINISTRATOR.permissions).not.toContain("records.verify");
  });

  it("attorney, insurance, observer, and external-expert seats do not verify record facts", () => {
    for (const t of [ATTORNEY_CLIENT, INSURANCE_CLIENT, READ_ONLY_OBSERVER, EXTERNAL_EXPERT, VOCATIONAL_EXPERT, FORENSIC_ECONOMIST]) {
      expect(t.permissions, t.key).not.toContain("records.verify");
    }
  });
});
