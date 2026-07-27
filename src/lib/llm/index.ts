// ─────────────────────────────────────────────────────────────────────────────
// LLM abstraction layer. The product's AI features (chronology synthesis,
// future-care recommendations, defense critique) call `complete()` — never a
// provider SDK directly — so the model provider is a one-line swap and every
// call runs through the same guardrail wrapper.
//
// The mock provider is deterministic so the app is fully demoable with no API
// keys. Real providers (Anthropic/OpenAI) plug in behind the same interface.
// ─────────────────────────────────────────────────────────────────────────────

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface LlmProvider {
  name: string;
  complete(opts: CompleteOptions): Promise<string>;
}

/**
 * Thrown when the LLM provider configuration is invalid for the current
 * environment (e.g. mock in production, named provider without credentials).
 * Callers catch this to return an explicit 503 instead of a generic 500.
 */
export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";

const mockProvider: LlmProvider = {
  name: "mock",
  async complete({ messages }) {
    const last = messages[messages.length - 1]?.content ?? "";
    return [
      "[mock LLM response — set LLM_PROVIDER + an API key to use a real model]",
      `Received ${messages.length} message(s). Last prompt begins: "${last.slice(0, 80)}"`,
    ].join("\n");
  },
};

// Anthropic Messages API provider (HIPAA-eligible under a BAA). No SDK — just
// fetch — so it adds no dependency. Set LLM_PROVIDER=anthropic and
// ANTHROPIC_API_KEY (optionally ANTHROPIC_MODEL) to activate.
function anthropicProvider(): LlmProvider {
  return {
    name: "anthropic",
    async complete({ system, messages, maxTokens, temperature }) {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new LlmConfigError("ANTHROPIC_API_KEY is not set.");
      const model = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
      // Anthropic takes `system` separately; fold any system-role messages in.
      const sys = [system, ...messages.filter((m) => m.role === "system").map((m) => m.content)].filter(Boolean).join("\n\n");
      const convo = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: maxTokens ?? 1024, temperature, system: sys || undefined, messages: convo }),
      });
      if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { content?: { type: string; text?: string }[] };
      return (data.content ?? []).map((b) => b.text ?? "").join("");
    },
  };
}

/**
 * Pure LLM env validation, shared by getProvider() and startup env checks.
 * Returns human-readable failures (no secret values). An absent LLM_PROVIDER is
 * consistent (assistant disabled in production / mocked in dev) — only a *named*
 * provider with missing credentials, an unknown name, or mock-in-production is
 * a failure.
 */
export function validateLlmEnv(
  env: Record<string, string | undefined> = process.env,
  production: boolean = env.NODE_ENV === "production",
): string[] {
  const failures: string[] = [];
  const provider = env.LLM_PROVIDER;
  if (!provider) return failures;
  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) failures.push("LLM_PROVIDER=anthropic is set but ANTHROPIC_API_KEY is missing.");
  } else if (provider === "mock") {
    if (production) failures.push("LLM_PROVIDER=mock is not permitted in production.");
  } else {
    failures.push(`LLM_PROVIDER="${provider}" is not a supported provider (expected "anthropic").`);
  }
  return failures;
}

export function getProvider(): LlmProvider {
  const production = process.env.NODE_ENV === "production";
  const provider = process.env.LLM_PROVIDER;

  if (production) {
    // The mock provider is FORBIDDEN in production — never a silent fallback.
    if (!provider) {
      throw new LlmConfigError("LLM_PROVIDER is not configured; the mock provider is not permitted in production.");
    }
    if (provider === "anthropic") {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new LlmConfigError(
          "LLM_PROVIDER=anthropic is set but ANTHROPIC_API_KEY is missing; refusing to fall back to the mock provider in production.",
        );
      }
      return anthropicProvider();
    }
    throw new LlmConfigError(
      `LLM_PROVIDER="${provider}" is not a supported provider; the mock provider is not permitted in production.`,
    );
  }

  // Non-production: real provider when fully configured, otherwise the clearly
  // labeled mock (every mock completion begins with "[mock LLM response —").
  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) return anthropicProvider();
  return mockProvider;
}

/**
 * Provenance for audit records: which provider and (for real providers) which
 * resolved model would serve a completion right now. Throws LlmConfigError in
 * production when the provider is misconfigured, same as getProvider().
 */
export function providerInfo(): { name: string; model: string | null } {
  const provider = getProvider();
  return {
    name: provider.name,
    model: provider.name === "anthropic" ? process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL : null,
  };
}

export function complete(opts: CompleteOptions): Promise<string> {
  return getProvider().complete(opts);
}
