// ─────────────────────────────────────────────────────────────────────────────
// Startup environment validation (pure). src/instrumentation.ts calls checkEnv
// at boot: in production every issue is fatal (one aggregate error), in
// non-production the production-readiness issues are downgraded to a single
// warning line. Messages never include secret values or PHI — only names.
//
// This module must stay import-light: it runs inside the Next.js
// instrumentation hook, so it must not pull in native addons (canvas,
// tesseract) or SDKs. The OCR credential matrix therefore lives HERE and
// documents/ocrProvider.ts imports it, not the other way around.
// ─────────────────────────────────────────────────────────────────────────────

import { validateLlmEnv } from "@/lib/llm";

type Env = Record<string, string | undefined>;

/** Credentials each cloud OCR provider needs before it may run (see ocrProvider.ts). */
export const OCR_CLOUD_CREDS: Record<"textract" | "documentai" | "azure", string[]> = {
  textract: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
  documentai: ["GOOGLE_APPLICATION_CREDENTIALS", "GCP_PROJECT_ID", "DOCUMENTAI_PROCESSOR_ID"],
  azure: ["AZURE_DOCINTEL_ENDPOINT", "AZURE_DOCINTEL_KEY"],
};

export interface EnvCheckResult {
  /** Fatal at boot. */
  failures: string[];
  /** Production-readiness issues, surfaced as a warning in non-production. */
  warnings: string[];
}

/**
 * Validate the process environment. Pure: pass `process.env` and the
 * production flag in; nothing is read or mutated globally.
 */
export function checkEnv(env: Env, production: boolean): EnvCheckResult {
  const failures: string[] = [];
  const prodIssues: string[] = [];

  // ── Always fatal ───────────────────────────────────────────────────────────
  if (!env.DATABASE_URL) failures.push("DATABASE_URL is not set.");

  // Auth: sessions are opaque random tokens hashed into the DB (see
  // src/lib/auth/session.ts) — there is no signing secret to require. The only
  // session env var is the optional idle timeout; reject nonsense values.
  if (env.SESSION_IDLE_MINUTES !== undefined && !(Number(env.SESSION_IDLE_MINUTES) > 0)) {
    failures.push("SESSION_IDLE_MINUTES is set but is not a positive number.");
  }

  // ── Production-readiness (fatal in production, warned in dev) ──────────────
  // LLM: absent is consistent (assistant returns 503 in production); a named
  // provider must have its credentials; mock is forbidden in production.
  prodIssues.push(...validateLlmEnv(env, true));

  // Storage: half-configured S3 must not silently degrade to local disk.
  if (env.S3_BUCKET) {
    if (!env.AWS_REGION) prodIssues.push("S3_BUCKET is set but AWS_REGION is missing.");
  } else if (env.S3_PREFIX || env.S3_KMS_KEY_ID) {
    prodIssues.push(
      "S3 settings (S3_PREFIX / S3_KMS_KEY_ID) are present but S3_BUCKET is missing — storage would silently run in local mode.",
    );
  }

  // OCR: a cloud provider may only run with an acknowledged BAA + credentials.
  const ocr = (env.OCR_PROVIDER ?? "local").toLowerCase();
  if (ocr !== "local") {
    if (ocr in OCR_CLOUD_CREDS) {
      if (env.OCR_BAA_ACK !== "true") {
        prodIssues.push(`OCR_PROVIDER=${ocr} is selected but OCR_BAA_ACK is not "true" (no BAA acknowledged).`);
      }
      const missing = OCR_CLOUD_CREDS[ocr as keyof typeof OCR_CLOUD_CREDS].filter((k) => !env[k]);
      if (missing.length) {
        prodIssues.push(`OCR_PROVIDER=${ocr} is selected but credentials are missing: ${missing.join(", ")}.`);
      }
    } else {
      prodIssues.push(`OCR_PROVIDER="${env.OCR_PROVIDER}" is not a recognized provider (local, textract, documentai, azure).`);
    }
  }

  return production
    ? { failures: [...failures, ...prodIssues], warnings: [] }
    : { failures, warnings: prodIssues };
}
