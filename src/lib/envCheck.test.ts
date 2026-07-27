import { describe, it, expect } from "vitest";
import { checkEnv, OCR_CLOUD_CREDS } from "@/lib/envCheck";

const BASE = { DATABASE_URL: "postgresql://user:pass@localhost:5432/db" };

describe("checkEnv — always-fatal checks", () => {
  it("missing DATABASE_URL is a failure in every mode", () => {
    expect(checkEnv({}, true).failures).toContain("DATABASE_URL is not set.");
    expect(checkEnv({}, false).failures).toContain("DATABASE_URL is not set.");
  });

  it("clean minimal env passes with no failures or warnings", () => {
    expect(checkEnv(BASE, true)).toEqual({ failures: [], warnings: [] });
    expect(checkEnv(BASE, false)).toEqual({ failures: [], warnings: [] });
  });

  it("malformed SESSION_IDLE_MINUTES is fatal; a valid value passes", () => {
    expect(checkEnv({ ...BASE, SESSION_IDLE_MINUTES: "abc" }, false).failures).toHaveLength(1);
    expect(checkEnv({ ...BASE, SESSION_IDLE_MINUTES: "-5" }, true).failures).toHaveLength(1);
    expect(checkEnv({ ...BASE, SESSION_IDLE_MINUTES: "30" }, true).failures).toHaveLength(0);
  });
});

describe("checkEnv — LLM consistency", () => {
  it("named provider without creds: failure in production, warning in dev", () => {
    const env = { ...BASE, LLM_PROVIDER: "anthropic" };
    const prod = checkEnv(env, true);
    expect(prod.failures.some((f) => f.includes("ANTHROPIC_API_KEY"))).toBe(true);
    const dev = checkEnv(env, false);
    expect(dev.failures).toHaveLength(0);
    expect(dev.warnings.some((w) => w.includes("ANTHROPIC_API_KEY"))).toBe(true);
  });

  it("absent LLM_PROVIDER is consistent; fully configured anthropic passes", () => {
    expect(checkEnv(BASE, true).failures).toHaveLength(0);
    expect(checkEnv({ ...BASE, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }, true).failures).toHaveLength(0);
  });

  it("mock provider is flagged for production", () => {
    expect(checkEnv({ ...BASE, LLM_PROVIDER: "mock" }, true).failures.some((f) => f.includes("mock"))).toBe(true);
    expect(checkEnv({ ...BASE, LLM_PROVIDER: "mock" }, false).warnings.some((w) => w.includes("mock"))).toBe(true);
  });
});

describe("checkEnv — storage consistency", () => {
  it("S3_BUCKET without AWS_REGION is flagged", () => {
    const res = checkEnv({ ...BASE, S3_BUCKET: "b" }, true);
    expect(res.failures.some((f) => f.includes("AWS_REGION"))).toBe(true);
    expect(checkEnv({ ...BASE, S3_BUCKET: "b", AWS_REGION: "us-east-1" }, true).failures).toHaveLength(0);
  });

  it("S3-ish settings without S3_BUCKET would silently run local — flagged", () => {
    const res = checkEnv({ ...BASE, S3_KMS_KEY_ID: "key" }, true);
    expect(res.failures.some((f) => f.includes("S3_BUCKET is missing"))).toBe(true);
    const dev = checkEnv({ ...BASE, S3_PREFIX: "p/" }, false);
    expect(dev.failures).toHaveLength(0);
    expect(dev.warnings).toHaveLength(1);
  });
});

describe("checkEnv — OCR consistency", () => {
  it("cloud provider without BAA ack and creds lists both issues", () => {
    const res = checkEnv({ ...BASE, OCR_PROVIDER: "textract" }, true);
    expect(res.failures.some((f) => f.includes("OCR_BAA_ACK"))).toBe(true);
    expect(res.failures.some((f) => f.includes("AWS_ACCESS_KEY_ID"))).toBe(true);
  });

  it("fully configured cloud OCR passes; local always passes", () => {
    const env = {
      ...BASE, OCR_PROVIDER: "textract", OCR_BAA_ACK: "true",
      AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "s", AWS_REGION: "us-east-1",
    };
    expect(checkEnv(env, true).failures).toHaveLength(0);
    expect(checkEnv({ ...BASE, OCR_PROVIDER: "local" }, true).failures).toHaveLength(0);
  });

  it("unknown OCR provider is flagged", () => {
    expect(checkEnv({ ...BASE, OCR_PROVIDER: "gemini" }, true).failures.some((f) => f.includes("not a recognized"))).toBe(true);
  });

  it("cred matrix covers all three cloud providers", () => {
    expect(Object.keys(OCR_CLOUD_CREDS).sort()).toEqual(["azure", "documentai", "textract"]);
  });
});

describe("checkEnv — aggregation and mode routing", () => {
  it("production collects ALL issues as failures", () => {
    const env = { LLM_PROVIDER: "openai", S3_KMS_KEY_ID: "k", OCR_PROVIDER: "textract" };
    const res = checkEnv(env, true);
    // DATABASE_URL + LLM + S3 + OCR (BAA + creds) = 5 issues
    expect(res.failures).toHaveLength(5);
    expect(res.warnings).toHaveLength(0);
  });

  it("non-production keeps hard failures fatal but downgrades readiness issues", () => {
    const env = { LLM_PROVIDER: "openai", S3_KMS_KEY_ID: "k" };
    const res = checkEnv(env, false);
    expect(res.failures).toEqual(["DATABASE_URL is not set."]);
    expect(res.warnings).toHaveLength(2);
  });
});
