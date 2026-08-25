import { describe, it, expect, vi } from "vitest";
import { runRequest } from "@/lib/ui/requestAction";

// The defect: the workspace helper cleared its busy flag on the line AFTER the
// await, so a rejected fetch threw past it. The control stayed disabled with a
// spinner running and no error shown, and the rejection surfaced as an
// unhandled promise. The only recovery was a page reload.

const jsonResponse = (status: number, body: unknown, statusText = "") =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  }) as unknown as Response;

const brokenBodyResponse = (status: number, statusText = "") =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    },
  }) as unknown as Response;

/** Records every setBusy transition so "always cleared" is observable. */
function busyRecorder() {
  const calls: (string | null)[] = [];
  return { setBusy: (t: string | null) => calls.push(t), calls, isBusy: () => calls[calls.length - 1] !== null };
}

describe("runRequest", () => {
  it("returns the parsed body and clears busy on success", async () => {
    const busy = busyRecorder();
    const out = await runRequest("/api/x", "POST", { a: 1 }, {
      fetchImpl: vi.fn(async () => jsonResponse(200, { ok: true })) as never,
      setBusy: busy.setBusy,
      tag: "gen",
    });
    expect(out.data).toEqual({ ok: true });
    expect(out.status).toBeNull();
    expect(busy.calls).toEqual(["gen", null]);
    expect(busy.isBusy()).toBe(false);
  });

  // THE regression.
  it("clears busy and reports an error when the fetch rejects", async () => {
    const busy = busyRecorder();
    const out = await runRequest("/api/x", "POST", undefined, {
      fetchImpl: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as never,
      setBusy: busy.setBusy,
      tag: "gen",
    });
    expect(out.data).toBeNull();
    expect(out.status?.kind).toBe("error");
    expect(out.status?.message).toContain("could not be reached");
    expect(out.status?.message).toContain("Failed to fetch");
    // The property that was broken: busy is cleared even though nothing came back.
    expect(busy.calls).toEqual(["gen", null]);
  });

  it("never throws, whatever the transport does", async () => {
    await expect(
      runRequest("/api/x", "POST", undefined, {
        fetchImpl: vi.fn(async () => { throw new Error("boom"); }) as never,
      }),
    ).resolves.toBeTruthy();
  });

  it("surfaces the server's own error message on a non-2xx", async () => {
    const out = await runRequest("/api/x", "POST", undefined, {
      fetchImpl: vi.fn(async () => jsonResponse(409, { error: "This plan is already being regenerated." })) as never,
    });
    expect(out.data).toBeNull();
    expect(out.status).toEqual({ kind: "error", message: "This plan is already being regenerated." });
  });

  it("falls back to the status line when an error body is malformed", async () => {
    const busy = busyRecorder();
    const out = await runRequest("/api/x", "POST", undefined, {
      fetchImpl: vi.fn(async () => brokenBodyResponse(500, "Internal Server Error")) as never,
      setBusy: busy.setBusy,
    });
    expect(out.status?.kind).toBe("error");
    expect(out.status?.message).toContain("500 Internal Server Error");
    // Not the parse error — that is not the user's problem.
    expect(out.status?.message).not.toContain("Unexpected token");
    expect(busy.isBusy()).toBe(false);
  });

  it("ignores a non-string or blank error field rather than rendering it", async () => {
    for (const body of [{ error: null }, { error: 42 }, { error: "   " }, {}]) {
      const out = await runRequest("/api/x", "POST", undefined, {
        fetchImpl: vi.fn(async () => jsonResponse(400, body, "Bad Request")) as never,
      });
      expect(out.status?.message).toContain("400 Bad Request");
    }
  });

  it("treats a 2xx with an unreadable body as success with an empty payload", async () => {
    const out = await runRequest("/api/x", "POST", undefined, {
      fetchImpl: vi.fn(async () => brokenBodyResponse(204)) as never,
    });
    expect(out.data).toEqual({});
    expect(out.status).toBeNull();
  });

  it("runs onSuccess only after a successful request", async () => {
    const onSuccess = vi.fn();
    await runRequest("/api/x", "POST", undefined, {
      fetchImpl: vi.fn(async () => jsonResponse(500, { error: "no" })) as never,
      onSuccess,
    });
    expect(onSuccess).not.toHaveBeenCalled();

    await runRequest("/api/x", "POST", undefined, {
      fetchImpl: vi.fn(async () => jsonResponse(200, {})) as never,
      onSuccess,
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("does not claim failure when the write landed but the refresh threw", async () => {
    const busy = busyRecorder();
    const out = await runRequest("/api/x", "POST", undefined, {
      fetchImpl: vi.fn(async () => jsonResponse(200, { id: "new" })) as never,
      onSuccess: () => { throw new Error("router unmounted"); },
      setBusy: busy.setBusy,
    });
    // The data is returned — the request DID succeed.
    expect(out.data).toEqual({ id: "new" });
    expect(out.status?.message).toContain("Saved, but the page could not be refreshed");
    expect(busy.isBusy()).toBe(false);
  });

  it("recovers for a retry: a failed call leaves nothing stuck", async () => {
    const busy = busyRecorder();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const first = await runRequest("/api/x", "POST", undefined, { fetchImpl: fetchImpl as never, setBusy: busy.setBusy, tag: "gen" });
    expect(first.status?.kind).toBe("error");
    expect(busy.isBusy()).toBe(false);

    const second = await runRequest("/api/x", "POST", undefined, { fetchImpl: fetchImpl as never, setBusy: busy.setBusy, tag: "gen" });
    expect(second.data).toEqual({ ok: true });
    expect(second.status).toBeNull();
    expect(busy.calls).toEqual(["gen", null, "gen", null]);
  });

  it("announces success only when the caller asked for a message", async () => {
    const out = await runRequest("/api/x", "POST", undefined, {
      fetchImpl: vi.fn(async () => jsonResponse(200, {})) as never,
      successMessage: "Saved.",
    });
    expect(out.status).toEqual({ kind: "ok", message: "Saved." });
  });

  it("sends a JSON content type only when there is a body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    await runRequest("/api/x", "GET", undefined, { fetchImpl: fetchImpl as never });
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toBeUndefined();

    await runRequest("/api/x", "POST", { a: 1 }, { fetchImpl: fetchImpl as never });
    expect((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toEqual({ "Content-Type": "application/json" });
  });
});

describe("a caller-supplied transform cannot break the never-throws contract", () => {
  it("reports a throwing transform instead of raising, and clears busy", async () => {
    const busy = busyRecorder();
    const out = await runRequest("/api/x", "POST", undefined, {
      fetchImpl: vi.fn(async () => jsonResponse(200, { unexpected: "shape" })) as never,
      transform: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'id')");
      },
      setBusy: busy.setBusy,
      tag: "gen",
    });
    expect(out.data).toBeNull();
    expect(out.status?.kind).toBe("error");
    expect(out.status?.message).toContain("could not be read");
    expect(busy.calls).toEqual(["gen", null]);
  });

  it("does not run onSuccess when the transform failed", async () => {
    const onSuccess = vi.fn();
    await runRequest("/api/x", "POST", undefined, {
      fetchImpl: vi.fn(async () => jsonResponse(200, {})) as never,
      transform: () => { throw new Error("bad shape"); },
      onSuccess,
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("applies a working transform exactly once", async () => {
    const transform = vi.fn((body: unknown) => (body as { n: number }).n * 2);
    const out = await runRequest<number>("/api/x", "POST", undefined, {
      fetchImpl: vi.fn(async () => jsonResponse(200, { n: 21 })) as never,
      transform,
      onSuccess: () => {},
    });
    expect(out.data).toBe(42);
    expect(transform).toHaveBeenCalledTimes(1);
  });
});
