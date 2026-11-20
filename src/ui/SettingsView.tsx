import '~/styles/settings-refinement.css';
import Icon from './Icon';
import Select from './Select';
import { isNativeRuntime } from '~/storage/native-file-store';
import { useLibraryRevision } from './use-library-revision';
import { createResource, createSignal, For, Show } from 'solid-js';
import { LOCAL_MIGRATIONS, DB_SCHEMA_VERSION, DB_LOCAL_VERSION } from '~/data/db';
import { SYNC_META_KEYS } from '~/data/repositories/sync-meta-repository';
import { inspectStorage, cleanOrphanFiles, type OrphanReport } from '~/storage/maintenance';
import { MAX_COLLECTION_NAME_LENGTH, type Shelf, type Tag } from '~/domain/collections';
import { useApp } from '~/app/context';
import { showToast } from './toast';
import { SyncPanel } from './SyncPanel';
import { BackupPanel } from './BackupPanel';
import { OfflineStoragePanel } from './OfflineStoragePanel';
import {
  dictionaryAllowed,
  dictionaryAvailable,
  setDictionaryAllowed,
} from '~/services/privacy-preferences';
import {
  ACCENT_PRESETS,
  applyAccent,
  applyTheme,
  loadAccent,
  loadTheme,
  type AppTheme,
} from './theme';

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
  const revision = useLibraryRevision();
  const [busy, setBusy] = createSignal(false);
  const [renaming, setRenaming] = createSignal<{ kind: 'shelf' | 'tag'; id: string } | null>(null);
  const [collectionName, setCollectionName] = createSignal('');
  let renameInput: HTMLInputElement | undefined;
  const [dictionaryEnabled, setDictionaryEnabled] = createSignal(dictionaryAllowed());
  // Status/error notifications surface as auto-dismissing toasts rather than a
  // lingering inline line; errors stay until the user dismisses them.
  function setMessage(text: string | null, kind: 'error' | 'success' = 'success'): void {
    if (text !== null) showToast(text, kind);
  }

  // Appearance is a device-local preference (like reader settings), applied to
  // the document root and persisted; see src/ui/theme.ts.
  const [theme, setTheme] = createSignal<AppTheme>(loadTheme());
  const [accent, setAccent] = createSignal(loadAccent());
  function changeTheme(next: AppTheme): void {
    setTheme(next);
    applyTheme(next);
  }
  function changeAccent(next: string): void {
    setAccent(next);
    applyAccent(next);
  }

  const [diagnostics, { refetch }] = createResource<Diagnostics, number>(revision, async () => {
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
  });

  async function refreshDiagnostics(): Promise<void> {
    await refetch();
  }

  async function exportDiagnostics(): Promise<void> {
    setBusy(true);
    try {
      await app.diagnostics.download();
      setMessage('Diagnostics saved. No book content or account identifiers are included.');
    } catch {
      setMessage('Diagnostics could not be saved. Try again while this page is open.', 'error');
    } finally {
      setBusy(false);
    }
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
      const removed = await cleanOrphanFiles(app.db, app.files);
      setMessage(
        `Removed ${removed} unreferenced original(s). Referenced, open and unknown files were kept.`,
      );
      await refetch();
    } catch (error) {
      setMessage(`Could not remove unreferenced files: ${String(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  function beginRename(kind: 'shelf' | 'tag', id: string, name: string): void {
    setCollectionName(name);
    setRenaming({ kind, id });
    queueMicrotask(() => renameInput?.focus());
  }

  function finishRename(): void {
    const target = renaming();
    setRenaming(null);
    if (target !== null) {
      queueMicrotask(() => document.getElementById(`rename-${target.kind}-${target.id}`)?.focus());
    }
  }

  async function saveCollectionName(): Promise<void> {
    const target = renaming();
    if (target === null || busy()) return;
    setBusy(true);
    try {
      if (target.kind === 'tag') await app.tags.rename(target.id, collectionName());
      else await app.shelves.rename(target.id, collectionName());
      void app.persistClockState();
      await refetch();
      finishRename();
      setMessage(`${target.kind === 'tag' ? 'Tag' : 'Shelf'} renamed. Book memberships are kept.`);
    } catch (error) {
      setMessage(`Could not rename ${target.kind}: ${String(error)}`, 'error');
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
      setMessage(`Could not delete the shelf: ${String(error)}`, 'error');
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
      setMessage(`Could not delete the tag: ${String(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="settings settings-refined" aria-labelledby="settings-title">
      <header class="settings-header">
        <h1 id="settings-title">Settings</h1>
        <p>These preferences belong to this device.</p>
      </header>
      <div class="settings-layout">
        <nav class="settings-navigation" aria-label="Settings sections">
          <span class="settings-navigation-label">On this page</span>
          <a href="#settings-appearance">Appearance &amp; privacy</a>
          <a href="#settings-collections">Collections</a>
          <a href="#settings-backups">Backups &amp; sync</a>
          <a href="#settings-storage">Storage</a>
          <a href="#settings-advanced">Advanced</a>
        </nav>
        <div class="settings-content">
          <section
            class="settings-section"
            id="settings-appearance"
            aria-labelledby="appearance-heading"
          >
            <h2 id="appearance-heading">Appearance</h2>
            <div class="settings-control-row">
              <div class="settings-control-copy">
                <label for="app-theme">Theme</label>
                <p>Follow your device, or choose your own.</p>
              </div>
              <Select<AppTheme>
                id="app-theme"
                value={theme()}
                onChange={changeTheme}
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
              />
            </div>
            <div class="settings-control-row">
              <div class="settings-control-copy">
                <span id="accent-label">Accent colour</span>
              </div>
              <div class="accent-swatches" role="group" aria-labelledby="accent-label">
                <For each={ACCENT_PRESETS}>
                  {(preset) => (
                    <button
                      type="button"
                      class="accent-swatch"
                      classList={{ active: accent() === preset.value }}
                      style={preset.value === '' ? undefined : { background: preset.value }}
                      aria-label={preset.name}
                      aria-pressed={accent() === preset.value}
                      onClick={() => changeAccent(preset.value)}
                    >
                      <Show when={preset.value === '' && accent() === ''}>
                        <Icon name="check" size={14} />
                      </Show>
                    </button>
                  )}
                </For>
                <label class="accent-custom">
                  Custom
                  <input
                    type="color"
                    aria-label="Custom accent colour"
                    value={accent() === '' ? '#536343' : accent()}
                    onInput={(event) => changeAccent(event.currentTarget.value)}
                  />
                </label>
              </div>
            </div>
            <div class="settings-privacy">
              <h3>Privacy</h3>
              <label class="settings-toggle-row">
                <span>
                  <span class="settings-toggle-title">Allow online dictionary lookups</span>
                  <span class="settings-toggle-description">
                    Sends only your selected word to dictionaryapi.dev. Reading and annotations work
                    offline.
                  </span>
                </span>
                <input
                  type="checkbox"
                  aria-label="Allow online dictionary lookups"
                  checked={dictionaryEnabled()}
                  disabled={!dictionaryAvailable}
                  onChange={(event) => {
                    try {
                      setDictionaryAllowed(event.currentTarget.checked);
                      setDictionaryEnabled(event.currentTarget.checked);
                    } catch {
                      setMessage('The dictionary preference could not be saved.', 'error');
                    }
                  }}
                />
              </label>
              <Show when={!dictionaryAvailable}>
                <p class="note">Dictionary access is disabled for this build.</p>
              </Show>
            </div>
          </section>
          <Show when={diagnostics.error}>
            <p class="note note-error" role="alert">
              Library details could not be collected: {String(diagnostics.error)}
            </p>
          </Show>
          <Show
            when={diagnostics()}
            fallback={
              <Show when={!diagnostics.error}>
                <p class="note">Loading collections…</p>
              </Show>
            }
          >
            {(data) => (
              <section
                class="settings-section"
                id="settings-collections"
                aria-labelledby="collections-heading"
              >
                <h2 id="collections-heading">Collections</h2>
                <Show when={renaming()}>
                  {(target) => (
                    <form
                      class="settings-rename-form"
                      aria-label={`Rename ${target().kind}`}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveCollectionName();
                      }}
                    >
                      <div class="field">
                        <label for="collection-name">New {target().kind} name</label>
                        <input
                          id="collection-name"
                          type="text"
                          ref={(element) => {
                            renameInput = element;
                          }}
                          value={collectionName()}
                          maxLength={MAX_COLLECTION_NAME_LENGTH}
                          required
                          disabled={busy()}
                          onInput={(event) => setCollectionName(event.currentTarget.value)}
                        />
                      </div>
                      <div class="panel-actions">
                        <button type="submit" class="button button-primary" disabled={busy()}>
                          Save name
                        </button>
                        <button
                          type="button"
                          class="button"
                          disabled={busy()}
                          onClick={finishRename}
                        >
                          Cancel rename
                        </button>
                      </div>
                    </form>
                  )}
                </Show>
                <div class="collections-group">
                  <h3>Shelves ({data().shelves.length})</h3>
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
                                id={`rename-shelf-${shelf.id}`}
                                aria-label={`Rename shelf ${shelf.name}`}
                                onClick={() => beginRename('shelf', shelf.id, shelf.name)}
                              >
                                Rename
                              </button>
                              <button
                                type="button"
                                class="button button-danger"
                                disabled={busy()}
                                aria-label={`Delete shelf ${shelf.name}`}
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
                  <h3>Tags ({data().tags.length})</h3>
                  <Show
                    when={data().tags.length > 0}
                    fallback={<p class="note">No tags yet. Add tags from a book's page.</p>}
                  >
                    <ul class="manage-list">
                      <For each={data().tags}>
                        {(tag) => (
                          <li class="manage-row">
                            <span>{tag.name}</span>
                            <span class="manage-actions">
                              <button
                                type="button"
                                class="button"
                                id={`rename-tag-${tag.id}`}
                                aria-label={`Rename tag ${tag.name}`}
                                disabled={busy()}
                                onClick={() => beginRename('tag', tag.id, tag.name)}
                              >
                                Rename
                              </button>
                              <button
                                type="button"
                                class="button button-danger"
                                aria-label={`Delete tag ${tag.name}`}
                                disabled={busy()}
                                onClick={() => void deleteTag(tag.id, tag.name)}
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
              </section>
            )}
          </Show>
          <div id="settings-backups" class="settings-anchor">
            <BackupPanel disabled={busy()} onRestored={refreshDiagnostics} />
            <SyncPanel />
          </div>
          <div id="settings-storage" class="settings-anchor">
            <OfflineStoragePanel onChanged={refreshDiagnostics} />
          </div>
          <details class="settings-disclosure settings-advanced" id="settings-advanced">
            <summary>
              <span>
                <span class="settings-summary-heading" role="heading" aria-level="2">
                  Advanced diagnostics
                </span>
                <span class="settings-summary-description">
                  Device details, storage maintenance and troubleshooting
                </span>
              </span>
              <Icon name="chevron-down" size={18} />
            </summary>
            <div class="settings-disclosure-content">
              <p class="note">
                A diagnostic report can help investigate a problem. It excludes book content,
                filenames, account identifiers and server addresses.
              </p>
              <button
                type="button"
                class="button"
                disabled={busy()}
                onClick={() => void exportDiagnostics()}
              >
                <Icon name="download" size={16} /> Download diagnostics
              </button>
              <Show when={diagnostics()} fallback={<p class="note">Collecting diagnostics…</p>}>
                {(data) => (
                  <div class="settings-diagnostics-grid">
                    <section class="settings-diagnostic-section">
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

                    <section class="settings-diagnostic-section">
                      <h3>Sync readiness</h3>
                      <p class="note">
                        {isNativeRuntime()
                          ? 'This desktop build stores changes locally. Native sign-in and synchronization are not yet available; keep portable backups outside this device.'
                          : 'Changes are saved locally before sync. When a sync server is configured, queued changes are sent to your private library there.'}
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
                        <dd>{data().pullCursor === 0 ? 'Not started' : data().pullCursor}</dd>
                        <dt>Device id</dt>
                        <dd class="mono">{app.deviceId}</dd>
                      </dl>
                    </section>

                    <section class="settings-diagnostic-section">
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
                            ? 'Unknown or unavailable'
                            : app.persistentStorage
                              ? 'Yes'
                              : 'No — the browser may clear this data'}
                        </dd>
                        <Show when={data().storage}>
                          {(storage) => (
                            <>
                              <dt>Browser-reported usage</dt>
                              <dd>
                                <Show
                                  when={storage().usageBytes}
                                  fallback={<span>Unavailable</span>}
                                >
                                  {(usage) => <span>{formatBytes(usage())}</span>}
                                </Show>
                              </dd>
                              <dt>Browser-reported quota</dt>
                              <dd>
                                <Show
                                  when={storage().quotaBytes}
                                  fallback={<span>Unavailable</span>}
                                >
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
                            Remove unreferenced originals
                          </button>
                        </div>
                      </Show>
                    </section>

                    <section class="settings-diagnostic-section">
                      <h3>Reader support</h3>
                      <p class="note">
                        Formats are registered as renderer adapters are implemented. EPUB and PDF
                        are supported (experimental); other formats import but are not yet readable.
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

                    <section class="settings-diagnostic-section">
                      <h3>Local schema</h3>
                      <dl class="details-list">
                        <dt>Local database version</dt>
                        <dd>{DB_LOCAL_VERSION}</dd>
                        <dt>Sync and export schema</dt>
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
                  </div>
                )}
              </Show>
            </div>
          </details>
        </div>
      </div>
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
