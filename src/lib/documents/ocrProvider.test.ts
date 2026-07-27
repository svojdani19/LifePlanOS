import { describe, it, expect, afterEach } from "vitest";
import { getOcrProvider } from "./ocrProvider";

describe("OCR provider seam", () => {
  afterEach(() => {
    delete process.env.OCR_PROVIDER;
    delete process.env.OCR_BAA_ACK;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_REGION;
  });

  it("defaults to the local on-device provider", () => {
    delete process.env.OCR_PROVIDER;
    expect(getOcrProvider().name).toBe("local");
  });

  it("the BAA acknowledgement gates the cloud path BEFORE credentials — no PHI leaves", async () => {
    process.env.OCR_PROVIDER = "textract";
    process.env.AWS_ACCESS_KEY_ID = "k";
    process.env.AWS_SECRET_ACCESS_KEY = "s";
    process.env.AWS_REGION = "us-east-1";
    // BAA not acknowledged: refuses even with full credentials.
    await expect(getOcrProvider().readPdf(Buffer.from("x"))).rejects.toThrow(/OCR_BAA_ACK/);
  });

  it("with the BAA acknowledged but credentials missing, it names exactly what is missing", async () => {
    process.env.OCR_PROVIDER = "textract";
    process.env.OCR_BAA_ACK = "true";
    await expect(getOcrProvider().readPdf(Buffer.from("x"))).rejects.toThrow(/AWS_ACCESS_KEY_ID/);
  });
});
