// Page-count plausibility. A "Page N of M" stamp is trusted only when M is
// believable: on billing forms the stamp sits beside account and invoice
// numbers, and a line-wrapped "Page 1 of" followed by an account number would
// otherwise register a record set of millions of pages (observed on real
// ledgers: 122,183,606 pages).
import { describe, it, expect } from "vitest";
import { MAX_PLAUSIBLE_PAGES } from "./ingest";

/** Mirrors the guard in ingest.ts. */
function stampedPageCount(text: string, computed: number): number {
  const pm = text.match(/page\s+\d+\s+of\s+(\d+)/i);
  if (!pm) return computed;
  const stamped = Number.parseInt(pm[1], 10);
  if (Number.isFinite(stamped) && stamped > 0 && stamped <= MAX_PLAUSIBLE_PAGES && stamped <= computed * 50) {
    return Math.max(computed, stamped);
  }
  return computed;
}

describe("page-count stamp plausibility", () => {
  it("trusts a real consolidated-chart stamp", () => {
    expect(stampedPageCount("CONSOLIDATED RECORDS\nPage 1 of 48\n", 40)).toBe(48);
  });

  it("ignores an account number captured by a line-wrapped stamp", () => {
    const ledger = "BILL LEDGER\nStatement\nPage 1 of\n122183606\nBalance due";
    expect(stampedPageCount(ledger, 2)).toBe(2);
  });

  it("ignores any stamp beyond the plausible bound", () => {
    expect(stampedPageCount("Page 1 of 999999", 10)).toBe(10);
  });

  it("ignores a stamp wildly disproportionate to the extracted text", () => {
    expect(stampedPageCount("Page 1 of 4000", 2)).toBe(2);
  });

  it("never lowers a computed count", () => {
    expect(stampedPageCount("Page 1 of 3", 40)).toBe(40);
  });
});
