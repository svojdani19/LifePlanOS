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
