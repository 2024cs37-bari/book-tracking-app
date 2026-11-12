import { createSignal } from 'solid-js';
import { isNativeRuntime } from '~/storage/native-file-store';

export type OfflineAppStatus = 'disabled' | 'installing' | 'ready' | 'update-ready' | 'unavailable';
const [offlineAppStatus, setOfflineAppStatus] = createSignal<OfflineAppStatus>('disabled');
export { offlineAppStatus };

/** Cache the shell and observe updates. Never activate an update or reload a reader. */
export async function registerOfflineApp(): Promise<void> {
  if (isNativeRuntime()) {
    // Desktop assets ship inside the executable and must not be shadowed by
    // an older service-worker shell after a native app upgrade.
    setOfflineAppStatus('ready');
    return;
  }
  if (!('serviceWorker' in navigator)) {
    setOfflineAppStatus('unavailable');
    return;
  }
  setOfflineAppStatus('installing');
  try {
    const registration = await navigator.serviceWorker.register(
      `${import.meta.env.BASE_URL}sw.js`,
      {
        updateViaCache: 'none',
      },
    );
    const refresh = (): void => {
      if (registration.waiting) setOfflineAppStatus('update-ready');
      else if (registration.active) setOfflineAppStatus('ready');
      else if (!registration.installing) setOfflineAppStatus('unavailable');
    };
    const watchInstalling = (): void => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', refresh);
      refresh();
    };
    registration.addEventListener('updatefound', watchInstalling);
    navigator.serviceWorker.addEventListener('controllerchange', refresh);
    watchInstalling();
    // Built-in browser checks also run on navigation. A long-lived reader gets
    // a check when brought back into view, at most once an hour.
    let checkedAt = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - checkedAt < 3_600_000) return;
      checkedAt = Date.now();
      void registration.update().catch(() => {
        /* Existing offline shell remains usable. */
      });
    });
  } catch {
    // Do not include URLs/tokens or raw browser errors in the product UI.
    setOfflineAppStatus('unavailable');
  }
}
