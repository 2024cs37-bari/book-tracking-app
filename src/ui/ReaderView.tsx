import { A, useParams } from '@solidjs/router';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from 'solid-js';
import { useApp } from '~/app/context';
import type { Locator } from '~/domain/locator';
import type { Annotation } from '~/domain/annotation';
import type { ProgressConflictRow } from '~/data/db';
import { parseHlc } from '~/domain/hlc';
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
import { normalizeLookupTerm } from '~/services/dictionary';
import { createSpeech } from '~/reader/tts';
import { showToast } from './toast';
import ReaderContents from './ReaderContents';
import ReaderSidebar, { type SidebarTab } from './ReaderSidebar';
import ReaderPages from './ReaderPages';
import ReaderAnnotations, { HIGHLIGHT_PALETTE } from './ReaderAnnotations';
import ReaderTts from './ReaderTts';
import WordLookup from './WordLookup';
import ReaderContextMenu, { type ContextMenuAction } from './ReaderContextMenu';

const MAX_SEARCH_HITS = 200;
/** Reading spans shorter than this are noise and are not recorded as sessions. */
const MIN_SESSION_SECONDS = 5;

type SidebarPanel = 'contents' | 'pages' | 'notes' | 'search' | 'listen';
const SIDEBAR_TABS: readonly SidebarTab[] = [
  { id: 'contents', label: 'Contents' },
  { id: 'pages', label: 'Pages' },
  { id: 'notes', label: 'Notes' },
  { id: 'search', label: 'Search' },
  { id: 'listen', label: 'Listen' },
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

/** " on 3/4/2026, 9:12 PM" from an HLC's wall time, or "" when unparseable. */
function formatHlcTime(hlc: string): string {
  const parsed = parseHlc(hlc);
  if (parsed === null) return '';
  try {
    return ` on ${new Date(parsed.wallMs).toLocaleString()}`;
  } catch {
    return '';
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
  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
    selection: SelectionInfo;
  } | null>(null);
  const [lookup, setLookup] = createSignal<{ word: string; x: number; y: number } | null>(null);
  const [conflict, setConflict] = createSignal<ProgressConflictRow | null>(null);
  // One speech controller per reader view; the <ReaderTts> panel is a thin view
  // over it, so playback survives tab switches that unmount the view.
  const speech = createSpeech();
  onCleanup(() => speech.destroy());
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
  let longPressTimer: number | undefined;
  onCleanup(() => cancelLongPress());

  function updateSettings(patch: Partial<ReaderSettings>): void {
    const next = { ...settings(), ...patch };
    setSettings(next);
    session?.renderer.applySettings(next);
    try {
      app.reader.saveSettings(next);
    } catch (error) {
      showToast(`Settings could not be saved: ${String(error)}`, 'error');
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

  async function addHighlight(color = 'yellow'): Promise<void> {
    const selected = selection();
    if (selected === null) return;
    try {
      await app.annotations.create({
        bookId: params.id ?? '',
        kind: 'highlight',
        locator: selected.locator,
        textExcerpt: selected.excerpt,
        color,
      });
      void app.persistClockState();
      setSelection(null);
      await reloadAnnotations(params.id ?? '');
    } catch (error) {
      showToast(`Could not add highlight: ${String(error)}`, 'error');
    }
  }

  async function recolor(id: string, color: string): Promise<void> {
    try {
      await app.annotations.update(id, { color });
      void app.persistClockState();
      await reloadAnnotations(params.id ?? '');
    } catch (error) {
      showToast(`Could not change highlight colour: ${String(error)}`, 'error');
    }
  }

  // Resolve a pending progress-divergence prompt: 'remote' accepts the other
  // device's position (and jumps there), 'local' keeps and re-asserts this one.
  async function resolveConflict(choice: 'local' | 'remote'): Promise<void> {
    const pending = conflict();
    if (pending === null) return;
    const id = params.id ?? '';
    setConflict(null);
    try {
      await app.progressConflicts.resolve(id, choice);
      void app.persistClockState();
      const remote = pending.remote;
      if (
        choice === 'remote' &&
        remote.locatorKind !== undefined &&
        remote.locatorValue !== undefined
      ) {
        session?.renderer.goTo({
          kind: remote.locatorKind,
          value: remote.locatorValue,
          fraction: remote.fraction,
        });
      }
    } catch (error) {
      showToast(`Could not update the reading position: ${String(error)}`, 'error');
    }
  }

  async function addBookmark(): Promise<void> {
    const locator = currentLocator;
    if (locator === undefined) {
      showToast('Position is not available yet; try again once the page settles.', 'info');
      return;
    }
    try {
      await app.annotations.create({ bookId: params.id ?? '', kind: 'bookmark', locator });
      void app.persistClockState();
      await reloadAnnotations(params.id ?? '');
    } catch (error) {
      showToast(`Could not add bookmark: ${String(error)}`, 'error');
    }
  }

  async function copySelection(): Promise<void> {
    const selected = selection();
    if (selected === null) return;
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      showToast('Clipboard is not available in this browser.', 'error');
      return;
    }
    try {
      await clipboard.writeText(selected.excerpt);
      showToast('Copied selection to clipboard.', 'success');
    } catch (error) {
      showToast(`Could not copy selection: ${String(error)}`, 'error');
    }
  }

  // The menu acts on the selection captured when it opened. Moving focus into
  // the menu clears the live DOM selection (so `selection()` may already be
  // null by the time an item is chosen); re-asserting the captured snapshot
  // lets the existing addHighlight()/copySelection() paths run against it.
  function menuActionsFor(
    captured: SelectionInfo,
    x: number,
    y: number,
  ): readonly ContextMenuAction[] {
    const actions: ContextMenuAction[] = [];
    // Offer a dictionary lookup only for a single-word selection.
    const singleWord = captured.excerpt.trim().split(/\s+/u).length === 1;
    const term = singleWord ? normalizeLookupTerm(captured.excerpt) : null;
    if (term !== null) {
      actions.push({ label: `Define “${term}”`, onSelect: () => setLookup({ word: term, x, y }) });
    }
    actions.push({ label: 'Bookmark here', onSelect: () => void addBookmark() });
    actions.push({
      label: 'Copy',
      onSelect: () => {
        setSelection(captured);
        void copySelection();
      },
    });
    return actions;
  }

  function openContextMenu(event: MouseEvent): void {
    const selected = selection();
    if (selected === null) return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, selection: selected });
  }

  function cancelLongPress(): void {
    if (longPressTimer !== undefined) {
      clearTimeout(longPressTimer);
      longPressTimer = undefined;
    }
  }

  function onSurfaceTouchStart(event: TouchEvent): void {
    const touch = event.touches[0];
    if (touch === undefined) return;
    const x = touch.clientX;
    const y = touch.clientY;
    cancelLongPress();
    // A sustained press over an existing selection opens the same menu on
    // touch, where there is no right click to catch.
    longPressTimer = window.setTimeout(() => {
      longPressTimer = undefined;
      const selected = selection();
      if (selected !== null) setContextMenu({ x, y, selection: selected });
    }, 500);
  }

  async function removeAnnotation(id: string): Promise<void> {
    try {
      await app.annotations.remove(id);
      void app.persistClockState();
      await reloadAnnotations(params.id ?? '');
    } catch (error) {
      showToast(`Could not remove bookmark: ${String(error)}`, 'error');
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
      showToast(`Could not save note: ${String(error)}`, 'error');
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
    setConflict(null);
    setCanHighlight(false);
    setPages([]);
    setSupportsThumbnails(false);
    currentLocator = undefined;
    stopSearch();
    let offSelection: (() => void) | undefined;
    let offContextMenu: (() => void) | undefined;

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
        // EPUB forwards right-click / long-press from inside its iframe (where
        // the event cannot bubble to the surface); PDF leaves this a no-op and
        // is covered by the surface handler below.
        offContextMenu = current.renderer.onContextMenu((point) => {
          // Fired on a user right-click/long-press: read the latest selection
          // without subscribing (this callback is not a tracked scope).
          const selected = untrack(selection);
          if (selected !== null) {
            setContextMenu({ x: point.x, y: point.y, selection: selected });
          }
        });
        void current.renderer
          .listPages()
          .then((list) => {
            if (!disposed) setPages(list);
          })
          .catch(() => {
            // The Pages view is optional; a failure leaves it empty.
          });
        void reloadAnnotations(id);
        // Surface a pending progress-divergence prompt for this book, if the
        // last sync recorded one (SYNC.md §6). The reader opens at the local
        // position; the prompt offers to jump to the other device's instead.
        void app.progressConflicts
          .get(id)
          .then((pending) => {
            if (!disposed) setConflict(pending ?? null);
          })
          .catch(() => {
            // The prompt is optional; a load failure must not break reading.
          });
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
      offContextMenu?.();
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
    <div class="reader-notes-panel">
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
      <ReaderAnnotations
        annotations={annotations()}
        onSelect={(locator) => session?.renderer.goTo(locator)}
        onDelete={(id) => void removeAnnotation(id)}
        onEditNote={(id, note) => void saveNote(id, note)}
        onRecolor={(id, color) => void recolor(id, color)}
      />
    </div>
  );
  const listenPanel = () => (
    <ReaderTts
      controller={speech}
      getText={() => (session ? session.renderer.getVisibleText() : Promise.resolve(''))}
    />
  );
  return (
    <section class="reader-shell" classList={{ 'reader-sidebar-open': sidebarOpen() }}>
      <div class="reader-toolbar">
        <div class="reader-toolbar-group">
          <button
            type="button"
            class="reader-icon-button"
            aria-label="Toggle sidebar"
            aria-expanded={sidebarOpen()}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            ☰
          </button>
          <A class="reader-close" href={`/book/${params.id}`}>
            ← Close reader
          </A>
        </div>
        <h2 class="reader-title" title={title()}>
          {title()}
        </h2>
        <div class="reader-toolbar-group">
          <div class="reader-nav" role="group" aria-label="Pages">
            <button
              type="button"
              class="reader-icon-button"
              aria-label="Previous"
              disabled={!ready()}
              onClick={() => session?.renderer.prev()}
            >
              ‹
            </button>
            <span class="reader-progress" aria-label="Reading progress">
              {Math.round(fraction() * 100)}%
            </span>
            <button
              type="button"
              class="reader-icon-button"
              aria-label="Next"
              disabled={!ready()}
              onClick={() => session?.renderer.next()}
            >
              ›
            </button>
          </div>
          <ReaderSettingsMenu settings={settings()} onChange={updateSettings} />
        </div>
      </div>
      <div class="reader-body">
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
            <Match when={sidebarPanel() === 'listen'}>{listenPanel()}</Match>
          </Switch>
        </ReaderSidebar>
        <div class="reader-main">
          <Show when={message()}>
            <p class="note" role="status">
              {message()}
            </p>
          </Show>
          <Show when={conflict()}>
            {(pending) => (
              <div class="reader-conflict" role="alertdialog" aria-label="Reading position differs">
                <p class="reader-conflict-text">
                  Another device reached{' '}
                  <strong>{Math.round(pending().remote.fraction * 100)}%</strong> of this book
                  {formatHlcTime(pending().remote.updatedHlc)}. You're at{' '}
                  <strong>{Math.round(pending().localFraction * 100)}%</strong> here.
                </p>
                <div class="reader-conflict-actions">
                  <button
                    type="button"
                    class="button button-primary"
                    onClick={() => void resolveConflict('remote')}
                  >
                    Go to {Math.round(pending().remote.fraction * 100)}%
                  </button>
                  <button
                    type="button"
                    class="button"
                    onClick={() => void resolveConflict('local')}
                  >
                    Stay here
                  </button>
                </div>
              </div>
            )}
          </Show>
          <div
            class="reader-surface"
            onContextMenu={openContextMenu}
            onTouchStart={onSurfaceTouchStart}
            onTouchMove={() => cancelLongPress()}
            onTouchEnd={() => cancelLongPress()}
            onTouchCancel={() => cancelLongPress()}
            ref={(element) => {
              host = element;
            }}
          />
        </div>
      </div>
      <Show when={contextMenu()}>
        {(menu) => (
          <ReaderContextMenu
            x={menu().x}
            y={menu().y}
            actions={menuActionsFor(menu().selection, menu().x, menu().y)}
            colors={canHighlight() ? HIGHLIGHT_PALETTE : []}
            onColor={(token) => {
              setSelection(menu().selection);
              void addHighlight(token);
            }}
            onClose={() => setContextMenu(null)}
          />
        )}
      </Show>
      <Show when={lookup()}>
        {(info) => (
          <WordLookup
            word={info().word}
            x={info().x}
            y={info().y}
            onClose={() => setLookup(null)}
          />
        )}
      </Show>
    </section>
  );
}

/** The reader's appearance controls, shown from the toolbar's gear popover. */
function ReaderSettingsMenu(props: {
  settings: ReaderSettings;
  onChange: (patch: Partial<ReaderSettings>) => void;
}): JSX.Element {
  return (
    <details class="reader-settings-popover">
      <summary class="reader-icon-button reader-settings-summary">Reader settings</summary>
      <div class="reader-settings">
        <label>
          Font size / PDF zoom
          <input
            aria-label="Font size / PDF zoom"
            type="range"
            min="12"
            max="36"
            value={props.settings.fontSizePx}
            onInput={(event) => props.onChange({ fontSizePx: Number(event.currentTarget.value) })}
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
            value={props.settings.lineHeight}
            onInput={(event) => props.onChange({ lineHeight: Number(event.currentTarget.value) })}
          />
        </label>
        <label>
          Margins
          <input
            aria-label="Margins"
            type="range"
            min="0"
            max="80"
            value={props.settings.marginPx}
            onInput={(event) => props.onChange({ marginPx: Number(event.currentTarget.value) })}
          />
        </label>
        <label>
          Theme
          <select
            aria-label="Theme"
            value={props.settings.theme}
            onChange={(event) =>
              props.onChange({ theme: event.currentTarget.value as ReaderTheme })
            }
          >
            <option value="light">Light</option>
            <option value="sepia">Sepia</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </div>
    </details>
  );
}
