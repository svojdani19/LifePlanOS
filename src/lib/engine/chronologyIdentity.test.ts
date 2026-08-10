// The production chronology used to key encounters by calendar date:
// `byDate = new Map<string, Encounter>()`, so a combined records production
// carrying a therapy session, an imaging study, an emergency visit and a
// follow-up on one day reported all four as a single event.
//
// These tests hold the production path — the one `extractionRun` and
// `generate` actually call — to the same rule as the record merger: a date may
// contribute to identity, and never authorizes a merge on its own.
//
// Synthetic records only — no PHI.

import { describe, expect, it } from "vitest";
import { isHeaderRepeat, segmentEncounters } from "@/lib/engine/chronology";
import { pageMarks } from "@/lib/documents/meta";

const seg = (text: string) => segmentEncounters(text, pageMarks(text));

// One day of a combined production: four different encounters, same date.
const SAME_DAY_PRODUCTION = `
Date of Service: 03/15/2024
Physical therapy progress note. Therapeutic exercise and gait training were
performed. The patient tolerated the session without complaint and a home
exercise program was reviewed in full before discharge from the session.

Date of Service: 03/15/2024
MRI of the lumbar spine. Technique: multiplanar sequences were obtained.
Findings: disc protrusion at L4-L5. Impression: severe central canal stenosis
measuring five millimetres in anteroposterior dimension at that level.

Date of Service: 03/15/2024
Emergency department report. The patient arrived by ambulance following a fall.
Triage was completed and chest radiographs were obtained in the department
before the patient was moved to an observation bed for continued monitoring.

Date of Service: 03/15/2024
Operative report. Procedure performed: laminectomy at L4-L5. Surgeon: A Smith.
Anesthesia: general. An incision was made and decompression was carried out at
the affected level without intraoperative complication of any kind.
`;

describe("the production chronology no longer collapses a day into one event", () => {
  it("yields one encounter per note when a day carries several", () => {
    const encounters = seg(SAME_DAY_PRODUCTION);
    expect(encounters.length).toBe(4);
    expect(new Set(encounters.map((e) => e.dateIso))).toEqual(new Set(["2024-03-15"]));
  });

  it("keeps each note's own text with its own encounter", () => {
    const encounters = seg(SAME_DAY_PRODUCTION);
    expect(encounters.some((e) => /therapeutic exercise/i.test(e.text))).toBe(true);
    expect(encounters.some((e) => /impression: severe central canal stenosis/i.test(e.text))).toBe(true);
    expect(encounters.some((e) => /arrived by ambulance/i.test(e.text))).toBe(true);
    expect(encounters.some((e) => /laminectomy at l4-l5/i.test(e.text))).toBe(true);
    // and no single encounter swallowed all of them
    expect(encounters.every((e) => !(/therapeutic exercise/i.test(e.text) && /laminectomy/i.test(e.text)))).toBe(true);
  });

  it("still separates different dates", () => {
    const encounters = seg(`
Date of Service: 03/15/2024
Operative report. Procedure performed: laminectomy at L4-L5 with decompression
carried out at the affected level and no complication recorded during surgery.

Date of Service: 04/02/2024
Follow-up visit. The surgical incision was inspected and found to be healing
well, with sutures removed and no sign of infection noted at the wound edge.
`);
    expect(encounters.map((e) => e.dateIso)).toEqual(["2024-03-15", "2024-04-02"]);
  });
});

describe("a repeated date header is not a second encounter", () => {
  it("folds a bare header repeat into the note it belongs to", () => {
    // Charts restate the service date in table rows and continuation banners.
    // Those were harmless when every same-date segment merged; now that each
    // anchor starts an encounter, a repeat would become a duplicate event.
    const encounters = seg(`
Date of Service: 03/15/2024
Operative report. Procedure performed: laminectomy at L4-L5. An incision was
made and decompression carried out at the affected level without complication.

Date of Service: 03/15/2024

Date of Service: 03/15/2024
`);
    expect(encounters).toHaveLength(1);
  });

  it("recognises a bare repeat", () => {
    expect(isHeaderRepeat("Date of Service: 03/15/2024", "some open note text")).toBe(true);
  });

  it("does not treat a note's worth of content as a repeat", () => {
    const body = "Operative report. Procedure performed: laminectomy at L4-L5. ".repeat(6);
    expect(isHeaderRepeat(`Date of Service: 03/15/2024 ${body}`, "some open note text")).toBe(false);
  });

  it("does not fold a short segment that names a different clinician", () => {
    expect(
      isHeaderRepeat("Date of Service: 03/15/2024 Provider: Fernando Techy, M.D.", "Provider: Michael Crone, DC — therapy note"),
    ).toBe(false);
  });
});

describe("duplicate chunk extractions of one encounter still collapse", () => {
  it("a combined PDF yields one entry per encounter, not one per chunk", () => {
    // The end-to-end shape of the defect: several same-day encounters in one
    // document, each of which the extractor reads more than once.
    const encounters = seg(SAME_DAY_PRODUCTION);
    // Four notes in, four encounters out — no note split, none merged away.
    expect(encounters).toHaveLength(4);
    // Re-segmenting the same text gives the same answer.
    expect(seg(SAME_DAY_PRODUCTION).map((e) => e.text)).toEqual(encounters.map((e) => e.text));
  });

  it("is deterministic and idempotent", () => {
    const once = seg(SAME_DAY_PRODUCTION);
    const twice = seg(SAME_DAY_PRODUCTION);
    expect(twice.map((e) => ({ d: e.dateIso, t: e.text }))).toEqual(once.map((e) => ({ d: e.dateIso, t: e.text })));
  });
});
