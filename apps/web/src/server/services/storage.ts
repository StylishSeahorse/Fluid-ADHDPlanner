/**
 * Where attachment bytes live: a directory on the server's disk.
 *
 * Keys are generated here — a random id under two levels of hashed
 * directories — and never derived from anything a user typed, so no filename
 * can become `../../etc/passwd`. Every resolved path is still checked to sit
 * inside the storage root, as a second line of defence.
 *
 * One driver for now. Anything that implements put/read/remove can replace it
 * (S3 and friends) without touching the routes that call it.
 */
import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { env } from '@fluid/env';

const root = path.resolve(env.STORAGE_DIR);

export const MAX_UPLOAD_BYTES = env.MAX_UPLOAD_MB * 1024 * 1024;

export class UploadTooLargeError extends Error {
  constructor() {
    super(`Files can be up to ${env.MAX_UPLOAD_MB} MB.`);
  }
}

function resolveKey(key: string): string {
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new Error('Storage key escapes the storage root.');
  return full;
}

export function newStorageKey(): string {
  const id = randomBytes(16).toString('hex');
  return `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`;
}

/**
 * Write a stream to storage, refusing anything over the size limit part-way
 * through rather than after buffering it. Returns the size and SHA-256.
 */
export async function putObject(key: string, body: ReadableStream<Uint8Array>): Promise<{ size: number; sha256: string }> {
  const target = resolveKey(key);
  await mkdir(path.dirname(target), { recursive: true });

  const hash = createHash('sha256');
  let size = 0;
  const reader = Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
  reader.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) reader.destroy(new UploadTooLargeError());
    else hash.update(chunk);
  });

  try {
    await pipeline(reader, createWriteStream(target, { flags: 'wx' }));
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
  return { size, sha256: hash.digest('hex') };
}

export async function readObject(key: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
  const target = resolveKey(key);
  const info = await stat(target);
  return { stream: Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>, size: info.size };
}

export async function removeObject(key: string): Promise<void> {
  await rm(resolveKey(key), { force: true });
}
