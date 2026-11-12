import { isNativeRuntime } from '~/storage/native-file-store';
import { createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import { useApp } from '~/app/context';
import type { BackgroundStatus, BackgroundState } from '~/sync/background';
import { useLibraryRevision } from './use-library-revision';

const STATUS_LABEL: Record<BackgroundState, string> = {
  idle: 'Up to date',
  running: 'Syncing',
  offline: 'Offline — changes stay on this device',
  waiting: 'Waiting for the next sync',
  paused: 'Paused',
  'auth-required': 'Sign-in required',
  error: 'Action needed',
};

export function SyncPanel() {
  const app = useApp();
  const revision = useLibraryRevision();
  const [status, setStatus] = createSignal<BackgroundStatus>(
    app.background?.getStatus() ?? { state: 'idle' },
  );
  if (app.background) onCleanup(app.background.subscribe((next) => setStatus(next)));
  const [message, setMessage] = createSignal('');
  const [jobs, { refetch }] = createResource(revision, async () => {
    const [rows, books] = await Promise.all([
      app.fileTransfers.listAll(),
      app.books.list({ lifecycle: 'all' }),
    ]);
    const titles = new Map(books.map((book) => [book.sha256, book.title]));
    return rows
      .filter((row) => row.state !== 'complete')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((row) => ({ ...row, title: titles.get(row.sha256) ?? 'Original book file' }));
  });

  async function retry(): Promise<void> {
    setMessage('');
    try {
      await app.background?.retryNow();
      await refetch();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Sync could not be started.');
    }
  }
  async function cancel(id: string): Promise<void> {
    try {
      if (app.fileTransfer) await app.fileTransfer.cancel(id);
      else await app.fileTransfers.cancel(id);
      await refetch();
    } catch {
      setMessage('The transfer could not be cancelled.');
    }
  }

  return (
    <section class="settings-section settings-sync" aria-labelledby="sync-heading">
      <h2 id="sync-heading">Sync</h2>
      <Show
        when={app.background !== null}
        fallback={
          <p class="settings-description">
            {isNativeRuntime()
              ? 'Desktop synchronization is not available in this build. Your library stays on this device; use portable backups for recovery and transfer.'
              : 'Sync is not configured for this build. Changes are queued locally and will upload once a sync server is set.'}
          </p>
        }
      >
        <p class="settings-description">
          Your library syncs in the background while this app is open. Local originals are backed up
          after metadata sync; remote originals download when you request them.
        </p>
        <dl class="details-list">
          <dt>Status</dt>
          <dd role="status" class="settings-sync-status" data-state={status().state}>
            {status().state === 'idle' && status().lastSuccessAt === undefined
              ? 'Ready to sync'
              : STATUS_LABEL[status().state]}
          </dd>
          <dt>Last successful metadata sync</dt>
          <dd>
            {status().lastSuccessAt === undefined
              ? 'Not yet recorded'
              : new Date(status().lastSuccessAt!).toLocaleString()}
          </dd>
          <Show when={status().nextAttemptAt !== undefined}>
            <dt>Next attempt</dt>
            <dd>{new Date(status().nextAttemptAt!).toLocaleTimeString()}</dd>
          </Show>
        </dl>
        <Show when={status().error}>
          <p class="note note-error" role="alert">
            {status().error}
          </p>
        </Show>
        <Show when={status().state === 'auth-required'}>
          <p class="note">
            Sign in through your configured Cloudflare Access application, then retry. Local changes
            have been kept.
          </p>
        </Show>
        <div class="panel-actions">
          <button
            type="button"
            class="button"
            disabled={status().state === 'running'}
            onClick={() => void retry()}
          >
            Sync now
          </button>
          <button
            type="button"
            class="button"
            onClick={() => {
              if (status().state === 'paused') app.background?.resume();
              else app.background?.pause();
            }}
          >
            {status().state === 'paused' ? 'Resume automatic sync' : 'Pause automatic sync'}
          </button>
        </div>
      </Show>
      <Show when={(jobs()?.length ?? 0) > 0}>
        <h3>File transfers ({jobs()?.length})</h3>
        <p class="note">Cancellation stops future work; an upload already sent may finish.</p>
        <ul class="manage-list">
          <For each={(jobs() ?? []).slice(0, 50)}>
            {(job) => (
              <li class="manage-row">
                <div>
                  <strong>{job.title}</strong>
                  <p class="note">
                    {job.direction} — {job.state}
                    {job.error ? `: ${job.error}` : ''}
                  </p>
                </div>
                <Show when={job.state !== 'cancelled'}>
                  <button type="button" class="button" onClick={() => void cancel(job.id)}>
                    Cancel transfer
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={(jobs()?.length ?? 0) > 50}>
          <p class="note">Showing the 50 most recent pending transfers.</p>
        </Show>
      </Show>
      <Show when={message()}>
        <p class="note note-error" role="alert">
          {message()}
        </p>
      </Show>
    </section>
  );
}
