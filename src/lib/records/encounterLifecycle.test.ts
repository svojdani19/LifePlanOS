import { describe, expect, it } from "vitest";
import {
  ACTIVE_ENCOUNTER_STATES,
  ACTIVE_ENCOUNTER_WHERE,
  ENCOUNTER_STATES,
  INACTIVE_ENCOUNTER_STATES,
  activeEncounters,
  isActiveEncounter,
} from "@/lib/records/encounterLifecycle";

describe("which rows still describe the case", () => {
  it("keeps every state that carries current content or human work", () => {
    for (const status of ["AI_DRAFT", "AI_AUDIT_PASSED", "HUMAN_EDITED", "REVIEWED", "VERIFIED"]) {
      expect(isActiveEncounter({ status })).toBe(true);
    }
  });

  it("keeps a stale reviewed row so its review is not silently discarded", () => {
    // STALE means a reviewed row whose source changed. Dropping it would throw
    // away the human work along with the staleness.
    expect(isActiveEncounter({ status: "STALE" })).toBe(true);
  });

  it("drops a row replaced by re-extraction", () => {
    // buildRecords applied no status filter at all, so a superseded row reached
    // the Records list and the chronology while structuredRecord excluded it.
    expect(isActiveEncounter({ status: "SUPERSEDED" })).toBe(false);
  });

  it("drops a row a reviewer rejected", () => {
    expect(isActiveEncounter({ status: "REJECTED" })).toBe(false);
  });

  it("drops a row whose extraction failed", () => {
    // The deny-list in extractionRun excluded only SUPERSEDED, so this passed.
    expect(isActiveEncounter({ status: "EXTRACTION_FAILED" })).toBe(false);
  });

  it("drops a row carrying a successor whatever its status says", () => {
    // The two fields can disagree when the supersede lands before the status
    // write. A successor existing is the stronger evidence.
    expect(isActiveEncounter({ status: "REVIEWED", supersededById: "later-row" })).toBe(false);
  });

  it("treats an unclassified state as inactive", () => {
    // A state nobody has classified is not one to feed into a medico-legal
    // document on the assumption it is fine. Deny-lists are what produced the
    // divergence this replaces.
    expect(isActiveEncounter({ status: "SOME_FUTURE_STATE" })).toBe(false);
  });

  it("defaults a row with no status to a draft, which is active", () => {
    expect(isActiveEncounter({})).toBe(true);
  });
});

describe("the definition itself", () => {
  it("classifies every declared state exactly once", () => {
    // Adding a state must force a decision here rather than defaulting into
    // whichever list happens to be a deny-list.
    for (const state of ENCOUNTER_STATES) {
      const active = (ACTIVE_ENCOUNTER_STATES as readonly string[]).includes(state);
      const inactive = (INACTIVE_ENCOUNTER_STATES as readonly string[]).includes(state);
      expect(active !== inactive, `${state} must be exactly one of active/inactive`).toBe(true);
    }
  });

  it("offers a query fragment that excludes history and successors", () => {
    expect(ACTIVE_ENCOUNTER_WHERE.supersededById).toBeNull();
    expect(ACTIVE_ENCOUNTER_WHERE.status.in).toEqual([...ACTIVE_ENCOUNTER_STATES]);
    for (const state of INACTIVE_ENCOUNTER_STATES) {
      expect(ACTIVE_ENCOUNTER_WHERE.status.in).not.toContain(state);
    }
  });

  it("filters a mixed set down to the rows that count", () => {
    const rows = [
      { id: "draft", status: "AI_DRAFT" },
      { id: "reviewed", status: "REVIEWED" },
      { id: "rejected", status: "REJECTED" },
      { id: "superseded", status: "SUPERSEDED" },
      { id: "replaced", status: "VERIFIED", supersededById: "reviewed" },
      { id: "failed", status: "EXTRACTION_FAILED" },
    ];
    expect(activeEncounters(rows).map((r) => r.id)).toEqual(["draft", "reviewed"]);
  });
});
