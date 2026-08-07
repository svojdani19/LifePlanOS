// A transient database failure must cost an operation a retry, not a document
// its run — and a retried CREATE must never write the row twice. Both matter:
// a real sweep lost nine documents to a connection pool refusing connections,
// every one of them at its first query, before any work had begun.
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ connects: 0 }));
vi.mock("@/lib/db", () => ({
  prisma: {
    $connect: async () => {
      db.connects++;
    },
  },
}));

import { withDbRetry, createWithDbRetry, isTransientDbError } from "./dbRetry";

const prismaError = (code: string) => Object.assign(new Error(`Invalid \`prisma.x.findMany()\` invocation`), { code });
const NO_WAIT = { backoffs: [0, 0, 0] };

beforeEach(() => {
  db.connects = 0;
});

describe("which failures are worth retrying", () => {
  it("connection and pool failures are transient", () => {
    for (const code of ["P1001", "P1002", "P1008", "P1017", "P2024"]) {
      expect(isTransientDbError(prismaError(code)), code).toBe(true);
    }
    for (const msg of [
      "Can't reach database server at ep-x.neon.tech:5432",
      "Timed out fetching a new connection from the connection pool",
      "Server has closed the connection",
      "read ECONNRESET",
      "socket hang up",
    ]) {
      expect(isTransientDbError(new Error(msg)), msg).toBe(true);
    }
  });

  it("the query's own faults are NOT retried", () => {
    // A unique-constraint violation, a bad column, a missing row: none of these
    // succeed on a second attempt, and retrying only delays a clear failure.
    expect(isTransientDbError(prismaError("P2002"))).toBe(false);
    expect(isTransientDbError(prismaError("P2025"))).toBe(false);
    expect(isTransientDbError(new Error("Unknown argument `nope`"))).toBe(false);
    // Bad credentials are deliberately excluded — they never self-heal.
    expect(isTransientDbError(prismaError("P1000"))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError("a string")).toBe(false);
  });
});

describe("retrying a read", () => {
  it("recovers when the connection comes back", async () => {
    let calls = 0;
    const out = await withDbRetry(async () => {
      calls++;
      if (calls < 3) throw prismaError("P1001");
      return "rows";
    }, NO_WAIT);
    expect(out).toBe("rows");
    expect(calls).toBe(3);
    // The pool handle is what failed, so each retry forces a fresh connection.
    expect(db.connects).toBe(2);
  });

  it("gives up after the schedule is exhausted and rethrows the real error", async () => {
    let calls = 0;
    await expect(
      withDbRetry(async () => {
        calls++;
        throw prismaError("P1017");
      }, NO_WAIT),
    ).rejects.toMatchObject({ code: "P1017" });
    expect(calls).toBe(4); // one attempt + three retries
  });

  it("a non-transient error fails immediately, without burning retries", async () => {
    let calls = 0;
    await expect(
      withDbRetry(async () => {
        calls++;
        throw prismaError("P2002");
      }, NO_WAIT),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(calls).toBe(1);
    expect(db.connects).toBe(0);
  });

  it("succeeds without retrying when nothing goes wrong", async () => {
    let calls = 0;
    expect(await withDbRetry(async () => { calls++; return 42; }, NO_WAIT)).toBe(42);
    expect(calls).toBe(1);
  });
});

describe("retrying a create cannot duplicate a row", () => {
  it("a write that landed before the connection dropped is FOUND, not repeated", async () => {
    // The dangerous case: the insert committed, the acknowledgement was lost.
    // A blind retry would write a second encounter.
    let inserts = 0;
    const table: string[] = [];
    const create = async () => {
      inserts++;
      table.push("row");
      throw prismaError("P1017"); // committed, then the connection died
    };
    const existing = async () => (table.length ? "row" : null);

    const out = await createWithDbRetry(create, existing);
    expect(out).toBe("row");
    expect(inserts).toBe(1); // never attempted twice
    expect(table).toHaveLength(1); // and never written twice
  });

  it("a write that did NOT land is retried normally", async () => {
    let inserts = 0;
    const table: string[] = [];
    const create = async () => {
      inserts++;
      if (inserts < 2) throw prismaError("P1001"); // failed before committing
      table.push("row");
      return "row";
    };
    const existing = async () => (table.length ? "row" : null);
    expect(await withDbRetry(create, { ...NO_WAIT, existing })).toBe("row");
    expect(inserts).toBe(2);
    expect(table).toHaveLength(1);
  });

  it("a create with NO probe is not retried at all — a duplicate is worse than an error", async () => {
    let inserts = 0;
    await expect(
      withDbRetry(async () => {
        inserts++;
        throw prismaError("P1017");
      }, { backoffs: [] }),
    ).rejects.toMatchObject({ code: "P1017" });
    expect(inserts).toBe(1);
  });

  it("a failing probe does not mask the underlying error", async () => {
    let inserts = 0;
    await expect(
      withDbRetry(
        async () => {
          inserts++;
          throw prismaError("P1001");
        },
        { ...NO_WAIT, existing: async () => { throw new Error("probe is down too"); } },
      ),
    ).rejects.toMatchObject({ code: "P1001" });
    expect(inserts).toBe(4); // probe failure is treated as "did not land"
  });
});
