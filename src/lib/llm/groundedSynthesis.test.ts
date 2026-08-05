// Synthesis may say only what the validated claims support. These tests pin
// the rejections and the deterministic fallback that makes rejection safe.
import { describe, it, expect } from "vitest";
import { checkSentence, deterministicSummary, synthesizeEncounter, type SynthClaim } from "./groundedSynthesis";
import type { LlmProvider } from "@/lib/llm";

const claims: SynthClaim[] = [
  { id: "c1", field: "assessment", claimType: "DIAGNOSIS", value: "Lumbar radiculopathy", excerpt: "Assessment: Lumbar radiculopathy.", page: 1 },
  { id: "c2", field: "treatment", claimType: "RECOMMENDED_TREATMENT", value: "Epidural steroid injection recommended at L4-L5", excerpt: "Plan: Recommend epidural steroid injection at L4-L5.", page: 1 },
  { id: "c3", field: "objectiveFindings", claimType: "PROVIDER_OBSERVATION", value: "Left knee effusion", excerpt: "Exam: left knee effusion.", page: 2 },
];
const byId = new Map(claims.map((c) => [c.id, c]));

const provider = (payloads: string[]): LlmProvider & { calls: number } => {
  let i = 0;
  const p = { name: "fake", calls: 0, async complete() { p.calls++; return payloads[Math.min(i++, payloads.length - 1)]; } };
  return p;
};

describe("sentence-level grounding", () => {
  it("accepts a sentence its cited claims support", () => {
    expect(checkSentence("Assessment was lumbar radiculopathy.", ["c1"], byId)).toBeNull();
  });

  it("rejects a sentence citing an unknown claim", () => {
    expect(checkSentence("Anything.", ["nope"], byId)).toMatch(/not part of this encounter/);
  });

  it("rejects switched or invented laterality", () => {
    expect(checkSentence("Right knee effusion was noted.", ["c3"], byId)).toMatch(/laterality/);
  });

  it("rejects an introduced date", () => {
    expect(checkSentence("On 01/02/2024 the assessment was lumbar radiculopathy.", ["c1"], byId)).toMatch(/date/);
  });

  it("rejects an introduced proper name", () => {
    expect(checkSentence("Dana Rivers recorded lumbar radiculopathy.", ["c1"], byId)).toMatch(/name/);
  });

  it("rejects manufactured certainty", () => {
    expect(checkSentence("The record confirms lumbar radiculopathy.", ["c1"], byId)).toMatch(/certainty/);
  });

  it("rejects narrating recommended care as delivered", () => {
    expect(checkSentence("The patient underwent an epidural steroid injection.", ["c2"], byId)).toMatch(/only as recommended/);
  });

  it("accepts recommended care described as recommended", () => {
    expect(checkSentence("An epidural steroid injection was recommended.", ["c2"], byId)).toBeNull();
  });
});

describe("deterministic fallback", () => {
  it("renders directly from claims", () => {
    expect(deterministicSummary(claims)).toMatch(/^Lumbar radiculopathy\./);
  });

  it("states plainly when nothing can be summarized", () => {
    expect(deterministicSummary([])).toMatch(/No reliable clinical summary could be generated/);
  });
});

describe("synthesis flow", () => {
  const good = JSON.stringify({
    sentences: [
      { text: "Assessment was lumbar radiculopathy.", claimIds: ["c1"] },
      { text: "An epidural steroid injection was recommended.", claimIds: ["c2"] },
    ],
  });

  it("accepts a fully attributed synthesis and returns its sentence map", async () => {
    const p = provider([good]);
    const r = await synthesizeEncounter(claims, { provider: p });
    expect(r.fallback).toBe(false);
    expect(r.text).toContain("lumbar radiculopathy");
    expect(Object.keys(r.sentenceClaimMap)).toHaveLength(2);
    expect(p.calls).toBe(1);
  });

  it("retries once with the reasons, then accepts a corrected synthesis", async () => {
    const bad = JSON.stringify({ sentences: [{ text: "The patient underwent an epidural steroid injection.", claimIds: ["c2"] }] });
    const p = provider([bad, good]);
    const r = await synthesizeEncounter(claims, { provider: p });
    expect(p.calls).toBe(2);
    expect(r.fallback).toBe(false);
    expect(r.rejections.join(" ")).toMatch(/only as recommended/);
  });

  it("falls back deterministically when the retry also fails — never unverified prose", async () => {
    const bad = JSON.stringify({ sentences: [{ text: "The patient underwent surgery on 05/05/2024.", claimIds: ["c1"] }] });
    const p = provider([bad, bad]);
    const r = await synthesizeEncounter(claims, { provider: p });
    expect(p.calls).toBe(2);
    expect(r.fallback).toBe(true);
    expect(r.text).toBe(deterministicSummary(claims));
    expect(r.sentenceClaimMap).toEqual({});
  });

  it("a provider error falls back rather than failing the encounter", async () => {
    const failing: LlmProvider = { name: "fake", complete: async () => { throw new Error("down"); } };
    const r = await synthesizeEncounter(claims, { provider: failing });
    expect(r.fallback).toBe(true);
    expect(r.text).toBeTruthy();
  });

  it("the mock provider yields the deterministic summary, never invented prose", async () => {
    const mock: LlmProvider = { name: "mock", complete: async () => "[mock]" };
    const r = await synthesizeEncounter(claims, { provider: mock });
    expect(r.fallback).toBe(true);
    expect(r.text).toBe(deterministicSummary(claims));
  });
});
