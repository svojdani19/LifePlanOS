import { describe, it, expect, afterEach } from "vitest";
import { convertDocxToPdf, pdfConverterCommand } from "./pdf";

describe("PDF conversion seam (ATD-7)", () => {
  afterEach(() => {
    delete process.env.PDF_CONVERTER;
  });

  it("defaults to LibreOffice and honors PDF_CONVERTER", () => {
    delete process.env.PDF_CONVERTER;
    expect(pdfConverterCommand()).toBe("soffice");
    process.env.PDF_CONVERTER = "/opt/libreoffice/soffice";
    expect(pdfConverterCommand()).toBe("/opt/libreoffice/soffice");
  });

  it("a missing converter is a loud setup error naming the fix — never a silent re-typeset", async () => {
    process.env.PDF_CONVERTER = "definitely-not-installed-converter";
    await expect(convertDocxToPdf(Buffer.from("not-a-real-docx"))).rejects.toThrow(/not installed.*ATD-7|ATD-7/s);
  });
});
