// ─────────────────────────────────────────────────────────────────────────────
// OCR provider seam.
//
// The default provider is LOCAL Tesseract (readPdf in ocr.ts) — fully on-device,
// no PHI leaves the machine. A medical-grade cloud provider (AWS Textract,
// Google Document AI, Azure Document Intelligence) is dramatically better on
// scanned charts and does table extraction, but sending a patient's record to a
// third party is only permissible with a signed BAA and provisioned credentials.
//
// This module is the switch-on point. It stays LOCAL unless ALL of the following
// are set, so a cloud provider can never be used by accident:
//   • OCR_PROVIDER = textract | documentai | azure
//   • OCR_BAA_ACK = true   (explicit operator acknowledgement a BAA is in place)
//   • the provider's own credentials (e.g. AWS_ACCESS_KEY_ID / …) in the env
// When selected but not fully configured — or when the provider SDK isn't
// installed — it throws a clear setup error rather than silently falling back,
// so a misconfiguration is loud, not a quiet PHI leak or a quiet downgrade.
// ─────────────────────────────────────────────────────────────────────────────

import { readPdf, type OcrResult, type OcrProgress } from "@/lib/documents/ocr";

export type { OcrResult, OcrProgress };

export type OcrProviderName = "local" | "textract" | "documentai" | "azure";

export interface OcrProvider {
  name: OcrProviderName;
  /** Read a PDF end-to-end, returning page-marked text + confidence. */
  readPdf(buffer: Buffer, onProgress?: (p: OcrProgress) => void | Promise<void>): Promise<OcrResult>;
}

const localProvider: OcrProvider = { name: "local", readPdf };

// Credentials each cloud provider needs before it may run.
const CLOUD_CREDS: Record<Exclude<OcrProviderName, "local">, string[]> = {
  textract: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
  documentai: ["GOOGLE_APPLICATION_CREDENTIALS", "GCP_PROJECT_ID", "DOCUMENTAI_PROCESSOR_ID"],
  azure: ["AZURE_DOCINTEL_ENDPOINT", "AZURE_DOCINTEL_KEY"],
};

function missingCreds(name: Exclude<OcrProviderName, "local">): string[] {
  return CLOUD_CREDS[name].filter((k) => !process.env[k]);
}

function setupError(name: OcrProviderName, detail: string): Error {
  return new Error(
    `OCR provider "${name}" is selected but ${detail}. ` +
      `Cloud OCR requires a signed BAA (set OCR_BAA_ACK=true), provider credentials, ` +
      `and the provider SDK installed. See docs/12_DEPLOYMENT.md. No PHI has been sent.`,
  );
}

/**
 * The cloud adapter is intentionally a guarded stub: the moment the SDK is added
 * and credentials + BAA ack are present, implement the call here (render/submit
 * the PDF, map the provider's blocks to page-marked text + confidence like
 * readPdf does) and it flows through automatically. Until then it refuses to run.
 */
function cloudProvider(name: Exclude<OcrProviderName, "local">): OcrProvider {
  return {
    name,
    async readPdf(): Promise<OcrResult> {
      if (process.env.OCR_BAA_ACK !== "true") throw setupError(name, "OCR_BAA_ACK is not set to true (no BAA acknowledged)");
      const missing = missingCreds(name);
      if (missing.length) throw setupError(name, `missing credentials: ${missing.join(", ")}`);
      // Credentials + BAA present but the adapter isn't implemented/installed yet.
      throw setupError(name, "its SDK/adapter is not installed — implement cloudProvider() and add the SDK dependency");
    },
  };
}

/**
 * Resolve the active OCR provider from the environment. Returns LOCAL unless a
 * cloud provider is fully authorized and configured.
 */
export function getOcrProvider(): OcrProvider {
  const selected = (process.env.OCR_PROVIDER ?? "local").toLowerCase() as OcrProviderName;
  if (selected === "local" || !selected) return localProvider;
  if (selected in CLOUD_CREDS) return cloudProvider(selected as Exclude<OcrProviderName, "local">);
  return localProvider;
}
