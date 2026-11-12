import { afterEach, expect, it, vi } from 'vitest';
import {
  NativeBookFileStore,
  isNativeRuntime,
  type NativeInvoke,
} from '~/storage/native-file-store';
import { sha256Hex } from '~/storage/sha256';

const CHUNK_BYTES = 256 * 1024;
const metadata = {
  version: 1,
  chunkBytes: CHUNK_BYTES,
  maxOriginalBytes: 256 * 1024 * 1024,
  maxCoverBytes: 16 * 1024 * 1024,
};
const token = '11111111-1111-4111-8111-111111111111';
afterEach(() => vi.unstubAllGlobals());

function transport(bytes: Uint8Array<ArrayBuffer>) {
  const key = `books/${sha256Hex(bytes)}.bin`;
  const invoke = vi.fn<NativeInvoke>(async (command, args) => {
    const values = args as Record<string, unknown> | undefined;
    switch (command) {
      case 'native_store_info':
        return metadata;
      case 'native_store_begin':
        return token;
      case 'native_store_stat':
      case 'native_store_commit':
        return { key, sizeBytes: bytes.length };
      case 'native_store_read':
        return bytes.slice(Number(values?.offset), Number(values?.offset) + Number(values?.length))
          .buffer;
      case 'native_store_keys':
        return [key];
      default:
        return null;
    }
  });
  return { key, invoke };
}

it('writes bounded binary chunks in order and commits only after every append succeeds', async () => {
  const bytes = new Uint8Array(CHUNK_BYTES + 7).fill(42);
  const { key, invoke } = transport(bytes);
  const store = await NativeBookFileStore.connect(invoke);
  expect(await store.put(key, new Blob([bytes]))).toEqual({ key, sizeBytes: bytes.length });
  const appends = invoke.mock.calls.filter(([command]) => command === 'native_store_append');
  expect(appends.map(([, chunk]) => (chunk as Uint8Array).byteLength)).toEqual([CHUNK_BYTES, 7]);
  expect(appends.map(([, , options]) => options?.headers)).toEqual([
    { 'x-book-token': token, 'x-book-offset': '0' },
    { 'x-book-token': token, 'x-book-offset': String(CHUNK_BYTES) },
  ]);
  expect(invoke.mock.calls.at(-1)).toEqual(['native_store_commit', { token }]);
});

it('aborts a failed staged write and never commits it', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const { key, invoke } = transport(bytes);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (...args) => {
    if (args[0] === 'native_store_append') throw new Error('disk full');
    return original(...args);
  });
  const store = await NativeBookFileStore.connect(invoke);
  await expect(store.put(key, new Blob([bytes]))).rejects.toThrow('disk full');
  expect(invoke.mock.calls.at(-1)).toEqual(['native_store_abort', { token }]);
  expect(invoke.mock.calls.some(([command]) => command === 'native_store_commit')).toBe(false);
});

it('reads bounded binary chunks, validates hash and reports durable native storage honestly', async () => {
  const bytes = new Uint8Array(CHUNK_BYTES + 3).fill(71);
  const { key, invoke } = transport(bytes);
  const store = await NativeBookFileStore.connect(invoke);
  // Compare every byte natively; walking 256 KiB through the assertion engine
  // can dominate this transport test under parallel browser/build workloads.
  const actual = Buffer.from(await (await store.get(key)).arrayBuffer());
  expect(actual.equals(Buffer.from(bytes))).toBe(true);
  expect(invoke.mock.calls.filter(([command]) => command === 'native_store_read')).toEqual([
    ['native_store_read', { key, offset: 0, length: CHUNK_BYTES }],
    ['native_store_read', { key, offset: CHUNK_BYTES, length: 3 }],
  ]);
  expect(store.kind).toBe('native');
  expect(store.durable).toBe(true);
  expect(await store.estimate()).toEqual({ usageBytes: null, quotaBytes: null, persisted: true });
  expect(await store.keys()).toEqual([key]);
});

it('rejects corrupt or truncated original reads before exposing a blob', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const { key, invoke } = transport(bytes);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (...args) =>
    args[0] === 'native_store_read' ? new Uint8Array([3, 2, 1]).buffer : original(...args),
  );
  const store = await NativeBookFileStore.connect(invoke);
  await expect(store.get(key)).rejects.toThrow('SHA-256');
  invoke.mockImplementation(async (...args) =>
    args[0] === 'native_store_read' ? new Uint8Array([1, 2]).buffer : original(...args),
  );
  await expect(store.get(key)).rejects.toThrow('incomplete');
});

it('rejects unsafe keys and oversized metadata before any file IPC', async () => {
  const { key, invoke } = transport(new Uint8Array([1]));
  const store = await NativeBookFileStore.connect(invoke);
  invoke.mockClear();
  for (const key of ['../secret', 'books/probe.bin', 'covers/../x.png', 'covers/a.PNG']) {
    await expect(store.get(key)).rejects.toThrow('key');
    await expect(store.remove(key)).rejects.toThrow('key');
    await expect(store.put(key, new Blob(['x']))).rejects.toThrow('key');
  }
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockResolvedValue({ key, sizeBytes: metadata.maxOriginalBytes + 1 });
  await expect(store.get(key)).rejects.toThrow('information');
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('rejects incompatible native services and invalid file lists', async () => {
  await expect(
    NativeBookFileStore.connect(async () => ({ ...metadata, version: 2 })),
  ).rejects.toThrow('incompatible');
  const { key, invoke } = transport(new Uint8Array([1]));
  const store = await NativeBookFileStore.connect(invoke);
  invoke.mockResolvedValue([key, key]);
  await expect(store.keys()).rejects.toThrow('duplicate');
  invoke.mockResolvedValue(['../../outside']);
  await expect(store.keys()).rejects.toThrow('key');
});

it('detects native runtime without importing or invoking a native bridge in browsers', async () => {
  vi.stubGlobal('window', {});
  expect(isNativeRuntime()).toBe(false);
  await expect(NativeBookFileStore.connect()).rejects.toThrow('unavailable');
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  expect(isNativeRuntime()).toBe(true);
});

it('preserves useful Rust error messages for startup and file operations', async () => {
  await expect(
    NativeBookFileStore.connect(async () => {
      throw 'Native directory is not writable';
    }),
  ).rejects.toMatchObject({
    code: 'storage_unavailable',
    message: 'Native directory is not writable',
  });
  const { key, invoke } = transport(new Uint8Array([1]));
  const store = await NativeBookFileStore.connect(invoke);
  invoke.mockRejectedValue('Cannot open original: Permission denied');
  await expect(store.get(key)).rejects.toThrow('Cannot open original: Permission denied');
});
