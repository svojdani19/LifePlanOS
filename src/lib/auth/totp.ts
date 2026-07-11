import { createHmac, randomBytes, createHash, timingSafeEqual } from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// TOTP (RFC 6238) for two-factor authentication — no third-party dependency.
// SHA-1 / 6 digits / 30-second step, compatible with Google Authenticator, Authy,
// 1Password, etc. Secrets are Base32 (RFC 4648, no padding).
// ─────────────────────────────────────────────────────────────────────────────

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP. Exposed for testing against the RFC 6238 vectors. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}

export function totp(secretBase32: string, atMs: number = Date.now(), step = 30, digits = 6): string {
  return hotp(base32Decode(secretBase32), Math.floor(atMs / 1000 / step), digits);
}

/** Verify a token, tolerating ±`window` steps of clock drift. */
export function verifyTotp(secretBase32: string, token: string, atMs: number = Date.now(), window = 1): boolean {
  const t = (token || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(t)) return false;
  const key = base32Decode(secretBase32);
  const counter = Math.floor(atMs / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    const candidate = hotp(key, counter + w);
    // constant-time compare
    if (candidate.length === t.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(t))) return true;
  }
  return false;
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUri(secret: string, account: string, issuer = "LifePlanOS"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── One-time backup recovery codes ───────────────────────────────────────────
export function generateBackupCodes(n = 10): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < n; i++) {
    const raw = randomBytes(5).toString("hex"); // 10 hex chars
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    codes.push(code);
    hashes.push(hashCode(code));
  }
  return { codes, hashes };
}
export const hashCode = (code: string) => createHash("sha256").update(code.replace(/[\s-]/g, "").toLowerCase()).digest("hex");
