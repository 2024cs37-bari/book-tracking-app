import { useLibraryRevision } from './use-library-revision';
import { createResource, createSignal, Show } from 'solid-js';
import { useApp } from '~/app/context';
import Icon from './Icon';

const BUDGET_KEY = 'book-reader:cache-budget-mib';
function loadBudget(): string {
  try {
    return localStorage.getItem(BUDGET_KEY) ?? '1024';
  } catch {
    return '1024';
  }
}

export function OfflineStoragePanel(props: { onChanged?: () => void | Promise<void> }) {
  const app = useApp();
  const revision = useLibraryRevision();
  const [summary, { refetch }] = createResource(revision, () => app.offline.summary());
  const [budget, setBudget] = createSignal(loadBudget());
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [failed, setFailed] = createSignal(false);

  async function clean(): Promise<void> {
    setMessage('');
    setFailed(false);
    const mib = Number(budget());
    if (!Number.isInteger(mib) || mib < 0 || mib > 1_048_576) {
      setMessage('Enter a whole number of MiB between 0 and 1048576.');
      setFailed(true);
      return;
    }
    setBusy(true);
    try {
      localStorage.setItem(BUDGET_KEY, String(mib));
      const result = await app.offline.trimToBudget(mib * 1024 * 1024);
      setMessage(
        `Freed ${(result.freedBytes / (1024 * 1024)).toFixed(1)} MiB from ${result.removedBooks} books.` +
          (result.targetMet
            ? ' Storage target reached.'
            : ' Protected books were kept; the target could not be reached.'),
      );
      await refetch();
      await props.onChanged?.();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : 'Could not free local space.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="settings-section settings-storage" aria-labelledby="offline-heading">
      <h2 id="offline-heading">Offline books and storage</h2>
      <p class="settings-description">
        Pin a downloaded book from its details page to keep it on this device.{' '}
        {app.files.kind === 'native'
          ? 'Keep a backup outside the application to protect against device loss.'
          : 'Browser site-data clearing can still remove pinned files; keep a backup outside the browser.'}
      </p>
      <Show when={summary()}>
        {(value) => (
          <dl class="settings-storage-totals">
            <div>
              <dt>On this device</dt>
              <dd>
                {value().localBooks} <span>books</span>
              </dd>
            </div>
            <div>
              <dt>Original files</dt>
              <dd>
                {(value().localBytes / (1024 * 1024)).toFixed(1)} <span>MiB</span>
              </dd>
            </div>
            <div>
              <dt>Pinned</dt>
              <dd>
                {value().pinnedBooks} <span>books</span>
              </dd>
            </div>
          </dl>
        )}
      </Show>
      <Show when={summary.error}>
        <p class="note note-error" role="alert">
          Storage totals could not be read.
        </p>
      </Show>
      <details class="settings-disclosure">
        <summary>
          <span>Manage local storage</span>
          <Icon name="chevron-down" size={16} />
        </summary>
        <div class="settings-disclosure-content">
          <p class="note">
            Free space removes the least recently opened, unpinned local originals until the target
            is reached. Each removal requires a verified copy on your configured server. Open books,
            tombstoned originals, metadata, covers and annotations are kept.
          </p>
          <div class="field">
            <label for="cache-budget">Target original-file storage (MiB)</label>
            <input
              id="cache-budget"
              type="number"
              min="0"
              max="1048576"
              step="1"
              value={budget()}
              onInput={(event) => setBudget(event.currentTarget.value)}
              disabled={busy()}
            />
          </div>
          <button
            type="button"
            class="button"
            disabled={busy() || app.fileTransfer === null}
            onClick={() => void clean()}
          >
            {busy() ? 'Checking safe removals…' : 'Free local space'}
          </button>
          <Show when={app.fileTransfer === null}>
            <p class="note">Configure sync before freeing local originals.</p>
          </Show>
          <Show when={message()}>
            <p
              class="note"
              classList={{ 'note-error': failed() }}
              role={failed() ? 'alert' : 'status'}
            >
              {message()}
            </p>
          </Show>
        </div>
      </details>
    </section>
  );
}
