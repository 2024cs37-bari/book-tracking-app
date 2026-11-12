/** Private, content-addressed original files; all access passes through the Worker. */

/** Cloudflare's default request limit is 100 MB (decimal), not 100 MiB. */
export const MAX_FILE_BYTES = 100_000_000;

export interface StoredObject {
  readonly size: number;
  /** R2 records this only when it verified the checksum during PUT. */
  readonly sha256?: string;
}

export interface ObjectStore {
  head(key: string): Promise<StoredObject | null>;
}

function checksumHex(checksum: ArrayBuffer | undefined): string | undefined {
  return checksum === undefined
    ? undefined
    : Array.from(new Uint8Array(checksum), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class R2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2Bucket) {}
  async head(key: string): Promise<StoredObject | null> {
    const object = await this.bucket.head(key);
    if (object === null) return null;
    const sha256 = checksumHex(object.checksums.sha256);
    return { size: object.size, ...(sha256 === undefined ? {} : { sha256 }) };
  }

  async put(key: string, stream: ReadableStream, sha256: string): Promise<void> {
    // R2 rejects mismatching bytes before publishing the object. The request
    // stream has a platform-enforced Content-Length; no 100 MB JS buffer exists.
    await this.bucket.put(key, stream, {
      sha256,
      httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, no-store' },
    });
  }

  get(key: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(key);
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

export function fileObjectKey(user: string, sha256: string): string {
  return `files/${user}/${sha256}`;
}

export interface HandlerResult {
  readonly status: 200 | 400 | 409 | 413;
  readonly body: Record<string, unknown>;
}

function validateFile(sha256: unknown, size: unknown): HandlerResult | null {
  if (typeof sha256 !== 'string' || !isSha256Hex(sha256)) {
    return { status: 400, body: { code: 'bad_hash' } };
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    return { status: 400, body: { code: 'bad_size' } };
  }
  return size > MAX_FILE_BYTES ? { status: 413, body: { code: 'too_large' } } : null;
}

export async function handleBeginUpload(
  store: ObjectStore,
  user: string,
  sha256: unknown,
  size: unknown,
): Promise<HandlerResult> {
  const error = validateFile(sha256, size);
  if (error) return error;
  const existing = await store.head(fileObjectKey(user, sha256 as string));
  // Pre-hardening uploads without a verified checksum must be re-uploaded.
  return {
    status: 200,
    body: {
      already_available: existing?.sha256 === sha256 && existing?.size === size,
    },
  };
}

export async function handleFinishUpload(
  store: ObjectStore,
  user: string,
  sha256: unknown,
  size: unknown,
): Promise<HandlerResult> {
  const error = validateFile(sha256, size);
  if (error) return error;
  const info = await store.head(fileObjectKey(user, sha256 as string));
  if (info === null) return { status: 409, body: { code: 'object_missing' } };
  if (info.size !== size) return { status: 409, body: { code: 'size_mismatch' } };
  if (info.sha256 !== sha256) return { status: 409, body: { code: 'hash_unverified' } };
  return { status: 200, body: { ok: true } };
}
