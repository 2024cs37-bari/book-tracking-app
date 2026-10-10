import { createSignal, For, type JSX } from 'solid-js';

export type ToastKind = 'error' | 'info' | 'success';

interface Toast {
  readonly id: number;
  readonly message: string;
  readonly kind: ToastKind;
}

const [toasts, setToasts] = createSignal<readonly Toast[]>([]);
let nextId = 0;

/**
 * App-wide transient notifications. Unlike an inline error that lingers until
 * something overwrites it, a toast announces, then auto-dismisses — the right
 * home for one-off failures and confirmations (errors stay until dismissed).
 */
export function showToast(message: string, kind: ToastKind = 'info'): void {
  const id = nextId;
  nextId += 1;
  setToasts((list) => [...list, { id, message, kind }]);
  if (kind !== 'error') {
    setTimeout(() => dismissToast(id), 6000);
  }
}

export function dismissToast(id: number): void {
  setToasts((list) => list.filter((toast) => toast.id !== id));
}

export function Toaster(): JSX.Element {
  return (
    <div class="toaster" aria-live="polite">
      <For each={toasts()}>
        {(toast) => (
          <div
            class={`toast toast-${toast.kind}`}
            role={toast.kind === 'error' ? 'alert' : 'status'}
          >
            <span class="toast-text">{toast.message}</span>
            <button
              type="button"
              class="toast-dismiss"
              aria-label="Dismiss notification"
              onClick={() => dismissToast(toast.id)}
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
