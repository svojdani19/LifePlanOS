// ─────────────────────────────────────────────────────────────────────────────
// Is the safeguard WIRED to anything?
//
// The claims registry already asks whether a label tells the truth about the
// code beneath it. It does not ask whether that code runs. `reviewWithCopies`
// was correct, passed its refutation, and was called from nowhere — so the
// card promised that one review covered every copy while the wired path
// submitted one document's rows. The registry went on passing.
//
// This walks each claim's reachability contract:
//
//   1. the surface makes the claim;
//   2. a rendered action invokes the implementing path;
//   3. the request carries the protected data;
//   4. the server enforces the invariant itself;
//   5. persistence and the final gate reflect the result;
//   + no exported implementation is referenced only by its own tests, and no
//     retired unreachable path is left lying around.
//
// Deliberately source-level. Reachability is a property of the wiring, not of
// any one function's behaviour, and no amount of behavioural testing of a
// function nothing calls will notice that nothing calls it.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SAFEGUARD_CLAIMS } from "@/lib/safeguards/claims";

const read = (file: string) => readFileSync(file, "utf8");

/** Every non-test source file under src/ and scripts/. */
const sourceFiles = (() => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      if (/\.test\.tsx?$/.test(name)) continue;
      out.push(path);
    }
  };
  walk("src");
  walk("scripts");
  return out;
})();

/**
 * Is this exported symbol referenced from non-test code other than the file
 * that defines it? A symbol only its own tests use is not wired to anything.
 */
function referencedOutside(symbol: string, definedIn: string): string[] {
  const pattern = new RegExp(`\\b${symbol}\\b`);
  return sourceFiles.filter((f) => f !== definedIn && pattern.test(read(f)));
}

/** The body of a named function, as far as the next top-level declaration. */
function bodyOf(source: string, entryPoint: string): string {
  const at = source.indexOf(entryPoint);
  if (at < 0) return "";
  return source.slice(at, at + 2000);
}

const withContract = SAFEGUARD_CLAIMS.filter((c) => c.reachability);

describe("the registry covers the safeguards that must be wired", () => {
  it("registers a reachability contract for every guarantee a reviewer acts on", () => {
    const required = [
      "canonical-note-review",
      "group-review", // cross-document copies
      "finding-disposition",
      "note-wide-correction",
      "finding-lifecycle", // no machine may close a human's CONFIRMED
      "export-gate-visible-findings",
    ];
    const registered = new Set(withContract.map((c) => c.id));
    for (const id of required) expect(registered.has(id), `${id} has a reachability contract`).toBe(true);
  });
});

describe.each(withContract.map((c) => [c.id, c] as const))("%s is reachable end to end", (id, claim) => {
  const r = claim.reachability!;

  if (r.surface) {
    it("1. the surface makes the claim in its own words", () => {
      const source = read(r.surface!.file);
      for (const text of r.surface!.claimText) {
        expect(source.includes(text), `${id}: "${text}" appears in ${r.surface!.file}`).toBe(true);
      }
    });
  }

  if (r.rendered) {
    it("2. a rendered action invokes the implementing path", () => {
      const source = read(r.surface?.file ?? r.server.file);
      expect(source.includes(r.rendered!.entryPoint), `${id}: ${r.rendered!.entryPoint} exists`).toBe(true);
      for (const call of r.rendered!.invokedBy) {
        // This is the check that would have caught reviewWithCopies: the
        // function existing is not the same as a control calling it.
        expect(source.includes(call), `${id}: a rendered action calls ${call}`).toBe(true);
      }
    });
  }

  if (r.carries) {
    it("3. the request carries the protected data the claim depends on", () => {
      const source = read(r.surface?.file ?? r.server.file);
      const body = r.rendered ? bodyOf(source, r.rendered.entryPoint) : source;
      expect(body.length, `${id}: ${r.rendered?.entryPoint ?? "surface"} has a body to inspect`).toBeGreaterThan(0);
      for (const token of r.carries!) {
        expect(body.includes(token), `${id}: the request carries ${token}`).toBe(true);
      }
    });
  }

  it("4. the server enforces the invariant itself", () => {
    const source = read(r.server.file);
    for (const token of r.server.enforces) {
      expect(source.includes(token), `${id}: ${r.server.file} enforces ${token}`).toBe(true);
    }
  });

  if (r.persists) {
    it("5. the result is persisted and reaches the final gate", () => {
      const source = read(r.persists!.file);
      for (const token of r.persists!.contains) {
        expect(source.includes(token), `${id}: ${r.persists!.file} contains ${token}`).toBe(true);
      }
    });
  }

  if (r.reachableSymbols) {
    it("no part of this safeguard is implemented in code nothing calls", () => {
      for (const { file, symbols } of r.reachableSymbols!) {
        for (const symbol of symbols) {
          const callers = referencedOutside(symbol, file);
          expect(callers.length, `${id}: ${symbol} is referenced from non-test code (found ${callers.length})`).toBeGreaterThan(0);
        }
      }
    });
  }

  if (r.forbidden) {
    it("leaves no retired unreachable path behind", () => {
      for (const { file, text } of r.forbidden!) {
        const source = read(file);
        for (const t of text) expect(source.includes(t), `${id}: ${file} no longer contains ${t}`).toBe(false);
      }
    });
  }
});

describe("the reachability check can actually fail", () => {
  // A guard that cannot fail is the thing this file exists to prevent, so its
  // own detector is exercised against a symbol nothing uses.
  it("reports a symbol that exists but is called from nowhere", () => {
    expect(referencedOutside("aSymbolNothingDefinesOrUses", "src/lib/safeguards/claims.ts")).toEqual([]);
  });

  it("finds a symbol that IS called from elsewhere", () => {
    // A positive control from production code, so the detector is shown to
    // distinguish wired from unwired rather than always reporting nothing.
    // (SAFEGUARD_CLAIMS itself would fail this: the registry is read only by
    // its own tests, which is what a registry is for.)
    expect(referencedOutside("canonicalNoteId", "src/lib/records/reviewBurden.ts").length).toBeGreaterThan(0);
  });
});
