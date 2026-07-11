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

// Anthropic Messages API provider (HIPAA-eligible under a BAA). No SDK — just
// fetch — so it adds no dependency. Set LLM_PROVIDER=anthropic and
// ANTHROPIC_API_KEY (optionally ANTHROPIC_MODEL) to activate.
function anthropicProvider(): LlmProvider {
  return {
    name: "anthropic",
    async complete({ system, messages, maxTokens, temperature }) {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY is not set.");
      const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
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

export function getProvider(): LlmProvider {
  switch (process.env.LLM_PROVIDER) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY ? anthropicProvider() : mockProvider;
    case "openai":
      // OpenAI is not HIPAA-eligible by default; wire similarly behind a BAA if needed.
      if (process.env.NODE_ENV !== "production") console.warn("LLM_PROVIDER=openai not wired; using mock.");
      return mockProvider;
    default:
      return mockProvider;
  }
}

export function complete(opts: CompleteOptions): Promise<string> {
  return getProvider().complete(opts);
}
