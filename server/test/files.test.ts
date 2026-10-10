import { describe, expect, it } from 'vitest';
import app from '../src/worker';
import {
  fileObjectKey,
  handleBeginUpload,
  handleFinishUpload,
  MAX_FILE_BYTES,
  type ObjectStore,
} from '../src/files';

/** In-memory stand-in for the private R2 bucket. */
class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, ArrayBuffer>();
  head(key: string): Promise<{ size: number } | null> {
    const bytes = this.objects.get(key);
    return Promise.resolve(bytes === undefined ? null : { size: bytes.byteLength });
  }
  put(key: string, bytes: ArrayBuffer): Promise<void> {
    this.objects.set(key, bytes);
    return Promise.resolve();
  }
  get(key: string): Promise<{ bytes: ArrayBuffer; size: number } | null> {
    const bytes = this.objects.get(key);
    return Promise.resolve(bytes === undefined ? null : { bytes, size: bytes.byteLength });
  }
}

/** An R2-binding-shaped adapter over the in-memory store for the worker routes. */
function fakeBucket(store: MemoryObjectStore) {
  return {
    head: (key: string) => store.head(key),
    put: (key: string, value: ArrayBuffer) => store.put(key, value),
    get: async (key: string) => {
      const object = await store.get(key);
      return object === null
        ? null
        : { size: object.size, arrayBuffer: () => Promise.resolve(object.bytes) };
    },
  };
}

const SHA = 'a'.repeat(64);

function env(store: MemoryObjectStore, user = 'user-1') {
  return {
    FILES: fakeBucket(store),
    DB: undefined,
    ACCESS_AUD: '',
    ACCESS_TEAM_DOMAIN: '',
    DEV_USER: user,
  } as unknown as Parameters<typeof app.request>[2];
}

describe('file upload authorization', () => {
  it('rejects a bad hash or size', async () => {
    const store = new MemoryObjectStore();
    expect((await handleBeginUpload(store, 'u', 'not-hex', 10)).status).toBe(400);
    expect((await handleBeginUpload(store, 'u', SHA, 0)).status).toBe(400);
    expect((await handleBeginUpload(store, 'u', SHA, MAX_FILE_BYTES + 1)).status).toBe(413);
  });

  it('reports dedup when the object already exists', async () => {
    const store = new MemoryObjectStore();
    const first = await handleBeginUpload(store, 'u', SHA, 10);
    expect(first.body).toEqual({ already_available: false });
    await store.put(fileObjectKey('u', SHA), new ArrayBuffer(10));
    const second = await handleBeginUpload(store, 'u', SHA, 10);
    expect(second.body).toEqual({ already_available: true });
  });

  it('finish requires the object to exist and match the declared size', async () => {
    const store = new MemoryObjectStore();
    expect((await handleFinishUpload(store, 'u', SHA, 10)).status).toBe(409);
    await store.put(fileObjectKey('u', SHA), new ArrayBuffer(10));
    expect((await handleFinishUpload(store, 'u', SHA, 20)).status).toBe(409);
    expect((await handleFinishUpload(store, 'u', SHA, 10)).status).toBe(200);
  });
});

describe('file routes', () => {
  it('round-trips an object through PUT and GET', async () => {
    const store = new MemoryObjectStore();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    const put = await app.request(
      `/api/v1/files/${SHA}`,
      { method: 'PUT', body: bytes },
      env(store),
    );
    expect(put.status).toBe(200);

    const get = await app.request(`/api/v1/files/${SHA}`, {}, env(store));
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it('begin reports an object available only after it is uploaded', async () => {
    const store = new MemoryObjectStore();
    const before = await app.request(
      '/api/v1/files/begin',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha256: SHA, size: 3 }),
      },
      env(store),
    );
    expect(await before.json()).toEqual({ already_available: false });

    await app.request(
      `/api/v1/files/${SHA}`,
      { method: 'PUT', body: new Uint8Array([1, 2, 3]) },
      env(store),
    );

    const after = await app.request(
      '/api/v1/files/begin',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha256: SHA, size: 3 }),
      },
      env(store),
    );
    expect(await after.json()).toEqual({ already_available: true });
  });

  it('returns 404 for a missing object', async () => {
    const store = new MemoryObjectStore();
    const get = await app.request(`/api/v1/files/${SHA}`, {}, env(store));
    expect(get.status).toBe(404);
  });

  it('scopes objects per user: another user cannot read them', async () => {
    const store = new MemoryObjectStore();
    await app.request(
      `/api/v1/files/${SHA}`,
      { method: 'PUT', body: new Uint8Array([9]) },
      env(store, 'owner'),
    );
    const asOther = await app.request(`/api/v1/files/${SHA}`, {}, env(store, 'intruder'));
    expect(asOther.status).toBe(404);
    const asOwner = await app.request(`/api/v1/files/${SHA}`, {}, env(store, 'owner'));
    expect(asOwner.status).toBe(200);
  });

  it('rejects a non-hex hash in the path', async () => {
    const store = new MemoryObjectStore();
    const get = await app.request('/api/v1/files/not-a-hash', {}, env(store));
    expect(get.status).toBe(400);
  });
});
