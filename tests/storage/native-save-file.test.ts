import { expect, it, vi } from 'vitest';
import { saveNativeFile } from '~/storage/native-save-file';
import type { NativeInvoke } from '~/storage/native-file-store';
import { sha256Blob } from '~/storage/sha256';

const token = '11111111-1111-4111-8111-111111111111';

it('sends checked bounded bytes to an opaque dialog token and waits for commit', async () => {
  const blob = new Blob([new Uint8Array(256 * 1024 + 7).fill(42)]);
  const invoke = vi.fn<NativeInvoke>(async (command) =>
    command === 'native_export_begin' ? token : null,
  );
  await saveNativeFile(blob, 'backup.zip', invoke);
  expect(invoke.mock.calls[0]).toEqual([
    'native_export_begin',
    { filename: 'backup.zip', sizeBytes: blob.size, sha256: await sha256Blob(blob) },
  ]);
  const appends = invoke.mock.calls.filter(([command]) => command === 'native_export_append');
  expect(appends.map(([, bytes]) => (bytes as Uint8Array).length)).toEqual([256 * 1024, 7]);
  expect(appends.map(([, , options]) => options?.headers['x-book-offset'])).toEqual([
    '0',
    String(256 * 1024),
  ]);
  expect(invoke.mock.calls.at(-1)).toEqual(['native_export_commit', { token }]);
});

it('treats chooser cancellation as no export and never writes a file', async () => {
  const invoke = vi.fn<NativeInvoke>(async () => null);
  await expect(saveNativeFile(new Blob(['backup']), 'backup.zip', invoke)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(invoke).toHaveBeenCalledOnce();
});

it('aborts partial native saves and surfaces Rust error strings as useful errors', async () => {
  const invoke = vi.fn<NativeInvoke>(async (command) => {
    if (command === 'native_export_begin') return token;
    if (command === 'native_export_append') throw 'Disk full';
    return null;
  });
  await expect(saveNativeFile(new Blob(['backup']), 'backup.zip', invoke)).rejects.toThrow(
    'Disk full',
  );
  expect(invoke.mock.calls.at(-1)).toEqual(['native_export_abort', { token }]);
  expect(invoke.mock.calls.some(([command]) => command === 'native_export_commit')).toBe(false);
});

it('refuses malformed tokens and oversized files before any native byte writes', async () => {
  const invoke = vi.fn<NativeInvoke>(async () => '/tmp/unsafe-path');
  await expect(saveNativeFile(new Blob(['backup']), 'backup.zip', invoke)).rejects.toThrow('token');
  expect(invoke).toHaveBeenCalledOnce();
  invoke.mockClear();
  const oversized = { size: 256 * 1024 * 1024 + 1 } as Blob;
  await expect(saveNativeFile(oversized, 'backup.zip', invoke)).rejects.toThrow('256 MiB');
  expect(invoke).not.toHaveBeenCalled();
});
