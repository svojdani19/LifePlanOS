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

export function getProvider(): LlmProvider {
  switch (process.env.LLM_PROVIDER) {
    // TODO(providers): return an Anthropic- or OpenAI-backed provider that
    // implements LlmProvider. Kept behind this switch so callers never change.
    case "anthropic":
    case "openai":
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn(`LLM_PROVIDER=${process.env.LLM_PROVIDER} not wired yet; using mock.`);
      }
      return mockProvider;
    default:
      return mockProvider;
  }
}

export function complete(opts: CompleteOptions): Promise<string> {
  return getProvider().complete(opts);
}
