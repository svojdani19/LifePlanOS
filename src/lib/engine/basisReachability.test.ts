// Reachability: the production paths must USE the recorded basis.
//
// A helper that reads the basis is not a safeguard if nothing calls it. The
// previous version of this separation shipped two well-named wrappers that both
// delegated to the same current-record builder, and every production caller
// went on calling the builder directly — so the recorded basis influenced
// nothing but a hash.
//
// These tests read the production sources. They are deliberately structural:
// a behavioural test can pass while the presentation path quietly re-derives,
// because a freshly derived assessment of an unchanged record looks identical.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** Strip comments so a mention in prose is not mistaken for a call. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const PRESENTATION_PATHS = [
  ["the physician panel", "src/components/case/CaseWorkspace.tsx"],
  ["the persistence path", "src/lib/engine/clinicalReasoningPersist.ts"],
  ["the exported report", "src/lib/export/report.ts"],
] as const;

describe("every presentation path consumes the recorded basis", () => {
  it.each(PRESENTATION_PATHS)("%s calls assessmentFromBasis", (_label, path) => {
    expect(code(read(path))).toMatch(/\bassessmentFromBasis\s*\(/);
  });

  it.each(PRESENTATION_PATHS)("%s never calls the raw current-record builder", (_label, path) => {
    // buildReasoningAssessment derives from whatever the record says right now.
    // Reaching it from a path that DISPLAYS or PERSISTS is the defect.
    expect(code(read(path))).not.toMatch(/\bbuildReasoningAssessment\s*\(/);
  });

  it("the witness is used only as a fallback, never ahead of the basis", () => {
    // In each file the basis read must appear before the witness call, and the
    // witness must be guarded by a null basis.
    for (const [, path] of PRESENTATION_PATHS) {
      const src = code(read(path));
      const basisAt = src.indexOf("assessmentFromBasis(");
      const witnessAt = src.indexOf("deriveWitnessAssessment(");
      if (witnessAt === -1) continue;
      expect(basisAt, `${path}: basis read must precede the witness fallback`).toBeGreaterThan(-1);
      expect(basisAt).toBeLessThan(witnessAt);
    }
  });
});

describe("one derivation of the basis, used by recorder and witness alike", () => {
  const CALLERS = [
    ["generation records", "src/lib/engine/generate.ts"],
    ["validation witnesses", "src/lib/engine/validation.ts"],
    ["the report witnesses", "src/lib/export/report.ts"],
  ] as const;

  it.each(CALLERS)("%s through assembleBasis", (_label, path) => {
    expect(code(read(path))).toMatch(/\bassembleBasis\s*\(/);
  });

  it.each(CALLERS)("%s does not hand-roll buildBasis", (_label, path) => {
    // Three hand-rolled calls is how a basis comes to disagree with every
    // rebuild of itself: each site derives "the same" inputs slightly
    // differently and the hash never matches again.
    expect(code(read(path))).not.toMatch(/\bbuildBasis\s*\(/);
  });
});

describe("the reasoning module keeps the two jobs separable", () => {
  const src = code(read("src/lib/engine/clinicalReasoning.ts"));

  it("exports both entry points", () => {
    expect(src).toMatch(/export function assessmentFromBasis\s*\(/);
    expect(src).toMatch(/export function deriveWitnessAssessment\s*\(/);
  });

  it("assessmentFromBasis does not delegate to the current-record builder", () => {
    // This is the exact defect: a wrapper whose name promised the record and
    // whose body returned a fresh derivation.
    const start = src.indexOf("export function assessmentFromBasis");
    const end = src.indexOf("export function deriveWitnessAssessment");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toMatch(/buildReasoningAssessment\s*\(/);
  });

  it("deriveWitnessAssessment cannot be handed a basis", () => {
    const start = src.indexOf("export function deriveWitnessAssessment");
    const sig = src.slice(start, start + 600);
    expect(sig).not.toMatch(/recordedBasis\s*:/);
  });
});
