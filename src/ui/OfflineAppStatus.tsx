import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { offlineAppStatus } from '~/app/service-worker';

/** Shell readiness is separate from book-file availability and cloud sync. */
export default function OfflineAppStatus() {
  const [online, setOnline] = createSignal(true);
  onMount(() => {
    const update = (): void => {
      setOnline(navigator.onLine);
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    onCleanup(() => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    });
  });
  const message = () => {
    switch (offlineAppStatus()) {
      case 'installing':
        return 'Preparing the app for offline reading…';
      case 'ready':
        return online()
          ? 'App ready offline. Save books locally to read them offline.'
          : 'Offline. Locally saved books are available.';
      case 'update-ready':
        return 'An app update is ready. Finish reading, then close all app tabs and windows to apply it.';
      case 'unavailable':
        return 'Offline app caching is unavailable. Your locally saved books are unchanged.';
      default:
        return '';
    }
  };
  return (
    <Show when={message()}>
      <p class="note" role="status" aria-live="polite">
        {message()}
      </p>
    </Show>
  );
}
