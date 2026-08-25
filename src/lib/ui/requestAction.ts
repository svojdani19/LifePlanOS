// ─────────────────────────────────────────────────────────────────────────────
// One request, one busy flag, one visible outcome — on every path.
//
// The workspace helper was:
//
//     async function call(url, method, body, tag = "op") {
//       setBusy(tag);
//       const res = await fetch(url, {...});
//       setBusy(null);
//       if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error ?? "Request failed"); return null; }
//       router.refresh();
//       return res.json().catch(() => ({}));
//     }
//
// Three defects, all on the unhappy paths:
//
//   • A REJECTED fetch — dropped wifi, a navigation, a CORS failure — throws
//     past `setBusy(null)`. The button stays disabled and the spinner spins
//     forever, with no error anywhere, and the rejection surfaces as an
//     unhandled promise. The only recovery is a page reload.
//
//   • `router.refresh()` can throw, and `res.json()` on the SUCCESS path is
//     guarded while the same call on the error path is not... in a helper whose
//     whole job is to be the safe wrapper.
//
//   • `alert()` is a modal the screen reader announces out of context and the
//     keyboard user must dismiss before doing anything else. It is also
//     unstyled, untestable, and blocked outright in embedded browsers — which
//     is precisely where this app runs during review.
//
// So: a finally block that always clears busy, and a status object the caller
// renders in an aria-live region instead of an OS modal.
// ─────────────────────────────────────────────────────────────────────────────

export type ActionStatus =
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

export interface RequestOutcome<T = unknown> {
  /** Parsed body on success; null on every failure. */
  data: T | null;
  /** null when the request succeeded and needs no announcement. */
  status: ActionStatus | null;
}

/** What a failure says when the server offered nothing better. */
const FALLBACK = "The request could not be completed. Nothing was changed.";

/**
 * Read the server's own message without letting a malformed body become the
 * error the user sees.
 *
 * A non-2xx response with an HTML error page, an empty body, or truncated JSON
 * all parse-fail here; the status line is more useful to a user than
 * "Unexpected token < in JSON at position 0".
 */
async function errorMessageFrom(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error.trim()) return body.error;
  } catch {
    // Deliberately swallowed: the parse failure is not the user's problem, and
    // the status below describes the real one.
  }
  return `${FALLBACK} (${res.status}${res.statusText ? ` ${res.statusText}` : ""})`;
}

export interface RunRequestOptions<T> {
  /** Injected for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Called with the tag on entry and null on exit — always, on every path. */
  setBusy?: (tag: string | null) => void;
  /** Tag identifying which control is busy. */
  tag?: string;
  /** Ran after a successful request. A throw here is reported, not swallowed. */
  onSuccess?: () => void | Promise<void>;
  /** Announced on success. Omit for the common silent-success case. */
  successMessage?: string;
  transform?: (body: unknown) => T;
}

/**
 * Perform one request and report it.
 *
 * Never throws. Every outcome — network rejection, non-2xx, malformed body, a
 * failing refresh — comes back as a `status` the caller can render, and the
 * busy flag is always cleared.
 */
export async function runRequest<T = unknown>(
  url: string,
  method: string,
  body?: unknown,
  options: RunRequestOptions<T> = {},
): Promise<RequestOutcome<T>> {
  const doFetch = options.fetchImpl ?? fetch;
  const tag = options.tag ?? "op";
  options.setBusy?.(tag);
  try {
    // A FormData body carries its own multipart boundary, so it must be passed
    // through untouched and WITHOUT a Content-Type header — setting one strips
    // the boundary and the server sees an unparseable body.
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: body && !isForm ? { "Content-Type": "application/json" } : undefined,
        body: isForm ? (body as FormData) : body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // The request never reached a response. This is the path that used to
      // strand the busy flag and surface as an unhandled rejection.
      const detail = err instanceof Error ? err.message : String(err);
      return { data: null, status: { kind: "error", message: `${FALLBACK} The server could not be reached (${detail}).` } };
    }

    if (!res.ok) {
      return { data: null, status: { kind: "error", message: await errorMessageFrom(res) } };
    }

    // A 2xx with an unreadable body is a success whose payload is unusable.
    // Reported as an empty object rather than a thrown parse error, matching
    // the previous helper's success-path behaviour.
    let parsed: unknown = {};
    try {
      parsed = await res.json();
    } catch {
      parsed = {};
    }

    // `transform` is caller-supplied and reads a body the caller has not seen,
    // so it can throw on a shape it did not expect. The documented contract is
    // that this function never throws, and an uncaught transform would have
    // broken it — past the busy flag, past the status, straight to an
    // unhandled rejection.
    let data: T;
    try {
      data = options.transform ? options.transform(parsed) : (parsed as T);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { data: null, status: { kind: "error", message: `The server's reply could not be read (${detail}). Reload to see the current state.` } };
    }

    try {
      await options.onSuccess?.();
    } catch (err) {
      // The write landed. Telling the user it failed would be false; telling
      // them nothing would leave a stale screen. So: succeeded, but say why it
      // still looks old.
      const detail = err instanceof Error ? err.message : String(err);
      return {
        data,
        status: { kind: "error", message: `Saved, but the page could not be refreshed (${detail}). Reload to see the current state.` },
      };
    }

    return {
      data,
      status: options.successMessage ? { kind: "ok", message: options.successMessage } : null,
    };
  } finally {
    // The whole point. Every return above, and any throw this function did not
    // anticipate, clears the flag.
    options.setBusy?.(null);
  }
}
