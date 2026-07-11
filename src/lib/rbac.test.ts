import { describe, it, expect } from "vitest";
import { can, ROLE_PERMISSIONS } from "./rbac";

describe("can — role/permission matrix", () => {
  it("grants admins full access", () => {
    expect(can("ADMIN", "firm.settings")).toBe(true);
    expect(can("ADMIN", "billing.manage")).toBe(true);
    expect(can("ADMIN", "physician.review")).toBe(true);
  });

  it("lets planners manage the precedent library but not billing", () => {
    expect(can("PLANNER", "precedents.manage")).toBe(true);
    expect(can("PLANNER", "billing.manage")).toBe(false);
  });

  it("restricts a paralegal from physician sign-off", () => {
    expect(can("PARALEGAL", "physician.review")).toBe(false);
    expect(can("PARALEGAL", "records.upload")).toBe(true);
  });

  it("scopes a billing user to billing only", () => {
    expect(can("BILLING_USER", "billing.manage")).toBe(true);
    expect(can("BILLING_USER", "case.view")).toBe(false);
  });

  it("only physician reviewers can sign off on medical necessity", () => {
    expect(can("PHYSICIAN_REVIEWER", "physician.review")).toBe(true);
    expect(can("ATTORNEY_REVIEWER", "physician.review")).toBe(false);
  });

  it("defines a permission set for every role", () => {
    for (const role of Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[]) {
      expect(Array.isArray(ROLE_PERMISSIONS[role])).toBe(true);
    }
  });
});
