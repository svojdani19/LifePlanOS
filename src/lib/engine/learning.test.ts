import { describe, it, expect } from "vitest";
import {
  serviceKeyOf,
  extractObservations,
  buildLearningProfile,
  insightFor,
  MIN_SAMPLES,
  type LearningItemInput,
} from "./learning";

const v = (over: Partial<LearningItemInput>): LearningItemInput => ({
  lineageId: "L1",
  version: 1,
  service: "Pain management office visits",
  category: "PAIN_MANAGEMENT",
  frequencyPerYear: 12,
  durationYears: null,
  isLifetime: true,
  physicianStatus: "PENDING",
  physicianNote: null,
  supersededAt: null,
  ...over,
});

/** A reviewed lineage: proposed at 12×/yr, physician-modified to 6×/yr. */
const modifiedLineage = (id: string): LearningItemInput[] => [
  v({ lineageId: id, version: 1, physicianStatus: "PENDING", supersededAt: new Date() }),
  v({ lineageId: id, version: 2, frequencyPerYear: 6, physicianStatus: "MODIFIED", physicianNote: "Monthly cadence unsupported; flares documented quarterly." }),
];

describe("serviceKeyOf", () => {
  it("normalizes case, whitespace, and plural drift; category disambiguates", () => {
    expect(serviceKeyOf("Pain management office visits", "PAIN_MANAGEMENT")).toBe(serviceKeyOf("pain  management office visit", "PAIN_MANAGEMENT"));
    expect(serviceKeyOf("Office visits", "PAIN_MANAGEMENT")).not.toBe(serviceKeyOf("Office visits", "PRIMARY_CARE"));
  });
});

describe("extractObservations", () => {
  it("one observation per lineage: first version = proposed, latest = physician-final", () => {
    const obs = extractObservations(modifiedLineage("L1"));
    const entry = [...obs.values()][0];
    expect(entry.obs).toHaveLength(1);
    expect(entry.obs[0]).toMatchObject({ outcome: "MODIFIED", proposedFrequency: 12, finalFrequency: 6 });
  });

  it("lineages never acted on carry no signal", () => {
    expect(extractObservations([v({ lineageId: "Lp", physicianStatus: "PENDING" })]).size).toBe(0);
  });
});

describe("buildLearningProfile", () => {
  const items = [
    ...modifiedLineage("L1"),
    ...modifiedLineage("L2"),
    ...modifiedLineage("L3"),
    v({ lineageId: "L4", physicianStatus: "APPROVED" }), // approved as proposed
    v({ lineageId: "R1", service: "Spinal cord stimulator trial", category: "INJECTION", physicianStatus: "REJECTED", physicianNote: "Not a candidate per psych eval." }),
    v({ lineageId: "R2", service: "Spinal cord stimulator trial", category: "INJECTION", physicianStatus: "REJECTED" }),
    v({ lineageId: "R3", service: "Spinal cord stimulator trial", category: "INJECTION", physicianStatus: "APPROVED" }),
  ];

  it("aggregates per service with medians over physician-final values and direction consistency", () => {
    const p = buildLearningProfile(items);
    const pain = p.services.find((s) => s.service.includes("Pain management"))!;
    expect(pain.samples).toBe(4);
    expect(pain.modified).toBe(3);
    expect(pain.medianFinalFrequency).toBe(6); // physician-final values [6,6,6,12] → median 6
    expect(pain.frequencyDirection).toBe("down");
    expect(pain.frequencyConsistency).toBe(1);
    expect(pain.recentReasons[0]).toContain("flares documented quarterly");
  });

  it("computes calibration against the engine's probability classes", () => {
    const probs = new Map([["L1", "PROBABLE"], ["L2", "PROBABLE"], ["L3", "PROBABLE"], ["L4", "PROBABLE"], ["R1", "POSSIBLE"], ["R2", "POSSIBLE"], ["R3", "POSSIBLE"]]);
    const p = buildLearningProfile(items, probs);
    const probable = p.calibration.find((c) => c.probability === "PROBABLE")!;
    expect(probable).toMatchObject({ samples: 4, approvedOrModified: 4 });
    const possible = p.calibration.find((c) => c.probability === "POSSIBLE")!;
    expect(possible).toMatchObject({ samples: 3, approvedOrModified: 1 });
  });
});

describe("insightFor", () => {
  const profile = buildLearningProfile([
    ...modifiedLineage("L1"),
    ...modifiedLineage("L2"),
    ...modifiedLineage("L3"),
    v({ lineageId: "R1", service: "Spinal cord stimulator trial", category: "INJECTION", physicianStatus: "REJECTED", physicianNote: "Not a candidate per psych eval." }),
    v({ lineageId: "R2", service: "Spinal cord stimulator trial", category: "INJECTION", physicianStatus: "REJECTED" }),
    v({ lineageId: "R3", service: "Spinal cord stimulator trial", category: "INJECTION", physicianStatus: "APPROVED" }),
  ]);

  it("flags consistent frequency corrections with provenance — without changing the proposal", () => {
    const insight = insightFor({ service: "Pain management office visits", category: "PAIN_MANAGEMENT", frequencyPerYear: 12 }, profile);
    expect(insight?.kind).toBe("FREQUENCY_HISTORY");
    expect(insight?.message).toContain("median 6×/yr");
    expect(insight?.message).toContain("proposed here at 12×/yr");
    expect(insight?.message).toContain("unchanged");
    expect(insight?.suggestedFrequencyPerYear).toBe(6);
  });

  it("a high rejection rate outranks parameter history and carries the documented reason", () => {
    const insight = insightFor({ service: "Spinal cord stimulator trial", category: "INJECTION", frequencyPerYear: 1 }, profile);
    expect(insight?.kind).toBe("HIGH_REJECTION");
    expect(insight?.message).toContain("rejected this service in 2 of 3");
    expect(insight?.message).toContain("psych eval");
  });

  it("stays silent below the sample floor and when physicians historically agree", () => {
    const thin = buildLearningProfile(modifiedLineage("only"));
    expect(insightFor({ service: "Pain management office visits", category: "PAIN_MANAGEMENT", frequencyPerYear: 12 }, thin)).toBeNull();
    expect(MIN_SAMPLES).toBeGreaterThan(1);
    // Agreement: candidate already proposed at the firm's settled median.
    expect(insightFor({ service: "Pain management office visits", category: "PAIN_MANAGEMENT", frequencyPerYear: 6 }, profile)).toBeNull();
  });

  it("no cross-service leakage: an unrelated service gets nothing", () => {
    expect(insightFor({ service: "Home modification assessment", category: "HOME_MODIFICATION", frequencyPerYear: 1 }, profile)).toBeNull();
  });
});
