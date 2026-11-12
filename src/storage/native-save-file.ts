import { registerNativeCloseGuard } from '~/app/native-lifecycle';
import type { NativeInvoke } from './native-file-store';
import { sha256Blob } from './sha256';

const CHUNK_BYTES = 256 * 1024;
const MAX_BYTES = 256 * 1024 * 1024;

/** Rust owns the save dialog and destination; JS sends only verified bounded bytes. */
export async function saveNativeFile(
  blob: Blob,
  filename: string,
  invoke?: NativeInvoke,
): Promise<void> {
  if (blob.size > MAX_BYTES) throw new Error('Native exports are limited to 256 MiB.');
  if (!invoke) invoke = (await import('@tauri-apps/api/core')).invoke;
  let resolveFinished!: (saved: boolean) => void;
  const finished = new Promise<boolean>((resolve) => {
    resolveFinished = resolve;
  });
  const unregister = registerNativeCloseGuard(() => finished);
  let token: string | undefined;
  try {
    const sha256 = await sha256Blob(blob);
    const result = await invoke('native_export_begin', { filename, sizeBytes: blob.size, sha256 });
    if (result === null)
      throw new DOMException('Export cancelled. No file was saved.', 'AbortError');
    if (typeof result !== 'string' || !/^[a-f0-9-]{36}$/.test(result))
      throw new Error('The native export token is invalid.');
    token = result;
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
      if (bytes.length !== Math.min(CHUNK_BYTES, blob.size - offset))
        throw new Error('The export changed while it was being saved.');
      await invoke('native_export_append', bytes, {
        headers: { 'x-book-token': token, 'x-book-offset': String(offset) },
      });
    }
    await invoke('native_export_commit', { token });
    resolveFinished(true);
  } catch (error) {
    if (token) await invoke('native_export_abort', { token }).catch(() => {});
    // Failed exports preserve the previous destination; no local library write is lost.
    resolveFinished(true);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    unregister();
  }
}
