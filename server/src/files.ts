/**
 * Original-file object storage over private R2 (docs/BACKEND.md §6, STORAGE.md
 * §7). Books' bytes do not travel through the sync change log; they are PUT/GET
 * directly against the Worker, which mediates the transfer to a private bucket.
 *
 * Mediating through the Worker (rather than issuing S3 presigned URLs) keeps the
 * security model simple for a single-user personal deployment — every byte is
 * gated by the same Access identity as the sync API, and no S3 credentials are
 * provisioned. The trade-off is that the body passes through the Worker, so a
 * conservative size bound applies; a presigned-URL or multipart path is the
 * route for larger objects later. Object keys are scoped by user so one
 * account's hashes can never read another's bytes.
 */

/** Max bytes mediated through the Worker in one request (Workers body limits). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface StoredObject {
  readonly size: number;
}

/** The subset of R2 the file routes need; an in-memory fake implements it in tests. */
export interface ObjectStore {
  head(key: string): Promise<StoredObject | null>;
  put(key: string, bytes: ArrayBuffer): Promise<void>;
  get(key: string): Promise<{ bytes: ArrayBuffer; size: number } | null>;
}

/** Minimal R2 binding surface, declared locally so this file needs no bundled types. */
interface R2Like {
  head(key: string): Promise<{ size: number } | null>;
  put(key: string, value: ArrayBuffer): Promise<unknown>;
  get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export class R2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2Like) {}
  async head(key: string): Promise<StoredObject | null> {
    const object = await this.bucket.head(key);
    return object === null ? null : { size: object.size };
  }
  async put(key: string, bytes: ArrayBuffer): Promise<void> {
    await this.bucket.put(key, bytes);
  }
  async get(key: string): Promise<{ bytes: ArrayBuffer; size: number } | null> {
    const object = await this.bucket.get(key);
    if (object === null) return null;
    return { bytes: await object.arrayBuffer(), size: object.size };
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

/** Private object key, scoped per user and addressed by content hash. */
export function fileObjectKey(user: string, sha256: string): string {
  return `files/${user}/${sha256}`;
}

export interface HandlerResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Authorizes an upload: validates the hash and size bound and reports whether
 * the object already exists (hash dedup — the client then skips the transfer).
 */
export async function handleBeginUpload(
  store: ObjectStore,
  user: string,
  sha256: unknown,
  size: unknown,
): Promise<HandlerResult> {
  if (typeof sha256 !== 'string' || !isSha256Hex(sha256)) {
    return { status: 400, body: { code: 'bad_hash' } };
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    return { status: 400, body: { code: 'bad_size' } };
  }
  if (size > MAX_FILE_BYTES) {
    return { status: 413, body: { code: 'too_large' } };
  }
  const existing = await store.head(fileObjectKey(user, sha256));
  return { status: 200, body: { already_available: existing !== null } };
}

/**
 * Confirms an upload: the object must now exist and match the declared size.
 * Server-side SHA-256 verification is not available on R2, so availability is
 * recorded on size + existence here, and the client independently verifies the
 * hash on download (BACKEND.md §6 — documented residual limitation).
 */
export async function handleFinishUpload(
  store: ObjectStore,
  user: string,
  sha256: unknown,
  size: unknown,
): Promise<HandlerResult> {
  if (typeof sha256 !== 'string' || !isSha256Hex(sha256)) {
    return { status: 400, body: { code: 'bad_hash' } };
  }
  const info = await store.head(fileObjectKey(user, sha256));
  if (info === null) return { status: 409, body: { code: 'object_missing' } };
  if (typeof size === 'number' && Number.isSafeInteger(size) && info.size !== size) {
    return { status: 409, body: { code: 'size_mismatch' } };
  }
  return { status: 200, body: { ok: true } };
}
