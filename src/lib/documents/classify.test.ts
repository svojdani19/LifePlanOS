import { describe, it, expect } from "vitest";
import { classifyDocument, classifyByContent } from "./classify";

describe("classifyDocument — content over filename", () => {
  it("classifies an operative note from its body, not its (generic) filename", () => {
    const c = classifyDocument({
      text: `OPERATIVE REPORT
PREOPERATIVE DIAGNOSIS: displaced tibial plateau fracture.
POSTOPERATIVE DIAGNOSIS: same.
PROCEDURE PERFORMED: open reduction internal fixation.
SURGEON: J. Ortho, MD. ANESTHESIA: General.
ESTIMATED BLOOD LOSS: 150 mL. Closure in layers.`,
      filename: "Uploaded_Document_01.pdf",
      hasText: true,
    });
    expect(c.type).toBe("OPERATIVE_NOTE");
    expect(c.method).toBe("content");
  });

  it("classifies a deposition transcript by content", () => {
    const c = classifyDocument({
      text: `IN THE SUPERIOR COURT OF THE STATE
DEPOSITION OF THE WITNESS, being first duly sworn, testified as follows.
EXAMINATION BY MR. SMITH. Reporter's certificate attached. APPEARANCES: counsel noted.`,
      filename: "doc.pdf",
      hasText: true,
    });
    expect(c.type).toBe("DEPOSITION");
  });

  it("falls back to the filename when there is no extractable text (a scan)", () => {
    const c = classifyDocument({ text: "", filename: "operative_note.pdf", hasText: false });
    expect(c.method).toBe("filename");
  });

  it("scores the winning type above the runner-up", () => {
    const r = classifyByContent(`IMPRESSION: acute L1 burst fracture. FINDINGS: retropulsion. TECHNIQUE: MRI of the lumbar spine. Radiologist reviewed.`);
    expect(r.type).toBe("IMAGING_REPORT");
    expect(r.score).toBeGreaterThan(r.runnerUpScore);
  });
});
