import { isNativeRuntime } from './native-file-store';

/** Resolves after a native save completes, or after the browser accepts its download. */
export async function saveFile(blob: Blob, filename: string): Promise<void> {
  if (isNativeRuntime()) {
    const { saveNativeFile } = await import('./native-save-file');
    await saveNativeFile(blob, filename);
    return;
  }
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.click();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
