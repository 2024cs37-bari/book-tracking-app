import { createSignal, For, Show, untrack } from 'solid-js';
import { useApp } from '~/app/context';
import type { PreparedRestore } from '~/services/restore-service';
import Icon from './Icon';

/** A validated recovery preview is the only path to the apply action. */
export function BackupPanel(props: {
  onRestored?: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const app = useApp();
  const [busy, setBusy] = createSignal(false);
  const [preview, setPreview] = createSignal<PreparedRestore | null>(null);
  const [filename, setFilename] = createSignal('');
  const [message, setMessage] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      await action();
    } catch (error) {
      setFailed(true);
      setMessage(
        error instanceof Error
          ? error.message
          : 'The backup operation failed. Your current library was kept.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function prepare(file: File): Promise<void> {
    setPreview(null);
    setFilename(file.name);
    await run(async () => {
      setPreview(await app.restores.prepare(file));
    });
  }

  async function apply(selected: PreparedRestore): Promise<void> {
    // An apply failure may follow a concurrent library change. Require a fresh
    // selection/preview instead of reusing stale numbers or retaining bytes.
    setPreview(null);
    await run(async () => {
      const result = await app.restores.apply(selected);
      setMessage(
        `Recovered ${result.books} books, ${result.progress} reading positions, ${result.annotations} annotations, ${result.shelves} shelves, ${result.tags} tags and ${result.sessions} sessions. Restored ${result.filesRestored} original files; preserved ${result.preservedRows} existing records.`,
      );
      await untrack(() => props.onRestored?.());
    });
  }

  return (
    <section class="settings-section settings-backup" aria-labelledby="backup-heading">
      <h2 id="backup-heading">Backup and recovery</h2>
      <p class="settings-description">
        Keep a copy of your books, notes and reading progress somewhere safe, outside this app and
        device.
      </p>
      <div class="panel-actions">
        <button
          type="button"
          class="button button-primary"
          disabled={busy() || props.disabled}
          onClick={() =>
            void run(async () => {
              const name = await app.exports.downloadPortable();
              setMessage(
                `Portable backup ready: ${name}. Keep it in a safe location outside this app and device.`,
              );
            })
          }
        >
          <Icon name="download" size={17} /> Download portable backup
        </button>
        <button
          type="button"
          class="button"
          disabled={busy() || props.disabled}
          onClick={() => fileInput?.click()}
        >
          Restore from backup…
        </button>
        <input
          ref={(element) => {
            fileInput = element;
          }}
          type="file"
          accept="application/json,application/zip,.json,.zip"
          hidden
          aria-label="Select a backup file"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void prepare(file);
          }}
        />
      </div>
      <details class="settings-disclosure settings-backup-options">
        <summary>
          <span>Backup options &amp; limits</span>
          <Icon name="chevron-down" size={16} />
        </summary>
        <div class="settings-disclosure-content">
          <p class="note">
            Portable backups include original books, covers, reading progress, annotations,
            collections and sessions. They support up to 128 MiB total and 64 MiB per original.
            Every book must be downloaded on this device first.
          </p>
          <p class="note">
            For larger libraries, export your metadata as JSON and keep your original files
            separately. JSON exports do not include book files.
          </p>
          <button
            type="button"
            class="button"
            disabled={busy() || props.disabled}
            onClick={() =>
              void run(async () => {
                const result = await app.exports.download();
                setMessage(
                  `Exported metadata for ${result.bookCount} books to ${result.filename}. Original book files are not included.`,
                );
              })
            }
          >
            <Icon name="download" size={16} /> Export library as JSON
          </button>
        </div>
      </details>
      <Show when={busy()}>
        <p class="note" role="status">
          Checking files and processing your backup… Keep this page open.
        </p>
      </Show>
      <Show when={message()}>
        {(text) => (
          <p
            class="note"
            classList={{ 'note-error': failed() }}
            role={failed() ? 'alert' : 'status'}
          >
            {text()}
          </p>
        )}
      </Show>
      <Show when={preview()}>
        {(selected) => (
          <section class="backup-preview" aria-labelledby="recovery-preview-heading">
            <h3 id="recovery-preview-heading">Review recovery: {filename()}</h3>
            <dl class="details-list">
              <dt>Backup type</dt>
              <dd>
                {selected().kind === 'portable'
                  ? 'Portable — metadata and verified originals'
                  : 'JSON — metadata only'}
              </dd>
              <dt>Books to add</dt>
              <dd>{selected().booksToAdd}</dd>
              <dt>Existing books preserved</dt>
              <dd>{selected().existingBooks}</dd>
              <dt>Total records to add</dt>
              <dd>{selected().recordsToAdd}</dd>
              <dt>Existing records preserved</dt>
              <dd>{selected().recordsPreserved}</dd>
              <dt>Originals in backup</dt>
              <dd>{selected().originalFiles}</dd>
              <dt>Books still missing originals</dt>
              <dd>{selected().missingOriginalFiles}</dd>
              <dt>New file storage required</dt>
              <dd>{(selected().bytesToRestore / (1024 * 1024)).toFixed(1)} MiB</dd>
            </dl>
            <For each={selected().warnings}>{(warning) => <p class="note">{warning}</p>}</For>
            <div class="panel-actions">
              <button
                type="button"
                class="button button-primary"
                disabled={busy() || props.disabled}
                onClick={() => void apply(selected())}
              >
                Add missing data from backup
              </button>
              <button
                type="button"
                class="button"
                disabled={busy()}
                onClick={() => setPreview(null)}
              >
                Cancel recovery
              </button>
            </div>
          </section>
        )}
      </Show>
    </section>
  );
}
