import { describe, expect, it } from "vitest";
import { findNotes, noteAt, personName } from "@/lib/records/noteStructure";

const body = (n = 400) => ` ${"clinical narrative text ".repeat(n / 8)} `;

describe("reading a name out of the form a chart printed it in", () => {
  it("reads an EHR export field", () => {
    // "TECHY_FERNANDO_MD" is one column of an export, not a name anyone wrote.
    expect(personName("TECHY_FERNANDO_MD, MD ______________")).toBe("Fernando Techy MD MD");
  });

  it("reads a surname-first listing", () => {
    expect(personName("GIDWANI, GIRISH M")).toBe("Girish M Gidwani");
  });

  it("reads a surname-first listing with no comma", () => {
    expect(personName("English Paul W")).toBe("Paul W English");
  });

  it("keeps an ordinary name as written", () => {
    expect(personName("Michael Crone, DC")).toBe("Michael Crone DC");
  });

  it("stops at the first thing that is not a name", () => {
    // "Provider: TECHY_FERNANDO_MD Fax: (713) 383-4446 Patient Information"
    expect(personName("TECHY_FERNANDO_MD Fax: (713) 383-4446")).toBe("Fernando Techy MD");
  });

  it("refuses an address, a department and a lone word", () => {
    expect(personName("4200 TWELVE OAKS PL HOUSTON")).toBeNull();
    expect(personName("Gidwani")).toBeNull();
    expect(personName("")).toBeNull();
  });
});

describe("finding the notes a document is made of", () => {
  it("opens a note at its header and closes it at the next", () => {
    const text = `History and Physical${body()}Operative Report${body()}Discharge Summary${body()}`;
    const notes = findNotes(text);
    expect(notes.map((n) => n.title)).toEqual(["History And Physical", "Operative Report", "Discharge Summary"]);
    expect(notes[0].end).toBe(notes[1].start);
  });

  it("names a note by the clinician who signed it", () => {
    const text = `Operative Report${body()}Electronically Signed by: TECHY_FERNANDO_MD, MD ____`;
    expect(findNotes(text)[0].author).toBe("Fernando Techy MD MD");
  });

  it("names a note from a labelled provider field", () => {
    const text = `Progress Note Provider: GIDWANI, GIRISH M Check in Date: 10/10/2024${body()}`;
    expect(findNotes(text)[0].author).toBe("Girish M Gidwani");
  });

  it("refuses to make a notary the author of a clinical note", () => {
    // A records-custodian affidavit is signed and notarised, so it carries
    // every marker a note does and none of the meaning. This chart prints 168
    // of them against 35 real clinical signatures.
    const text = `Progress Note${body()}DocuSigned by: Maritza Arzola NOTARY PUBLIC Notary ID 13362984-9`;
    expect(findNotes(text)[0].author).toBeNull();
  });

  it("finds nothing in a document with no structure to read", () => {
    // A scanned billing ledger. Saying so leaves the caller's behaviour alone.
    expect(findNotes("charge 99214 $250.00 charge 72148 $1,200.00")).toEqual([]);
  });

  it("ignores a header with nothing under it", () => {
    expect(findNotes("Progress Note Progress Note Operative Report")).toEqual([]);
  });
});

describe("which of a note's several true dates is its own", () => {
  const filler = (n = 400) => ` clinical narrative continues ${" more text".repeat(n / 20)} `;

  it("dates a discharge summary by its discharge, not its admission", () => {
    // A twelve-day stay's summary dated by the admission sits on day one.
    const text = `Discharge Summary Admission Date: 03/15/2024 Discharge Date: 03/27/2024 ${filler()}`;
    expect(findNotes(text)[0].date).toBe("2024-03-27");
  });

  it("dates an admission note by its admission", () => {
    const text = `Admission Note Admission Date: 03/15/2024 ${filler()}`;
    expect(findNotes(text)[0].date).toBe("2024-03-15");
  });

  it("dates imaging by the study, not by the radiologist's signature", () => {
    const text = `Radiology Report Date Performed: 09/03/2024 Date of Service: 09/05/2024 ${filler()}`;
    expect(findNotes(text)[0].date).toBe("2024-09-03");
  });

  it("dates a specimen by its collection, not its result", () => {
    const text = `Pathology Report Collection Date: 02/14/2024 Result Date: 02/19/2024 ${filler()}`;
    expect(findNotes(text)[0].date).toBe("2024-02-14");
  });

  it("dates a procedure by the procedure", () => {
    const text = `Operative Report Admission Date: 03/15/2024 Date of Procedure: 03/16/2024 ${filler()}`;
    expect(findNotes(text)[0].date).toBe("2024-03-16");
  });

  it("dates therapy by the evaluation", () => {
    const text = `Physical Therapy Evaluation Evaluation Date: 04/02/2024 Date of Service: 04/09/2024 ${filler()}`;
    expect(findNotes(text)[0].date).toBe("2024-04-02");
  });

  it("refuses an admission date printed on a progress note", () => {
    // Genuine, and not this note's date. Dating by it collapses an admission
    // onto its first day.
    const text = `Progress Note Admission Date: 03/15/2024 ${filler()}`;
    expect(findNotes(text)[0].date).toBeNull();
  });

  it("still refuses two service dates it cannot choose between", () => {
    const text = `Consultation Date of Service: 03/18/2024 Visit Date: 04/22/2024 ${filler()}`;
    expect(findNotes(text)[0].date).toBeNull();
  });
});

describe("placing a fragment in the note it came from", () => {
  const text = `History and Physical${body()}Operative Report${body()}`;
  const notes = findNotes(text);

  it("finds the note containing an offset", () => {
    expect(noteAt(notes, notes[0].start + 10)?.title).toBe("History And Physical");
    expect(noteAt(notes, notes[1].start + 10)?.title).toBe("Operative Report");
  });

  it("returns nothing for an offset outside every note", () => {
    expect(noteAt(notes, text.length + 10)).toBeNull();
    expect(noteAt([], 500)).toBeNull();
  });
});
