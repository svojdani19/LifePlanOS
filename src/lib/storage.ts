import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Object storage abstraction. PHI files are never served statically — they are
// streamed through authenticated, audited routes.
//
//   • Production: set S3_BUCKET (+ AWS_REGION and standard AWS credentials) to
//     store encrypted objects in S3. Set S3_KMS_KEY_ID for SSE-KMS; otherwise
//     SSE-S3 (AES256) is used. Optional S3_PREFIX namespaces keys.
//   • Dev fallback: with no S3_BUCKET, objects are written to a local `uploads/`
//     directory (gitignored — never commit PHI).
//
// The AWS SDK is imported lazily so it is only loaded when S3 is configured.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = join(process.cwd(), "uploads");
const BUCKET = process.env.S3_BUCKET;
const PREFIX = process.env.S3_PREFIX ?? "";
const KMS_KEY = process.env.S3_KMS_KEY_ID;

export function storageMode(): "s3" | "local" {
  return BUCKET ? "s3" : "local";
}

async function s3Client() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({ region: process.env.AWS_REGION });
}
const localName = (key: string) => key.replace(/[\\/]/g, "_");

export async function putObject(data: Buffer, ext: string): Promise<string> {
  const key = `${PREFIX}${randomUUID()}${ext}`;
  if (BUCKET) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await s3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: data,
        ServerSideEncryption: KMS_KEY ? "aws:kms" : "AES256",
        SSEKMSKeyId: KMS_KEY || undefined,
      }),
    );
    return key;
  }
  await mkdir(ROOT, { recursive: true });
  await writeFile(join(ROOT, localName(key)), data);
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  if (BUCKET) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await s3Client();
    const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const bytes = await (res.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }
  return readFile(join(ROOT, localName(key)));
}
