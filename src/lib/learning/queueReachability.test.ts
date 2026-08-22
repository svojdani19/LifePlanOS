// The approval API must be operable by a human.
//
// It shipped with routes, permissions, a credential gate and no consumer:
// candidates were promoted and evaluated by server code and nobody could see
// the queue, let alone approve or refuse an entry. A gate nobody can reach is
// not a gate, and a helper existing in the repository is not implementation.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const root = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const PAGE = "src/app/(app)/settings/learning/page.tsx";
const QUEUE = "src/components/learning/LearningQueue.tsx";
const HUB = "src/app/(app)/firm-admin/page.tsx";

describe("the queue is reachable from the product", () => {
  it("a page exists at the route", () => {
    expect(existsSync(join(root, PAGE))).toBe(true);
  });

  it("the firm-admin hub links to it", () => {
    // Otherwise the page exists at a URL nobody is told about.
    expect(read(HUB)).toContain("/settings/learning");
  });

  it("the page loads the queue through the service, firm-scoped", () => {
    const src = read(PAGE);
    expect(src).toMatch(/listCandidates\s*\(\s*ctx\.firm\.id/);
  });

  it("the page gates on learning.view before rendering anything", () => {
    expect(read(PAGE)).toMatch(/canCanonicalPermission\(ctx,\s*"learning\.view"\)/);
  });
});

describe("the UI reaches the real approval routes", () => {
  const src = read(QUEUE);

  it("posts to the approve and reject endpoints", () => {
    expect(src).toMatch(/\/api\/learning\/candidates\/\$\{id\}\/\$\{action\}/);
    expect(src).toMatch(/"approve"\s*\|\s*"reject"/);
  });

  it.each([
    ["approve", "src/app/api/learning/candidates/[candidateId]/approve/route.ts"],
    ["reject", "src/app/api/learning/candidates/[candidateId]/reject/route.ts"],
    ["list", "src/app/api/learning/candidates/route.ts"],
  ])("the %s route it targets exists", (_label, path) => {
    expect(existsSync(join(root, path))).toBe(true);
  });

  it("a refusal collects a reason, because the route requires one", () => {
    expect(src).toMatch(/reason/);
    expect(read("src/app/api/learning/candidates/[candidateId]/reject/route.ts")).toMatch(/must record a reason/i);
  });
});

describe("the page reflects the policy it cannot enforce", () => {
  const page = read(PAGE);
  const queue = read(QUEUE);

  it("treats the persisted class with the fail-closed parser", () => {
    // Rendering with a cast would show Adopt to an administrator on a lesson
    // the server will refuse — the wrong half of the system being permissive.
    expect(page).toMatch(/parseApprovalClass\(/);
  });

  it("requires a verified physician credential before offering a clinical decision", () => {
    expect(page).toMatch(/hasVerifiedCredential\(ctx,\s*"PHYSICIAN"\)/);
    expect(page).toMatch(/canApproveClinical[\s\S]{0,120}physicianCredentialed/);
  });

  it("separates the two authorities rather than using one flag", () => {
    // Editorial adoption is no longer offered on this surface at all — the key
    // is platformOnly, so asking for it here could only render a dead control.
    expect(page).toMatch(/const canApproveStyle = false;/);
    expect(page).toMatch(/"learning\.approve_clinical"/);
    expect(queue).toMatch(/approvalClass === "CLINICAL" \? canApproveClinical : canApproveStyle/);
  });

  it("explains why a control is unavailable instead of hiding the row", () => {
    expect(queue).toMatch(/whyNot/);
    expect(queue).toMatch(/verified physician credential/i);
  });
});
