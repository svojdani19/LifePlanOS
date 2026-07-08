import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Object storage abstraction. Dev uses a local `uploads/` dir; production swaps
// the two functions below for S3/GCS with server-side encryption. PHI files are
// never served statically — they're streamed through authenticated routes.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = join(process.cwd(), "uploads");

export async function putObject(data: Buffer, ext: string): Promise<string> {
  await mkdir(ROOT, { recursive: true });
  const key = `${randomUUID()}${ext}`;
  await writeFile(join(ROOT, key), data);
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  return readFile(join(ROOT, key));
}
