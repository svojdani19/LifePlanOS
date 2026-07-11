// Shared HTTP helper for literature source adapters: a per-source request
// throttle (keeps each API under its rate limit) plus retry/backoff on 429/5xx
// so a sustained enrichment run doesn't silently turn a rate limit into "no
// article". Best-effort: returns null on any hard failure.

export function makeThrottle(minGapMs: number) {
  let last = 0;
  return async function throttle() {
    const wait = minGapMs - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  };
}

export async function fetchJson<T = unknown>(
  url: string,
  opts: { throttle?: () => Promise<void>; timeoutMs?: number; retries?: number; headers?: Record<string, string> } = {},
): Promise<T | null> {
  const { throttle, timeoutMs = 9000, retries = 2, headers } = opts;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (throttle) await throttle();
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
    if (r?.ok) {
      try {
        return (await r.json()) as T;
      } catch {
        return null;
      }
    }
    if (r && r.status !== 429 && r.status < 500) return null; // real error — don't retry
    await new Promise((res) => setTimeout(res, 700 * (attempt + 1)));
  }
  return null;
}
