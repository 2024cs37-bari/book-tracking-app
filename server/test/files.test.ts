import { describe, expect, it } from 'vitest';
import app from '../src/worker';
import {
  fileObjectKey,
  handleBeginUpload,
  handleFinishUpload,
  MAX_FILE_BYTES,
  type ObjectStore,
  type StoredObject,
} from '../src/files';

class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();
  head(key: string): Promise<StoredObject | null> {
    return Promise.resolve(this.objects.get(key) ?? null);
  }
}

const SHA = 'a'.repeat(64);

describe('file upload authorization', () => {
  it('rejects invalid hashes and sizes consistently at begin and finish', async () => {
    const store = new MemoryObjectStore();
    for (const handler of [handleBeginUpload, handleFinishUpload]) {
      expect((await handler(store, 'u', 'not-hex', 10)).status).toBe(400);
      for (const size of [undefined, null, '10', -1, 0, 1.5, NaN]) {
        expect((await handler(store, 'u', SHA, size)).status).toBe(400);
      }
      expect((await handler(store, 'u', SHA, MAX_FILE_BYTES + 1)).status).toBe(413);
    }
  });

  it('deduplicates only objects with a verified hash and matching size', async () => {
    const store = new MemoryObjectStore();
    expect((await handleBeginUpload(store, 'u', SHA, 10)).body).toEqual({
      already_available: false,
    });
    store.objects.set(fileObjectKey('u', SHA), { size: 10 });
    expect((await handleBeginUpload(store, 'u', SHA, 10)).body).toEqual({
      already_available: false,
    });
    store.objects.set(fileObjectKey('u', SHA), { size: 10, sha256: SHA });
    expect((await handleBeginUpload(store, 'u', SHA, 10)).body).toEqual({
      already_available: true,
    });
    expect((await handleBeginUpload(store, 'u', SHA, 11)).body).toEqual({
      already_available: false,
    });
    expect((await handleBeginUpload(store, 'other', SHA, 10)).body).toEqual({
      already_available: false,
    });
  });

  it('finish requires an existing object, exact size, and a verified checksum', async () => {
    const store = new MemoryObjectStore();
    expect((await handleFinishUpload(store, 'u', SHA, 10)).body).toEqual({
      code: 'object_missing',
    });
    store.objects.set(fileObjectKey('u', SHA), { size: 10 });
    expect((await handleFinishUpload(store, 'u', SHA, 20)).body).toEqual({ code: 'size_mismatch' });
    expect((await handleFinishUpload(store, 'u', SHA, 10)).body).toEqual({
      code: 'hash_unverified',
    });
    store.objects.set(fileObjectKey('u', SHA), { size: 10, sha256: SHA });
    expect((await handleFinishUpload(store, 'u', SHA, 10)).status).toBe(200);
  });
});

describe('file request limits before storage', () => {
  const env = {
    DEV_USER: 'local',
    ACCESS_AUD: '',
    ACCESS_TEAM_DOMAIN: '',
  } as unknown as Parameters<typeof app.request>[2];
  it('rejects oversized declarations and missing lengths without reading storage', async () => {
    const oversized = await app.request(
      `http://localhost/api/v1/files/${SHA}`,
      {
        method: 'PUT',
        body: 'x',
        headers: { 'content-length': String(MAX_FILE_BYTES + 1) },
      },
      env,
    );
    expect(oversized.status).toBe(413);
    const unknown = await app.request(
      `http://localhost/api/v1/files/${SHA}`,
      { method: 'PUT', body: 'x' },
      env,
    );
    expect(unknown.status).toBe(411);
    const empty = await app.request(
      `http://localhost/api/v1/files/${SHA}`,
      {
        method: 'PUT',
        body: '',
        headers: { 'content-length': '0' },
      },
      env,
    );
    expect(empty.status).toBe(400);
  });
});
