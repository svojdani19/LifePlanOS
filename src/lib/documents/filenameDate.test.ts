// A filename date is a SUGGESTION for human confirmation, never a documented
// fact. These tests pin what may be suggested and — more importantly — what
// must not be.
import { describe, it, expect } from "vitest";
import { dateFromFilename } from "./filenameDate";

describe("dateFromFilename", () => {
  it("reads the common US record-naming formats", () => {
    expect(dateFromFilename("Jeffrey, Daniels Lum MRI Report 06.02.25.pdf")).toBe("2025-06-02");
    expect(dateFromFilename("MB-MR-CMI - DOS 4.4.25.pdf")).toBe("2025-04-04");
    expect(dateFromFilename("Records 2025-06-02.pdf")).toBe("2025-06-02");
    expect(dateFromFilename("Operative Report June 2, 2025.pdf")).toBe("2025-06-02");
  });

  it("suggests NOTHING for a date range — which encounter it belongs to is unknowable", () => {
    expect(dateFromFilename("Medical Bill from Spine (2.27.25-4.3.25).pdf")).toBeNull();
  });

  it("suggests nothing when there is no date, or an implausible one", () => {
    expect(dateFromFilename("Health Insurance Card.pdf")).toBeNull();
    expect(dateFromFilename("claim 09-70-0501.pdf")).toBeNull();
    expect(dateFromFilename("report 13.45.25.pdf")).toBeNull();
    expect(dateFromFilename("scan 2.30.25.pdf")).toBeNull(); // Feb 30
    expect(dateFromFilename(null)).toBeNull();
  });

  it("never suggests a future date", () => {
    expect(dateFromFilename("note 01.01.99.pdf")).toBe("1999-01-01");
    expect(dateFromFilename("note 12.31.2099.pdf")).toBeNull();
  });
});
