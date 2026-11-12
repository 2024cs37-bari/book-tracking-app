type CloseGuard = () => Promise<boolean>;
const guards = new Set<CloseGuard>();

/** Readers and local queues can delay native shutdown until their writes commit. */
export function registerNativeCloseGuard(guard: CloseGuard): () => void {
  guards.add(guard);
  return () => guards.delete(guard);
}

export function createNativeCloseHandler(dependencies: {
  guards(): readonly CloseGuard[];
  confirm(): boolean | Promise<boolean>;
  close(): Promise<void>;
  timeoutMs?: number;
}): (event: { preventDefault(): void }) => Promise<void> {
  let closing = false;
  return async (event) => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const writes = Promise.all(
        dependencies.guards().map(async (guard) => {
          try {
            return await guard();
          } catch {
            return false;
          }
        }),
      ).then((results) => results.every(Boolean));
      const saved = await Promise.race([
        writes,
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), dependencies.timeoutMs ?? 10_000);
        }),
      ]);
      clearTimeout(timer);
      if (saved || (await dependencies.confirm())) await dependencies.close();
    } finally {
      clearTimeout(timer);
      closing = false;
    }
  };
}

export async function installNativeCloseHandling(): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const window = getCurrentWindow();
  const handler = createNativeCloseHandler({
    guards: () => [...guards],
    confirm: async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      return (await invoke('native_confirm_close')) === true;
    },
    close: () => window.destroy(),
  });
  await window.onCloseRequested((event) =>
    handler(event).catch(() => {
      globalThis.alert('The desktop window could not close. Your library remains open; try again.');
    }),
  );
}
