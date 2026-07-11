import { describe, it, expect } from "vitest";
import { hotp, totp, verifyTotp, base32Encode, base32Decode, generateSecret, generateBackupCodes } from "./totp";

// RFC 6238 test seed: ASCII "12345678901234567890" (20 bytes, SHA-1).
const SEED = Buffer.from("12345678901234567890", "ascii");

describe("hotp / totp — RFC 6238 test vectors (SHA-1, 8 digits)", () => {
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [time, expected] of vectors) {
    it(`T=${time} → ${expected}`, () => {
      const counter = Math.floor(time / 30);
      expect(hotp(SEED, counter, 8)).toBe(expected);
      // and via totp() with the base32-encoded seed
      expect(totp(base32Encode(SEED), time * 1000, 30, 8)).toBe(expected);
    });
  }
});

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const b = Buffer.from("the quick brown fox");
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });
  it("encodes the RFC seed to the known value", () => {
    expect(base32Encode(SEED)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });
});

describe("verifyTotp", () => {
  it("accepts the current code and tolerates ±1 step of drift", () => {
    const secret = generateSecret();
    const now = Date.now();
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now - 30000), now)).toBe(true); // prev window
    expect(verifyTotp(secret, totp(secret, now + 30000), now)).toBe(true); // next window
  });
  it("rejects a stale or malformed code", () => {
    const secret = generateSecret();
    const now = Date.now();
    expect(verifyTotp(secret, totp(secret, now - 120000), now)).toBe(false);
    expect(verifyTotp(secret, "abc", now)).toBe(false);
    expect(verifyTotp(secret, "000000", now)).toBe(false);
  });
});

describe("backup codes", () => {
  it("generates codes and matching one-way hashes", () => {
    const { codes, hashes } = generateBackupCodes(10);
    expect(codes).toHaveLength(10);
    expect(hashes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10); // unique
    expect(hashes.every((h) => /^[a-f0-9]{64}$/.test(h))).toBe(true);
  });
});
