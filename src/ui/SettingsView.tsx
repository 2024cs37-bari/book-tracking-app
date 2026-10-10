import { createResource, createSignal, For, Show } from 'solid-js';
import { LOCAL_MIGRATIONS, DB_SCHEMA_VERSION } from '~/data/db';
import { SYNC_META_KEYS } from '~/data/repositories/sync-meta-repository';
import { inspectStorage, removeStoredFiles, type OrphanReport } from '~/storage/maintenance';
import type { Shelf, Tag } from '~/domain/collections';
import { useApp } from '~/app/context';

interface Diagnostics {
  readonly lifecycle: Record<string, number>;
  readonly pendingChanges: number;
  readonly totalChanges: number;
  readonly oldestPending: number | null;
  readonly pullCursor: number;
  readonly referencedBytes: number;
  readonly orphans: OrphanReport;
  readonly shelves: readonly Shelf[];
  readonly tags: readonly Tag[];
  readonly storage: {
    usageBytes: number | null;
    quotaBytes: number | null;
    persisted: boolean | null;
  } | null;
}

export default function SettingsView() {
  const app = useApp();
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal<string | null>(null);

  const [diagnostics, { refetch }] = createResource<Diagnostics, number>(
    () => Date.now(),
    async () => {
      const [
        lifecycle,
        pendingChanges,
        totalChanges,
        oldestPending,
        pullCursor,
        referencedBytes,
        orphans,
        storage,
        shelves,
        tags,
      ] = await Promise.all([
        app.books.countByLifecycle(),
        app.changes.pendingCount(),
        app.changes.totalCount(),
        app.changes.oldestPendingCreatedAt(),
        app.syncMeta.getPullCursor(),
        app.books.referencedBytes(),
        inspectStorage(app.db, app.files),
        app.files.estimate(),
        app.shelves.list(),
        app.tags.list(),
      ]);
      return {
        lifecycle,
        pendingChanges,
        totalChanges,
        oldestPending,
        pullCursor,
        referencedBytes,
        orphans,
        shelves,
        tags,
        storage,
      };
    },
  );

  async function runExport(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const summary = await app.exports.download();
      setMessage(
        `Exported ${summary.bookCount} books and ${summary.progressCount} reading-state rows to ${summary.filename}.`,
      );
    } catch (error) {
      setMessage(`Export failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  }

  async function restoreFromFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (file === undefined) return;
    if (
      !window.confirm(
        'Restore from this backup? Books and reading data in the file are added to this ' +
          'library, and any item with the same id is overwritten. Items that exist only on ' +
          'this device are kept.',
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const summary = await app.restores.restore(await file.text());
      setMessage(
        `Restored ${summary.books} books, ${summary.progress} reading-state rows, ` +
          `${summary.shelves} shelves, ${summary.tags} tags, ${summary.annotations} annotations ` +
          `and ${summary.sessions} reading sessions from the backup.`,
      );
      await refetch();
    } catch (error) {
      setMessage(`Restore failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  }

  // Created on demand rather than via a hidden ref so the picker matches the
  // export button's programmatic-DOM approach and leaves no element behind.
  function pickBackup(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => void restoreFromFile(input));
    input.click();
  }

  async function cleanOrphans(): Promise<void> {
    const report = diagnostics()?.orphans;
    if (report === undefined || report.orphanKeys.length === 0) return;
    if (
      !window.confirm(`Remove ${report.orphanKeys.length} unreferenced file(s) from local storage?`)
    ) {
      return;
    }
    setBusy(true);
    try {
      const removed = await removeStoredFiles(app.files, report.orphanKeys);
      setMessage(`Removed ${removed} unreferenced file(s).`);
      await refetch();
    } catch (error) {
      setMessage(`Could not remove unreferenced files: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function renameShelf(id: string, currentName: string): Promise<void> {
    const next = window.prompt('Rename shelf', currentName);
    if (next === null || next.trim() === '' || next.trim() === currentName) return;
    setBusy(true);
    try {
      await app.shelves.rename(id, next);
      void app.persistClockState();
      await refetch();
    } catch (error) {
      setMessage(`Could not rename shelf: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteShelf(id: string, name: string): Promise<void> {
    if (!window.confirm(`Delete the shelf “${name}”? Books stay in the library.`)) return;
    setBusy(true);
    try {
      await app.shelves.remove(id);
      void app.persistClockState();
      await refetch();
    } catch (error) {
      setMessage(`Could not delete the shelf: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteTag(id: string, name: string): Promise<void> {
    if (!window.confirm(`Delete the tag “${name}”? It is removed from all books.`)) return;
    setBusy(true);
    try {
      await app.tags.remove(id);
      void app.persistClockState();
      await refetch();
    } catch (error) {
      setMessage(`Could not delete the tag: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="settings">
      <h2>Settings and diagnostics</h2>
      <p class="note">
        These values describe this device only. They are not synchronized and are safe to share when
        reporting a problem.
      </p>

      <Show when={diagnostics.error}>
        <p class="note note-error" role="alert">
          Diagnostics could not be collected: {String(diagnostics.error)}
        </p>
      </Show>

      <Show when={diagnostics()} fallback={<p class="note">Collecting diagnostics…</p>}>
        {(data) => (
          <>
            <section class="panel">
              <h3>Library</h3>
              <dl class="details-list">
                <dt>Active books</dt>
                <dd>{data().lifecycle.active ?? 0}</dd>
                <dt>Archived</dt>
                <dd>{data().lifecycle.archived ?? 0}</dd>
                <dt>Deleted (tombstoned)</dt>
                <dd>{data().lifecycle.deleted ?? 0}</dd>
                <dt>Total book rows</dt>
                <dd>{data().lifecycle.total ?? 0}</dd>
                <dt>Referenced file bytes</dt>
                <dd>{data().referencedBytes.toLocaleString()}</dd>
              </dl>
            </section>

            <section class="panel">
              <h3>Sync readiness</h3>
              <p class="note">
                Changes are queued locally. Nothing is uploaded: the server side is a later
                milestone, so a growing queue is expected and not a fault.
              </p>
              <dl class="details-list">
                <dt>Pending changes</dt>
                <dd>{data().pendingChanges}</dd>
                <dt>Oldest pending change</dt>
                <dd>
                  <Show when={data().oldestPending} fallback={<span>None</span>}>
                    {(oldest) => <span>{new Date(oldest()).toLocaleString()}</span>}
                  </Show>
                </dd>
                <dt>Total change-log rows</dt>
                <dd>{data().totalChanges}</dd>
                <dt>Pull cursor</dt>
                <dd>
                  {data().pullCursor === 0 ? 'Not started (no server yet)' : data().pullCursor}
                </dd>
                <dt>Device id</dt>
                <dd class="mono">{app.deviceId}</dd>
              </dl>
            </section>

            <section class="panel">
              <h3>Storage</h3>
              <dl class="details-list">
                <dt>File store</dt>
                <dd>
                  {app.files.kind}
                  {app.files.durable ? ' (durable)' : ' (not durable)'}
                </dd>
                <dt>Persistent storage granted</dt>
                <dd>
                  {app.persistentStorage === null
                    ? 'Not requested'
                    : app.persistentStorage
                      ? 'Yes'
                      : 'No — the browser may clear this data'}
                </dd>
                <Show when={data().storage}>
                  {(storage) => (
                    <>
                      <dt>Browser-reported usage</dt>
                      <dd>
                        <Show when={storage().usageBytes} fallback={<span>Unavailable</span>}>
                          {(usage) => <span>{formatBytes(usage())}</span>}
                        </Show>
                      </dd>
                      <dt>Browser-reported quota</dt>
                      <dd>
                        <Show when={storage().quotaBytes} fallback={<span>Unavailable</span>}>
                          {(quota) => <span>{formatBytes(quota())}</span>}
                        </Show>
                      </dd>
                    </>
                  )}
                </Show>
                <dt>Unreferenced files</dt>
                <dd>{data().orphans.orphanKeys.length}</dd>
                <dt>Books missing a local file</dt>
                <dd>{data().orphans.unreachableBooks.length}</dd>
              </dl>

              <Show when={data().orphans.orphanKeys.length > 0}>
                <div class="panel-actions">
                  <button
                    type="button"
                    class="button"
                    disabled={busy()}
                    onClick={() => void cleanOrphans()}
                  >
                    Remove unreferenced files
                  </button>
                </div>
              </Show>
            </section>

            <section class="panel">
              <h3>Reader support</h3>
              <p class="note">
                Formats are registered as renderer adapters are implemented. EPUB and PDF are
                supported (experimental); other formats import but are not yet readable.
              </p>
              <dl class="details-list">
                <dt>Registered renderers</dt>
                <dd>
                  <Show
                    when={app.renderers.list().length > 0}
                    fallback={<span>None yet — reading is not implemented</span>}
                  >
                    <span>
                      {app.renderers
                        .list()
                        .map((factory) => factory.engine)
                        .join(', ')}
                    </span>
                  </Show>
                </dd>
              </dl>
            </section>

            <section class="panel">
              <h3>Collections</h3>
              <div class="collections-group">
                <h4>Shelves ({data().shelves.length})</h4>
                <Show
                  when={data().shelves.length > 0}
                  fallback={
                    <p class="note">No shelves yet. Add books to shelves from a book's page.</p>
                  }
                >
                  <ul class="manage-list">
                    <For each={data().shelves}>
                      {(shelf) => (
                        <li class="manage-row">
                          <span>{shelf.name}</span>
                          <span class="manage-actions">
                            <button
                              type="button"
                              class="button"
                              disabled={busy()}
                              onClick={() => void renameShelf(shelf.id, shelf.name)}
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              class="button button-danger"
                              disabled={busy()}
                              onClick={() => void deleteShelf(shelf.id, shelf.name)}
                            >
                              Delete
                            </button>
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
              <div class="collections-group">
                <h4>Tags ({data().tags.length})</h4>
                <Show
                  when={data().tags.length > 0}
                  fallback={<p class="note">No tags yet. Add tags from a book's page.</p>}
                >
                  <ul class="chip-list">
                    <For each={data().tags}>
                      {(tag) => (
                        <li>
                          <span class="chip chip-active">
                            {tag.name}
                            <button
                              type="button"
                              class="chip-remove"
                              aria-label={`Delete tag ${tag.name}`}
                              disabled={busy()}
                              onClick={() => void deleteTag(tag.id, tag.name)}
                            >
                              ×
                            </button>
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            </section>

            <section class="panel">
              <h3>Data</h3>
              <p class="note">
                Export is generated locally and never contacts a server. It includes books, reading
                progress, shelves, tags, annotations and reading sessions. Restore reads an export
                file back into this library.
              </p>
              <div class="panel-actions">
                <button
                  type="button"
                  class="button button-primary"
                  disabled={busy()}
                  onClick={() => void runExport()}
                >
                  Export library as JSON
                </button>
                <button type="button" class="button" disabled={busy()} onClick={() => pickBackup()}>
                  Restore from backup…
                </button>
              </div>
            </section>

            <section class="panel">
              <h3>Local schema</h3>
              <dl class="details-list">
                <dt>Current version</dt>
                <dd>{DB_SCHEMA_VERSION}</dd>
                <dt>Clock state key</dt>
                <dd class="mono">{SYNC_META_KEYS.clockState}</dd>
              </dl>
              <ol class="migration-list">
                <For each={LOCAL_MIGRATIONS}>
                  {(migration) => (
                    <li>
                      <strong>v{migration.version}</strong> — {migration.description}
                    </li>
                  )}
                </For>
              </ol>
            </section>

            <Show when={message()}>
              {(text) => (
                <p class="note note-result" role="status">
                  {text()}
                </p>
              )}
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
