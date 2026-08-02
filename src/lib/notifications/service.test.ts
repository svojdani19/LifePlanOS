import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// All DB access is mocked — these tests never touch a database.
vi.mock("@/lib/db", () => ({
  prisma: {
    notification: { create: vi.fn(), createMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { notify, notifyRole } from "./service";

const notifCreate = prisma.notification.create as unknown as Mock;
const notifCreateMany = prisma.notification.createMany as unknown as Mock;
const userFindMany = prisma.user.findMany as unknown as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  notifCreate.mockResolvedValue({});
  notifCreateMany.mockResolvedValue({ count: 0 });
  userFindMany.mockResolvedValue([]);
});

describe("notify", () => {
  it("creates a notification with the given fields", async () => {
    const ok = await notify({ firmId: "f1", userId: "u1", kind: "engagement.authorized", title: "Engagement authorized: LCP — case LCP-1", caseId: "c1" });
    expect(ok).toBe(true);
    expect(notifCreate).toHaveBeenCalledWith({
      data: {
        firmId: "f1",
        userId: "u1",
        kind: "engagement.authorized",
        title: "Engagement authorized: LCP — case LCP-1",
        body: null,
        caseId: "c1",
      },
    });
  });

  it("swallows every error — notifications never break a flow", async () => {
    notifCreate.mockRejectedValue(new Error("connection refused"));
    await expect(
      notify({ firmId: "f1", userId: "u1", kind: "x", title: "t" }),
    ).resolves.toBe(false);
  });
});

describe("notifyRole", () => {
  it("fans out to every ACTIVE holder of the legacy role", async () => {
    userFindMany.mockResolvedValue([{ id: "u1" }, { id: "u2" }, { id: "u3" }]);
    const count = await notifyRole({ firmId: "f1", role: "ADMIN", kind: "engagement.requested", title: "Engagement requested — case LCP-1" });
    expect(count).toBe(3);
    expect(userFindMany).toHaveBeenCalledWith({
      where: { firmId: "f1", role: "ADMIN", status: "ACTIVE" },
      select: { id: true },
    });
    const rows = notifCreateMany.mock.calls[0][0].data as { userId: string }[];
    expect(rows.map((r) => r.userId)).toEqual(["u1", "u2", "u3"]);
  });

  it("returns 0 when no one holds the role, and 0 (swallowed) on failure", async () => {
    expect(await notifyRole({ firmId: "f1", role: "BILLING_USER", kind: "k", title: "t" })).toBe(0);
    expect(notifCreateMany).not.toHaveBeenCalled();

    userFindMany.mockRejectedValue(new Error("db down"));
    expect(await notifyRole({ firmId: "f1", role: "ADMIN", kind: "k", title: "t" })).toBe(0);
  });
});
