// Placing a statement in time is what separates care still owed from care
// already delivered, refused, withdrawn, or merely contemplated. Each case
// below is a way a real record misleads a projection engine that reads only
// wording. Synthetic text only.
import { describe, it, expect } from "vitest";
import { resolveTemporal, resolveTimeline, subjectKey, supporting } from "./temporalResolution";

const DOI = new Date("2025-06-01T00:00:00Z");
const rec = (text: string, date: string | null = "2026-02-01") => resolveTemporal({ text, date, dateOfInjury: DOI, kind: "RECOMMENDATION" });
const obs = (text: string, date: string | null = "2026-02-01") => resolveTemporal({ text, date, dateOfInjury: DOI, kind: "OBSERVATION" });

describe("only PLANNED and CURRENT support a projection", () => {
  it("a recommendation still owed is PLANNED", () => {
    const r = rec("Recommend L4-L5 lumbar fusion.");
    expect(r.status).toBe("PLANNED");
    expect(r.supportsFutureCare).toBe(true);
  });

  it("a completed operation is not evidence of a future one", () => {
    for (const text of [
      "Status post L4-L5 lumbar fusion.",
      "Patient underwent anterior cervical discectomy and fusion.",
      "S/P right knee arthroscopy.",
      "Has completed a course of physical therapy.",
    ]) {
      const r = rec(text);
      expect(r.status, text).toBe("COMPLETED");
      expect(r.supportsFutureCare, text).toBe(false);
    }
  });

  it("a contingency is not a plan", () => {
    for (const text of [
      "If symptoms persist, would consider lumbar epidural steroid injection.",
      "Lumbar fusion may be considered in the future.",
      "Surgery is a possible option.",
      "Should conservative care fail, recommend surgical consultation.",
    ]) {
      expect(rec(text).status, text).toBe("CONDITIONAL");
    }
  });

  it("care the patient refused, and care the treating side withdrew, are distinguished", () => {
    expect(rec("Patient declined the recommended lumbar fusion.").status).toBe("DECLINED");
    expect(rec("Surgery was cancelled; patient is no longer a surgical candidate.").status).toBe("CANCELLED");
  });

  it("care documented before the injury is not this plan's care", () => {
    const r = rec("Recommend lumbar fusion.", "2019-04-02");
    expect(r.status).toBe("PRE_INJURY");
    expect(r.reason).toMatch(/before the date of injury/);
  });

  it("merely mentioning care is not recommending it", () => {
    expect(rec("Patient asked about surgery during the visit.").status).toBe("AMBIGUOUS");
  });
});

describe("an undated statement can never satisfy a gate", () => {
  it("even an emphatic recommendation is AMBIGUOUS without a date", () => {
    const r = rec("Recommend L4-L5 lumbar fusion.", null);
    expect(r.status).toBe("AMBIGUOUS");
    expect(r.supportsFutureCare).toBe(false);
    expect(r.reason).toMatch(/no reliable date/);
  });

  it("an undated functional deficit cannot ground catastrophic care", () => {
    expect(obs("Patient is wheelchair dependent.", null).supportsFutureCare).toBe(false);
  });

  it("but disqualifying language still resolves without a date — a refusal is a refusal", () => {
    expect(rec("Patient declined surgery.", null).status).toBe("DECLINED");
    expect(rec("Surgery was cancelled.", null).status).toBe("CANCELLED");
  });
});

describe("observations describe the patient as of their date", () => {
  it("a documented deficit needs no verb of intent to be current", () => {
    const o = obs("Dependent for ADLs and transfers.");
    expect(o.status).toBe("CURRENT");
    expect(o.supportsFutureCare).toBe(true);
  });

  it("a deficit the record says has resolved is CONTRADICTED", () => {
    for (const text of [
      "Patient no longer requires a wheelchair.",
      "Ambulates independently without assistive device.",
      "Gabapentin discontinued.",
    ]) {
      expect(obs(text).status, text).toBe("CONTRADICTED");
    }
  });
});

describe("subject identity", () => {
  it("care class plus anatomy identifies what a statement is about", () => {
    expect(subjectKey("Recommend L4-L5 lumbar fusion.")).toBe("surgery|lumbar");
    expect(subjectKey("Recommend cervical fusion.")).toBe("surgery|cervical");
    expect(subjectKey("Recommend lumbar epidural steroid injection.")).toBe("injection|lumbar");
  });

  it("an unidentifiable statement has no subject, so it never overrides a specific one", () => {
    expect(subjectKey("Patient doing well overall.")).toBeNull();
  });
});

describe("later records govern", () => {
  const item = (text: string, date: string | null) => ({ text, date });

  it("a recommendation a later note withdrew stops supporting anything", () => {
    const resolved = resolveTimeline(
      [item("Recommend L4-L5 lumbar fusion.", "2025-09-01"), item("Patient is no longer a surgical candidate for lumbar fusion.", "2026-01-15")],
      { dateOfInjury: DOI, kind: "RECOMMENDATION" },
    );
    expect(resolved[0].temporal.status).toBe("CONTRADICTED");
    expect(resolved[0].temporal.reason).toMatch(/2026-01-15/);
    expect(supporting(resolved)).toEqual([]);
  });

  it("a recommendation the patient has since had is SUPERSEDED, not projected again", () => {
    const resolved = resolveTimeline(
      [item("Recommend L4-L5 lumbar fusion.", "2025-09-01"), item("Status post L4-L5 lumbar fusion.", "2026-01-15")],
      { dateOfInjury: DOI, kind: "RECOMMENDATION" },
    );
    expect(resolved[0].temporal.status).toBe("SUPERSEDED");
    expect(resolved[0].temporal.reason).toMatch(/no longer owed/);
  });

  it("the same recommendation repeated across notes counts ONCE, at its most recent statement", () => {
    const resolved = resolveTimeline(
      [
        item("Recommend lumbar epidural steroid injection.", "2025-09-01"),
        item("Again recommend lumbar epidural steroid injection.", "2025-11-01"),
        item("Continue to recommend lumbar epidural steroid injection.", "2026-01-15"),
      ],
      { dateOfInjury: DOI, kind: "RECOMMENDATION" },
    );
    const live = supporting(resolved);
    expect(live).toHaveLength(1);
    expect(live[0].date).toBe("2026-01-15"); // the current statement is the cited one
  });

  it("an EARLIER contrary note never overrides a later recommendation", () => {
    const resolved = resolveTimeline(
      [item("Patient declined lumbar fusion.", "2025-07-01"), item("Recommend L4-L5 lumbar fusion.", "2026-01-15")],
      { dateOfInjury: DOI, kind: "RECOMMENDATION" },
    );
    expect(resolved[1].temporal.status).toBe("PLANNED");
    expect(supporting(resolved)).toHaveLength(1);
  });

  it("a later statement about DIFFERENT anatomy leaves the recommendation standing", () => {
    const resolved = resolveTimeline(
      [item("Recommend lumbar fusion.", "2025-09-01"), item("Patient declined cervical fusion.", "2026-01-15")],
      { dateOfInjury: DOI, kind: "RECOMMENDATION" },
    );
    expect(resolved[0].temporal.status).toBe("PLANNED");
  });

  it("a deficit a later note records as resolved stops supporting catastrophic care", () => {
    const resolved = resolveTimeline(
      [item("Wheelchair dependent for all mobility.", "2025-08-01"), item("No longer requires a wheelchair; ambulates independently.", "2026-03-01")],
      { dateOfInjury: DOI, kind: "OBSERVATION" },
    );
    expect(resolved[0].temporal.status).toBe("CONTRADICTED");
    expect(supporting(resolved)).toHaveLength(0);
  });

  it("undated statements neither support nor override — they cannot be ordered in time", () => {
    const resolved = resolveTimeline(
      [item("Recommend lumbar fusion.", "2026-01-15"), item("Patient declined lumbar fusion.", null)],
      { dateOfInjury: DOI, kind: "RECOMMENDATION" },
    );
    expect(resolved[0].temporal.status).toBe("PLANNED"); // an undateable refusal cannot be placed after it
    expect(resolved[1].temporal.supportsFutureCare).toBe(false);
  });
});
