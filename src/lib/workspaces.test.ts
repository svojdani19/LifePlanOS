import { describe, expect, it } from "vitest";
import { BUILT_IN_ROLES } from "./authz/roles";
import { WORKSPACES, workspaceHrefForRole } from "./workspaces";

describe("role workspaces", () => {
  it("provides a protected destination for every built-in role", () => {
    for (const key of Object.keys(BUILT_IN_ROLES)) {
      expect(WORKSPACES[key], key).toBeDefined();
      expect(workspaceHrefForRole(key), key).toMatch(/^\//);
    }
  });
  it("uses the safe dashboard fallback for unknown roles", () => {
    expect(workspaceHrefForRole("NOT_A_ROLE")).toBe("/dashboard");
  });
});
