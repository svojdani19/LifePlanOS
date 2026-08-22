// Who may adopt a learned lesson.
//
// STYLE approval was granted to FIRM_ADMINISTRATOR, and the UI said firm admins
// could approve. FIRM_ADMINISTRATOR is not the product's all-access authority —
// its own description says it cannot attest reports or vocational/economic
// conclusions, and physician sign-off is credential-gated away from it. It is
// the most powerful role INSIDE a firm, which is a different thing. Granting it
// STYLE approval handed a standing behavioural change to every ordinary firm
// administrator.

import { describe, it, expect } from "vitest";
import { ALL_ROLE_TEMPLATES } from "@/lib/authz/roles";
import { getDefinition } from "@/lib/authz/registry";

const keysOf = (name: string) => {
  const t = (ALL_ROLE_TEMPLATES as Record<string, { permissions: readonly string[] }>)[name];
  expect(t, `template ${name} should exist`).toBeTruthy();
  return t.permissions as readonly string[];
};

describe("the role matrix for learning approval", () => {
  it("the platform operator is the designated all-access authority and holds STYLE approval", () => {
    // This product has no literal SUPER_ADMIN. PLATFORM_SYSTEM_ADMINISTRATOR is
    // the operator role, above every firm role.
    expect(keysOf("PLATFORM_SYSTEM_ADMINISTRATOR")).toContain("learning.approve");
  });

  it("an ordinary firm administrator may SEE the queue and may not adopt from it", () => {
    const admin = keysOf("FIRM_ADMINISTRATOR");
    expect(admin).toContain("learning.view");
    expect(admin).not.toContain("learning.approve");
    expect(admin).not.toContain("learning.approve_clinical");
  });

  it("clinical approval stays with the credentialed clinician, not the operator", () => {
    // No amount of platform authority makes someone qualified to adopt a
    // standing medical opinion.
    expect(keysOf("PHYSICIAN_REVIEWER")).toContain("learning.approve_clinical");
    expect(keysOf("PLATFORM_SYSTEM_ADMINISTRATOR")).not.toContain("learning.approve_clinical");
  });

  it("no other built-in role can adopt anything", () => {
    for (const [name, t] of Object.entries(ALL_ROLE_TEMPLATES as Record<string, { permissions: readonly string[] }>)) {
      const p = t.permissions as readonly string[];
      if (name !== "PLATFORM_SYSTEM_ADMINISTRATOR") expect(p, `${name}`).not.toContain("learning.approve");
      if (name !== "PHYSICIAN_REVIEWER") expect(p, `${name}`).not.toContain("learning.approve_clinical");
    }
  });
});

describe("the permission definitions match that policy", () => {
  it("learning.approve is platform-only and cannot be delegated or cloned", () => {
    const d = getDefinition("learning.approve")!;
    expect(d.platformOnly).toBe(true);
    expect(d.delegable).toBe(false);
    expect(d.customRoleAssignable).toBe(false);
    expect(d.externalAssignable).toBe(false);
  });

  it("learning.approve_clinical requires a physician credential and cannot be cloned", () => {
    const d = getDefinition("learning.approve_clinical")!;
    expect(d.requiresCredential).toBe("PHYSICIAN");
    expect(d.delegable).toBe(false);
    expect(d.customRoleAssignable).toBe(false);
  });

  it("neither can be assigned to an external collaborator", () => {
    expect(getDefinition("learning.approve")!.externalAssignable).toBe(false);
    expect(getDefinition("learning.approve_clinical")!.externalAssignable).toBe(false);
  });

  it("viewing the queue is not privileged — seeing what a firm learned is not adopting it", () => {
    expect(getDefinition("learning.view")!.privileged).toBe(false);
  });
});

describe("what the interface says matches what the server does", () => {
  /** Source with comments stripped: a comment quoting the old copy is not copy. */
  const read = async (rel: string) => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    return readFileSync(join(__dirname, "..", "..", "..", rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  };

  it("the queue no longer tells a firm administrator they can approve", async () => {
    const src = await read("src/components/learning/LearningQueue.tsx");
    expect(src).not.toMatch(/requires firm-administrator access/i);
    expect(src).toMatch(/rests with the platform operator/i);
  });

  it("the firm-admin card describes the real authority", async () => {
    const src = await read("src/app/(app)/firm-admin/page.tsx");
    expect(src).toMatch(/adopted by the platform operator/i);
    expect(src).not.toMatch(/Editorial lessons are adopted here/);
  });

  it("the page still gates rendering on the same keys the routes enforce", async () => {
    const src = await read("src/app/(app)/settings/learning/page.tsx");
    expect(src).toMatch(/canCanonicalPermission\(ctx, "learning\.approve"\)/);
    expect(src).toMatch(/canCanonicalPermission\(ctx, "learning\.approve_clinical"\)/);
  });

  it("every adoption remains reviewable and audited", async () => {
    const approve = await read("src/app/api/learning/candidates/[candidateId]/approve/route.ts");
    const reject = await read("src/app/api/learning/candidates/[candidateId]/reject/route.ts");
    expect(approve).toMatch(/audit\(ctx, "learning\.approve"/);
    expect(reject).toMatch(/audit\(ctx, "learning\.reject"/);
    // Inside the transaction, so a decision cannot land unattributable.
    expect(approve).toMatch(/tx as never/);
    expect(reject).toMatch(/tx as never/);
  });
});
