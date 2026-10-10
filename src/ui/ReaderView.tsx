import { A, useParams } from '@solidjs/router';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from 'solid-js';
import { useApp } from '~/app/context';
import type { Locator } from '~/domain/locator';
import type { Annotation } from '~/domain/annotation';
import type {
  ReaderPage,
  ReaderSettings,
  ReaderTheme,
  SearchHit,
  SelectionInfo,
  TocItem,
} from '~/reader/renderer';
import type { ReaderSession } from '~/services/reader-service';
import { buildNotesMarkdown, notesFilename } from '~/services/notes-markdown';
import ReaderContents from './ReaderContents';
import ReaderSidebar, { type SidebarTab } from './ReaderSidebar';
import ReaderPages from './ReaderPages';

const MAX_SEARCH_HITS = 200;
/** Reading spans shorter than this are noise and are not recorded as sessions. */
const MIN_SESSION_SECONDS = 5;

type SidebarPanel = 'contents' | 'pages' | 'notes' | 'search';
const SIDEBAR_TABS: readonly SidebarTab[] = [
  { id: 'contents', label: 'Contents' },
  { id: 'pages', label: 'Pages' },
  { id: 'notes', label: 'Notes' },
  { id: 'search', label: 'Search' },
];
const SIDEBAR_PREFS_KEY = 'reader-sidebar';

interface SidebarPrefs {
  readonly open: boolean;
  readonly panel: SidebarPanel;
  readonly width: number;
}

function loadSidebarPrefs(): SidebarPrefs {
  const fallback: SidebarPrefs = { open: true, panel: 'contents', width: 300 };
  try {
    const raw = localStorage.getItem(SIDEBAR_PREFS_KEY);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as Partial<SidebarPrefs>;
    return {
      open: typeof parsed.open === 'boolean' ? parsed.open : fallback.open,
      panel: SIDEBAR_TABS.some((tab) => tab.id === parsed.panel)
        ? (parsed.panel as SidebarPanel)
        : fallback.panel,
      width:
        typeof parsed.width === 'number' && parsed.width >= 220 && parsed.width <= 520
          ? parsed.width
          : fallback.width,
    };
  } catch {
    return fallback;
  }
}

function saveSidebarPrefs(prefs: SidebarPrefs): void {
  try {
    localStorage.setItem(SIDEBAR_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Per-viewer convenience only; a storage failure must not break reading.
  }
}

export default function ReaderView() {
  const app = useApp();
  const params = useParams();
  const [title, setTitle] = createSignal('Reader');
  const [message, setMessage] = createSignal('Opening book…');
  const [ready, setReady] = createSignal(false);
  const [fraction, setFraction] = createSignal(0);
  const [settings, setSettings] = createSignal(app.reader.loadSettings());
  const [toc, setToc] = createSignal<readonly TocItem[]>([]);
  const [tocLoading, setTocLoading] = createSignal(true);
  const [tocError, setTocError] = createSignal('');
  const [query, setQuery] = createSignal('');
  const [hits, setHits] = createSignal<readonly SearchHit[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searchStatus, setSearchStatus] = createSignal('');
  const [annotations, setAnnotations] = createSignal<readonly Annotation[]>([]);
  const [selection, setSelection] = createSignal<SelectionInfo | null>(null);
  const [canHighlight, setCanHighlight] = createSignal(false);
  const [pages, setPages] = createSignal<readonly ReaderPage[]>([]);
  const [supportsThumbnails, setSupportsThumbnails] = createSignal(false);
  const initialPrefs = loadSidebarPrefs();
  const [sidebarOpen, setSidebarOpen] = createSignal(initialPrefs.open);
  const [sidebarPanel, setSidebarPanel] = createSignal<SidebarPanel>(initialPrefs.panel);
  const [sidebarWidth, setSidebarWidth] = createSignal(initialPrefs.width);
  createEffect(() =>
    saveSidebarPrefs({ open: sidebarOpen(), panel: sidebarPanel(), width: sidebarWidth() }),
  );
  // Highlight the page/section at the current reading position: the last unit
  // whose fraction is at or before where we are.
  const currentPageIndex = createMemo(() => {
    const here = fraction();
    let index = -1;
    for (const page of pages()) if (page.locator.fraction <= here + 1e-9) index = page.index;
    return index;
  });
  let host!: HTMLDivElement;
  let session: ReaderSession | undefined;
  let searchController: AbortController | undefined;
  let currentLocator: Locator | undefined;

  function updateSettings(patch: Partial<ReaderSettings>): void {
    const next = { ...settings(), ...patch };
    setSettings(next);
    session?.renderer.applySettings(next);
    try {
      app.reader.saveSettings(next);
    } catch (error) {
      setMessage(`Settings could not be saved: ${String(error)}`);
    }
  }

  async function reloadAnnotations(bookId: string): Promise<void> {
    try {
      const list = await app.annotations.listByBook(bookId);
      setAnnotations(list);
      // Keep the renderer's drawn overlays in step with stored highlights; it
      // re-draws them per section as the reader navigates.
      session?.renderer.applyHighlights(
        list
          .filter((annotation) => annotation.kind === 'highlight')
          .map((annotation) => ({
            id: annotation.id,
            locator: annotation.locator,
            color: annotation.color,
          })),
      );
    } catch {
      // Annotations are optional; a load failure must not break reading.
    }
  }

  async function addHighlight(): Promise<void> {
    const selected = selection();
    if (selected === null) return;
    try {
      await app.annotations.create({
        bookId: params.id ?? '',
        kind: 'highlight',
        locator: selected.locator,
        textExcerpt: selected.excerpt,
        color: 'yellow',
      });
      void app.persistClockState();
      setSelection(null);
      await reloadAnnotations(params.id ?? '');
    } catch (error) {
      setMessage(`Could not add highlight: ${String(error)}`);
    }
  }

  async function addBookmark(): Promise<void> {
    const locator = currentLocator;
    if (locator === undefined) {
      setMessage('Position is not available yet; try again once the page settles.');
      return;
    }
    try {
      await app.annotations.create({ bookId: params.id ?? '', kind: 'bookmark', locator });
      void app.persistClockState();
      await reloadAnnotations(params.id ?? '');
    } catch (error) {
      setMessage(`Could not add bookmark: ${String(error)}`);
    }
  }

  async function removeAnnotation(id: string): Promise<void> {
    try {
      await app.annotations.remove(id);
      void app.persistClockState();
      await reloadAnnotations(params.id ?? '');
    } catch (error) {
      setMessage(`Could not remove bookmark: ${String(error)}`);
    }
  }

  function exportNotes(): void {
    const markdown = buildNotesMarkdown(title(), annotations(), Date.now());
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = notesFilename(title());
    anchor.rel = 'noopener';
    anchor.click();
    // Keep the blob alive until the download starts; see ExportService.download.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function saveNote(id: string, note: string): Promise<void> {
    try {
      await app.annotations.update(id, { note: note.trim() === '' ? undefined : note.trim() });
      void app.persistClockState();
      await reloadAnnotations(params.id ?? '');
    } catch (error) {
      setMessage(`Could not save note: ${String(error)}`);
    }
  }

  function stopSearch(): void {
    searchController?.abort();
    searchController = undefined;
    setSearching(false);
  }

  async function runSearch(event: Event): Promise<void> {
    event.preventDefault();
    const current = session;
    const term = query().trim();
    searchController?.abort();
    setHits([]);
    setSearchStatus('');
    if (current === undefined || term.length === 0) return;

    const controller = new AbortController();
    searchController = controller;
    setSearching(true);
    const collected: SearchHit[] = [];
    try {
      for await (const hit of current.renderer.search(term, controller.signal)) {
        if (controller.signal.aborted) break;
        collected.push(hit);
        setHits([...collected]);
        if (collected.length >= MAX_SEARCH_HITS) break;
      }
      if (!controller.signal.aborted) {
        const capped = collected.length >= MAX_SEARCH_HITS;
        setSearchStatus(
          collected.length === 0
            ? `No matches for “${term}”.`
            : `${collected.length}${capped ? '+' : ''} match${collected.length === 1 ? '' : 'es'} for “${term}”.`,
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) setSearchStatus(`Search failed: ${String(error)}`);
    } finally {
      if (searchController === controller) {
        searchController = undefined;
        setSearching(false);
      }
    }
  }

  createEffect(() => {
    const id = params.id ?? '';
    let disposed = false;
    let current: ReaderSession | undefined;
    let openedAt: number | undefined;
    let startFraction = 0;
    setReady(false);
    setFraction(0);
    setToc([]);
    setTocLoading(true);
    setTocError('');
    setHits([]);
    setSearchStatus('');
    setAnnotations([]);
    setSelection(null);
    setCanHighlight(false);
    setPages([]);
    setSupportsThumbnails(false);
    currentLocator = undefined;
    stopSearch();
    let offSelection: (() => void) | undefined;

    // One reading session per open span. Idempotent: recording clears the
    // start marker so pagehide + cleanup cannot double-count the same span.
    const recordSession = () => {
      if (openedAt === undefined) return;
      const startedAt = openedAt;
      openedAt = undefined;
      const durationS = Math.round((Date.now() - startedAt) / 1000);
      if (durationS < MIN_SESSION_SECONDS) return;
      void app.sessions
        .record({ bookId: id, startedAt, durationS, startFraction, endFraction: fraction() })
        .then(() => app.persistClockState())
        .catch(() => {
          // A lost session is cosmetic; never surface it over the reader.
        });
    };

    const readerMessage = (event: Event) => setMessage(String((event as CustomEvent).detail));
    const flush = () => {
      void current?.flush();
      recordSession();
    };
    host.addEventListener('reader-message', readerMessage);
    window.addEventListener('pagehide', flush);
    const visibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', visibility);
    // Shell-level page turns. Keydown inside the book iframe stays with the
    // engine (which has its own keys), so this only fires when focus is on the
    // reader chrome, and never while typing in the search box.
    const onKey = (event: KeyboardEvent) => {
      if (!ready() || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }
      if (event.key === 'ArrowLeft') {
        session?.renderer.prev();
        event.preventDefault();
      } else if (event.key === 'ArrowRight') {
        session?.renderer.next();
        event.preventDefault();
      } else if (event.key === 's' || event.key === '[') {
        setSidebarOpen((open) => !open);
        event.preventDefault();
      } else if (event.key === 'Escape' && sidebarOpen()) {
        setSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    void app.reader
      .prepare(id, setMessage)
      .then(async (prepared) => {
        if (disposed) {
          await prepared.session.close();
          return;
        }
        current = prepared.session;
        session = current;
        setTitle(prepared.title);
        current.renderer.mount(host);
        current.renderer.applySettings(app.reader.loadSettings());
        setMessage('');
        await current.open(prepared.file, prepared.startAt, (locator) => {
          currentLocator = locator;
          setFraction(locator.fraction);
        });
        if (disposed) return;
        setReady(true);
        openedAt = Date.now();
        startFraction = fraction();
        setCanHighlight(current.renderer.supportsHighlights);
        setSupportsThumbnails(current.renderer.supportsThumbnails);
        offSelection = current.renderer.onSelection(setSelection);
        void current.renderer
          .listPages()
          .then((list) => {
            if (!disposed) setPages(list);
          })
          .catch(() => {
            // The Pages view is optional; a failure leaves it empty.
          });
        void reloadAnnotations(id);
        // Contents are optional: their parsing must not delay basic reading.
        try {
          const items = await current.renderer.getToc();
          if (!disposed) setToc(items);
        } catch (error) {
          if (!disposed) setTocError(`Contents could not be loaded: ${String(error)}`);
        } finally {
          if (!disposed) setTocLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) setMessage(`Could not open book: ${String(error)}`);
      });
    onCleanup(() => {
      disposed = true;
      session = undefined;
      offSelection?.();
      stopSearch();
      recordSession();
      host.removeEventListener('reader-message', readerMessage);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('keydown', onKey);
      void current?.close();
    });
  });

  const searchPanel = () => (
    <div class="reader-search-panel">
      <form class="reader-search-form" onSubmit={(event) => void runSearch(event)}>
        <input
          type="search"
          aria-label="Search in book"
          placeholder="Find a word or phrase"
          value={query()}
          disabled={!ready()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <button type="submit" class="button" disabled={!ready() || query().trim().length === 0}>
          Search
        </button>
        <Show when={searching()}>
          <button type="button" class="button" onClick={() => stopSearch()}>
            Stop
          </button>
        </Show>
      </form>
      <Show when={searching()}>
        <p class="note" role="status">
          Searching…
        </p>
      </Show>
      <Show when={searchStatus()}>
        {(text) => (
          <p class="note" role="status">
            {text()}
          </p>
        )}
      </Show>
      <Show when={hits().length > 0}>
        <ol class="reader-search-results">
          <For each={hits()}>
            {(hit) => (
              <li>
                <button
                  type="button"
                  class="reader-search-hit"
                  onClick={() => session?.renderer.goTo(hit.locator)}
                >
                  <span class="reader-search-excerpt">{hit.excerpt}</span>
                  <span class="reader-search-position">
                    {Math.round(hit.locator.fraction * 100)}%
                  </span>
                </button>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </div>
  );
  const notesPanel = () => (
    <div class="reader-notes-panel reader-bookmarks">
      <div class="reader-bookmarks-actions">
        <button type="button" class="button" disabled={!ready()} onClick={() => void addBookmark()}>
          Bookmark this position
        </button>
        <Show when={canHighlight()}>
          <button
            type="button"
            class="button"
            disabled={selection() === null}
            onClick={() => void addHighlight()}
          >
            Highlight selection
          </button>
        </Show>
        <button
          type="button"
          class="button"
          disabled={annotations().length === 0}
          onClick={() => exportNotes()}
        >
          Export notes
        </button>
      </div>
      <Show when={canHighlight()}>
        <p class="note">
          {selection() === null
            ? 'Select text in the book to highlight it.'
            : 'Text selected — use “Highlight selection” to keep it.'}
        </p>
      </Show>
      <Show
        when={annotations().length > 0}
        fallback={<p class="note">No bookmarks yet. Use the button above to mark your place.</p>}
      >
        <ul class="reader-bookmark-list">
          <For each={annotations()}>
            {(annotation) => (
              <li class="reader-bookmark">
                <div class="reader-bookmark-row">
                  <button
                    type="button"
                    class="reader-bookmark-go"
                    onClick={() => session?.renderer.goTo(annotation.locator)}
                  >
                    <span class="reader-annotation-kind">
                      {annotation.kind === 'highlight'
                        ? 'Highlight'
                        : annotation.kind === 'note'
                          ? 'Note'
                          : 'Bookmark'}
                    </span>{' '}
                    {Math.round(annotation.locator.fraction * 100)}%
                    <Show when={annotation.textExcerpt}>
                      {(excerpt) => <span class="reader-bookmark-excerpt"> — {excerpt()}</span>}
                    </Show>
                  </button>
                  <button
                    type="button"
                    class="button button-danger"
                    aria-label={`Delete ${annotation.kind}`}
                    onClick={() => void removeAnnotation(annotation.id)}
                  >
                    Delete
                  </button>
                </div>
                <input
                  class="reader-bookmark-note"
                  type="text"
                  aria-label="Note"
                  placeholder="Add a note…"
                  value={annotation.note ?? ''}
                  onChange={(event) => void saveNote(annotation.id, event.currentTarget.value)}
                />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
  return (
    <section class="reader-shell" classList={{ 'reader-sidebar-open': sidebarOpen() }}>
      <ReaderSidebar
        open={sidebarOpen()}
        panel={sidebarPanel()}
        tabs={SIDEBAR_TABS}
        width={sidebarWidth()}
        onPanel={(id) => setSidebarPanel(id as SidebarPanel)}
        onClose={() => setSidebarOpen(false)}
        onResize={setSidebarWidth}
      >
        <Switch>
          <Match when={sidebarPanel() === 'contents'}>
            <ReaderContents
              items={toc()}
              loading={tocLoading()}
              error={tocError()}
              onSelect={(locator) => session?.renderer.goTo(locator)}
            />
          </Match>
          <Match when={sidebarPanel() === 'pages'}>
            <ReaderPages
              supportsThumbnails={supportsThumbnails()}
              pages={pages()}
              currentIndex={currentPageIndex()}
              renderThumbnail={(index, maxEdge) =>
                session ? session.renderer.renderThumbnail(index, maxEdge) : Promise.resolve(null)
              }
              onSelect={(locator) => session?.renderer.goTo(locator)}
            />
          </Match>
          <Match when={sidebarPanel() === 'notes'}>{notesPanel()}</Match>
          <Match when={sidebarPanel() === 'search'}>{searchPanel()}</Match>
        </Switch>
      </ReaderSidebar>
      <div class="reader-main">
        <div class="reader-toolbar">
          <button
            type="button"
            class="reader-sidebar-toggle"
            aria-label="Toggle sidebar"
            aria-expanded={sidebarOpen()}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            ☰
          </button>
          <A href={`/book/${params.id}`}>← Close reader</A>
          <h2>{title()}</h2>
          <span aria-label="Reading progress">{Math.round(fraction() * 100)}%</span>
          <button class="button" disabled={!ready()} onClick={() => session?.renderer.prev()}>
            Previous
          </button>
          <button class="button" disabled={!ready()} onClick={() => session?.renderer.next()}>
            Next
          </button>
          <details class="reader-settings-popover">
            <summary>Reader settings</summary>
            <div class="reader-settings">
              <label>
                Font size / PDF zoom
                <input
                  aria-label="Font size / PDF zoom"
                  type="range"
                  min="12"
                  max="36"
                  value={settings().fontSizePx}
                  onInput={(event) =>
                    updateSettings({ fontSizePx: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <label>
                Line height
                <input
                  aria-label="Line height"
                  type="range"
                  min="1"
                  max="2.5"
                  step="0.1"
                  value={settings().lineHeight}
                  onInput={(event) =>
                    updateSettings({ lineHeight: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <label>
                Margins
                <input
                  aria-label="Margins"
                  type="range"
                  min="0"
                  max="80"
                  value={settings().marginPx}
                  onInput={(event) =>
                    updateSettings({ marginPx: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <label>
                Theme
                <select
                  aria-label="Theme"
                  value={settings().theme}
                  onChange={(event) =>
                    updateSettings({ theme: event.currentTarget.value as ReaderTheme })
                  }
                >
                  <option value="light">Light</option>
                  <option value="sepia">Sepia</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
            </div>
          </details>
        </div>
        <Show when={message()}>
          <p class="note" role="status">
            {message()}
          </p>
        </Show>
        <div
          class="reader-surface"
          ref={(element) => {
            host = element;
          }}
        />
      </div>
    </section>
  );
}
