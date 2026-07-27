import { describe, it, expect, afterEach, vi } from "vitest";
import { getProvider, providerInfo, validateLlmEnv, complete, LlmConfigError } from "@/lib/llm";

// Production-safety rules: the mock provider must be impossible to reach in
// production — misconfiguration is a loud error, never a silent fallback.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getProvider — production", () => {
  it("throws when LLM_PROVIDER is unset (mock forbidden)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LLM_PROVIDER", "");
    expect(() => getProvider()).toThrow("LLM_PROVIDER is not configured; the mock provider is not permitted in production.");
    expect(() => getProvider()).toThrow(LlmConfigError);
  });

  it("throws when anthropic is named but ANTHROPIC_API_KEY is missing (no fallback)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => getProvider()).toThrow(/ANTHROPIC_API_KEY is missing/);
    expect(() => getProvider()).toThrow(LlmConfigError);
  });

  it("throws on an unknown provider name (never silent mock)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LLM_PROVIDER", "openai");
    expect(() => getProvider()).toThrow(/not a supported provider/);
  });

  it("throws when mock is explicitly requested", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LLM_PROVIDER", "mock");
    expect(() => getProvider()).toThrow(LlmConfigError);
  });

  it("returns the anthropic provider when fully configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    expect(getProvider().name).toBe("anthropic");
  });
});

describe("getProvider — non-production", () => {
  it("returns mock when LLM_PROVIDER is unset, and completions carry the label", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LLM_PROVIDER", "");
    const provider = getProvider();
    expect(provider.name).toBe("mock");
    const text = await complete({ messages: [{ role: "user", content: "hello" }] });
    expect(text.startsWith("[mock LLM response —")).toBe(true);
  });

  it("falls back to labeled mock when anthropic is named without a key", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const provider = getProvider();
    expect(provider.name).toBe("mock");
    const text = await provider.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(text.startsWith("[mock LLM response —")).toBe(true);
  });
});

describe("providerInfo", () => {
  it("mock reports name with null model", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LLM_PROVIDER", "");
    expect(providerInfo()).toEqual({ name: "mock", model: null });
  });

  it("anthropic reports its resolved default model", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    expect(providerInfo()).toEqual({ name: "anthropic", model: "claude-sonnet-4-5" });
  });

  it("anthropic reports an explicit ANTHROPIC_MODEL override", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_MODEL", "claude-opus-4-6");
    expect(providerInfo()).toEqual({ name: "anthropic", model: "claude-opus-4-6" });
  });

  it("propagates config errors in production so callers can 503", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LLM_PROVIDER", "");
    expect(() => providerInfo()).toThrow(LlmConfigError);
  });
});

describe("validateLlmEnv (pure)", () => {
  it("absent LLM_PROVIDER is consistent (no failures) in both modes", () => {
    expect(validateLlmEnv({}, false)).toEqual([]);
    expect(validateLlmEnv({}, true)).toEqual([]);
  });

  it("named provider without creds fails", () => {
    expect(validateLlmEnv({ LLM_PROVIDER: "anthropic" }, true)).toHaveLength(1);
    expect(validateLlmEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }, true)).toEqual([]);
  });

  it("mock fails only in production; unknown fails everywhere", () => {
    expect(validateLlmEnv({ LLM_PROVIDER: "mock" }, false)).toEqual([]);
    expect(validateLlmEnv({ LLM_PROVIDER: "mock" }, true)).toHaveLength(1);
    expect(validateLlmEnv({ LLM_PROVIDER: "openai" }, false)).toHaveLength(1);
    expect(validateLlmEnv({ LLM_PROVIDER: "openai" }, true)).toHaveLength(1);
  });
});
