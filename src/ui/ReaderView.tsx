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
  untrack,
} from 'solid-js';
import { useApp } from '~/app/context';
import type { Locator } from '~/domain/locator';
import type { Annotation } from '~/domain/annotation';
import type { ProgressConflictRow } from '~/data/db';
import { parseHlc } from '~/domain/hlc';
import type {
  AnnotationAnchorStatus,
  ReaderPage,
  ReaderSettings,
  SearchHit,
  SelectionInfo,
  TocItem,
} from '~/reader/renderer';
import { normalizeReaderSettings } from '~/reader/settings';
import type { ReaderSession, PositionSaveState } from '~/services/reader-service';
import { registerNativeCloseGuard } from '~/app/native-lifecycle';
import {
  ReadingActivity,
  readingActivityQueue,
  READING_CHECKPOINT_MS,
} from '~/services/reading-activity';
import { buildNotesMarkdown, notesFilename } from '~/services/notes-markdown';
import { saveFile } from '~/storage/save-file';
import { normalizeLookupTerm } from '~/services/dictionary';
import { dictionaryAvailable } from '~/services/privacy-preferences';
import { createSpeech } from '~/reader/tts';
import { showToast } from './toast';
import ReaderContents from './ReaderContents';
import ReaderSidebar, { type SidebarTab } from './ReaderSidebar';
import ReaderPages from './ReaderPages';
import ReaderAnnotations, { HIGHLIGHT_PALETTE } from './ReaderAnnotations';
import ReaderTts from './ReaderTts';
import WordLookup from './WordLookup';
import ReaderContextMenu, { type ContextMenuAction } from './ReaderContextMenu';
import Icon from './Icon';
import ReaderSettingsMenu from './ReaderSettingsMenu';
import '~/styles/reader-refinement.css';
import '~/styles/reader-advanced.css';

const MAX_SEARCH_HITS = 200;

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
  const [fixedLayout, setFixedLayout] = createSignal(false);
  const [focusMode, setFocusMode] = createSignal(false);
  const [fullscreen, setFullscreen] = createSignal(false);
  const [jump, setJump] = createSignal('1');
  let shell!: HTMLElement;
  const [activeBookId, setActiveBookId] = createSignal('');
  const [saveState, setSaveState] = createSignal<PositionSaveState>('saved');
  const [activityError, setActivityError] = createSignal<string | null>(null);
  let activity: ReadingActivity | undefined;
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
  const [annotationStatuses, setAnnotationStatuses] = createSignal<
    readonly AnnotationAnchorStatus[]
  >([]);
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
  const phoneViewport = window.matchMedia('(max-width: 767px)');
  const [phone, setPhone] = createSignal(phoneViewport.matches);
  // Desktop disclosure is a saved preference; a phone overlay is temporary.
  // Entering a narrow viewport always returns to the book, even after rotation.
  const [desktopSidebarOpen, setDesktopSidebarOpen] = createSignal(initialPrefs.open);
  const [phoneSidebarOpen, setPhoneSidebarOpen] = createSignal(false);
  const sidebarOpen = () => (phone() ? phoneSidebarOpen() : desktopSidebarOpen());
  const setSidebarOpen = (value: boolean | ((open: boolean) => boolean)) => {
    const next = typeof value === 'function' ? value(sidebarOpen()) : value;
    if (phone()) setPhoneSidebarOpen(next);
    else setDesktopSidebarOpen(next);
  };
  const viewportChanged = (event: MediaQueryListEvent) => {
    if (event.matches) setPhoneSidebarOpen(false);
    setPhone(event.matches);
  };
  phoneViewport.addEventListener('change', viewportChanged);
  onCleanup(() => phoneViewport.removeEventListener('change', viewportChanged));
  const [sidebarPanel, setSidebarPanel] = createSignal<SidebarPanel>(initialPrefs.panel);
  const [sidebarWidth, setSidebarWidth] = createSignal(initialPrefs.width);
  createEffect(() =>
    saveSidebarPrefs({ open: desktopSidebarOpen(), panel: sidebarPanel(), width: sidebarWidth() }),
  );
  // Highlight the page/section at the current reading position: the last unit
  // whose fraction is at or before where we are.
  const currentPageIndex = createMemo(() => {
    const here = fraction();
    let index = -1;
    for (const page of pages()) if (page.locator.fraction <= here + 1e-9) index = page.index;
    return index;
  });
  createEffect(() => setJump(String(Math.max(0, currentPageIndex()) + 1)));
  const visibleSidebar = () => sidebarOpen() && !focusMode();
  let focusWasActive = false;
  createEffect(() => {
    const active = focusMode();
    if (active === focusWasActive) return;
    focusWasActive = active;
    const frame = requestAnimationFrame(() =>
      shell
        .querySelector<HTMLButtonElement>(
          active ? '.reader-focus-exit' : '[aria-label="Focus mode"]',
        )
        ?.focus({ preventScroll: true }),
    );
    onCleanup(() => cancelAnimationFrame(frame));
  });
  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await shell.requestFullscreen();
    } catch {
      showToast('Full screen is unavailable in this window.', 'error');
    }
  }
  const fullscreenChanged = () => setFullscreen(document.fullscreenElement === shell);
  document.addEventListener('fullscreenchange', fullscreenChanged);
  onCleanup(() => {
    document.removeEventListener('fullscreenchange', fullscreenChanged);
    if (document.fullscreenElement === shell) void document.exitFullscreen().catch(() => {});
  });
  function jumpToPage(event: SubmitEvent): void {
    event.preventDefault();
    const index = Number(jump()) - 1;
    const page = Number.isInteger(index) ? pages()[index] : undefined;
    if (page) session?.renderer.goTo(page.locator);
  }
  let host!: HTMLDivElement;
  let session: ReaderSession | undefined;
  let searchController: AbortController | undefined;
  let currentLocator: Locator | undefined;
  let longPressTimer: number | undefined;
  onCleanup(() => cancelLongPress());

  function updateSettings(patch: Partial<ReaderSettings>): void {
    const next = normalizeReaderSettings({ ...settings(), ...patch });
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
      if (bookId !== activeBookId()) return;
      setAnnotations(list);
      session?.renderer.setAnnotationAnchors?.(list);
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
        bookId: activeBookId(),
        kind: 'highlight',
        locator: selected.locator,
        textExcerpt: selected.excerpt,
        color,
      });
      void app.persistClockState();
      setSelection(null);
      await reloadAnnotations(activeBookId());
    } catch (error) {
      showToast(`Could not add highlight: ${String(error)}`, 'error');
    }
  }

  async function recolor(id: string, color: string): Promise<void> {
    try {
      await app.annotations.update(id, { color });
      void app.persistClockState();
      await reloadAnnotations(activeBookId());
    } catch (error) {
      showToast(`Could not change highlight colour: ${String(error)}`, 'error');
    }
  }

  // Resolve a pending progress-divergence prompt: 'remote' accepts the other
  // device's position (and jumps there), 'local' keeps and re-asserts this one.
  async function resolveConflict(choice: 'local' | 'remote'): Promise<void> {
    const pending = conflict();
    if (pending === null) return;
    const id = activeBookId();
    try {
      await app.progressConflicts.resolve(id, choice);
      setConflict(null);
      await app.persistClockState();
      await session?.resumeSaving(choice === 'local');
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
      await app.annotations.create({ bookId: activeBookId(), kind: 'bookmark', locator });
      void app.persistClockState();
      await reloadAnnotations(activeBookId());
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
    if (term !== null && dictionaryAvailable) {
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
      await reloadAnnotations(activeBookId());
    } catch (error) {
      showToast(`Could not remove bookmark: ${String(error)}`, 'error');
    }
  }

  async function exportNotes(): Promise<void> {
    try {
      const markdown = buildNotesMarkdown(title(), annotations(), Date.now());
      await saveFile(new Blob([markdown], { type: 'text/markdown' }), notesFilename(title()));
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not export notes.', 'error');
    }
  }

  async function saveNote(id: string, note: string): Promise<void> {
    try {
      await app.annotations.update(id, { note: note.trim() === '' ? undefined : note.trim() });
      void app.persistClockState();
      await reloadAnnotations(activeBookId());
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
    let currentActivity: ReadingActivity | undefined;
    let pageHidden = false;
    let offSaveState: (() => void) | undefined;
    setReady(false);
    setSaveState('saved');
    setActivityError(null);
    setActiveBookId('');
    setFraction(0);
    setToc([]);
    setTocLoading(true);
    setTocError('');
    setHits([]);
    setSearchStatus('');
    setAnnotations([]);
    setAnnotationStatuses([]);
    setSelection(null);
    setConflict(null);
    setCanHighlight(false);
    setPages([]);
    setSupportsThumbnails(false);
    currentLocator = undefined;
    stopSearch();
    let offSelection: (() => void) | undefined;
    let offAnnotationStatus: (() => void) | undefined;
    let offContextMenu: (() => void) | undefined;

    const activityReport = (error: string | null) => {
      if (!disposed) setActivityError(error);
      else if (error) showToast(error, 'error');
    };
    const readerMessage = (event: Event) => setMessage(String((event as CustomEvent).detail));
    const pause = () => {
      void current?.flush();
      void currentActivity?.pause(untrack(fraction));
    };
    const resume = () => {
      if (!disposed && !pageHidden && document.visibilityState !== 'hidden' && untrack(ready))
        currentActivity?.resume(untrack(fraction));
    };
    const removeCloseGuard = registerNativeCloseGuard(async () => {
      try {
        await Promise.all([current?.flush(), currentActivity?.pause(untrack(fraction))]);
        return untrack(saveState) !== 'failed' && !untrack(activityError);
      } finally {
        // A failed save may lead the user to keep the app open.
        resume();
      }
    });
    const pagehide = () => {
      pageHidden = true;
      pause();
    };
    const pageshow = () => {
      pageHidden = false;
      resume();
    };
    const readerSettingsChanged = (event: Event) =>
      updateSettings((event as CustomEvent<Partial<ReaderSettings>>).detail);
    host.addEventListener('reader-settings-change', readerSettingsChanged);
    host.addEventListener('reader-message', readerMessage);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', pageshow);
    const visibility = () => {
      if (document.visibilityState === 'hidden') pause();
      else {
        resume();
        void current?.flush();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    const checkpoint = window.setInterval(() => {
      if (!disposed && !pageHidden && document.visibilityState !== 'hidden') {
        void currentActivity?.checkpoint(untrack(fraction));
        void current?.flush();
      }
    }, READING_CHECKPOINT_MS);
    // Shell-level page turns. Keydown inside the book iframe stays with the
    // engine (which has its own keys), so this only fires when focus is on the
    // reader chrome, and never while typing in the search box.
    const onKey = (event: KeyboardEvent) => {
      if (
        !ready() ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        contextMenu() ||
        lookup()
      )
        return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable ||
        target?.closest(
          'dialog, [role=dialog], [role=alertdialog], [role=menu], [role=tablist], [role=combobox], [role=listbox]',
        )
      ) {
        return;
      }
      if (event.key === 'ArrowLeft') {
        session?.renderer.prev();
        event.preventDefault();
      } else if (event.key === 'ArrowRight') {
        session?.renderer.next();
        event.preventDefault();
      } else if (event.key === 'f') {
        setFocusMode((active) => !active);
        event.preventDefault();
      } else if (event.key === 'Escape' && focusMode()) {
        setFocusMode(false);
        event.preventDefault();
      } else if (event.key === 's' || event.key === '[') {
        setFocusMode(false);
        setSidebarOpen((open) => !open);
        event.preventDefault();
      } else if (event.key === 'Escape' && sidebarOpen()) {
        setSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    void app.reader
      .prepare(id, (text) => {
        if (!disposed) setMessage(text);
        else showToast(text, 'error');
      })
      .then(async (prepared) => {
        if (disposed) {
          await prepared.session.close();
          return;
        }
        current = prepared.session;
        session = current;
        setActiveBookId(prepared.bookId);
        offSaveState = current.onSaveState((state) => {
          setSaveState(state);
          if (state === 'saved')
            setMessage((text) => (text.startsWith('Position could not be saved:') ? '' : text));
        });
        currentActivity = new ReadingActivity(
          prepared.bookId,
          readingActivityQueue(app.sessions, app.persistClockState),
          activityReport,
        );
        activity = currentActivity;
        setTitle(prepared.title);
        // Initial renderer relocations must not acknowledge a cross-device
        // conflict before its concrete position choice has been shown.
        const pendingConflict = await app.progressConflicts.get(prepared.bookId);
        if (disposed) {
          await current.close();
          return;
        }
        if (pendingConflict) {
          current.suspendSaving();
          setConflict(pendingConflict);
        }
        current.renderer.mount(host);
        current.renderer.applySettings(app.reader.loadSettings());
        setMessage('');
        await current.open(prepared.file, prepared.startAt, (locator) => {
          currentLocator = locator;
          setFraction(locator.fraction);
        });
        if (disposed) return;
        setFixedLayout(current.renderer.fixedLayout ?? false);
        setReady(true);
        resume();
        setCanHighlight(current.renderer.supportsHighlights);
        setSupportsThumbnails(current.renderer.supportsThumbnails);
        offSelection = current.renderer.onSelection(setSelection);
        offAnnotationStatus = current.renderer.onAnnotationStatus?.((states) => {
          if (!disposed) setAnnotationStatuses(states);
        });
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
        void reloadAnnotations(prepared.bookId);
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
        void current?.close();
        if (!disposed) setMessage(`Could not open book: ${String(error)}`);
      });
    onCleanup(() => {
      disposed = true;
      session = undefined;
      offSaveState?.();
      removeCloseGuard();
      offSelection?.();
      offAnnotationStatus?.();
      offContextMenu?.();
      stopSearch();
      void currentActivity?.pause(untrack(fraction));
      if (activity === currentActivity) activity = undefined;
      clearInterval(checkpoint);
      host.removeEventListener('reader-settings-change', readerSettingsChanged);
      host.removeEventListener('reader-message', readerMessage);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('pageshow', pageshow);
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
        <button
          type="button"
          class="button reader-bookmark-action"
          disabled={!ready()}
          onClick={() => void addBookmark()}
        >
          <Icon name="bookmark" size={16} />
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
          onClick={() => void exportNotes()}
        >
          <Icon name="download" size={15} />
          Export notes
        </button>
      </div>
      <ReaderAnnotations
        annotations={annotations()}
        anchorStatuses={annotationStatuses()}
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
    <section
      ref={(element) => {
        shell = element;
      }}
      class="reader-shell"
      classList={{ 'reader-sidebar-open': visibleSidebar(), 'reader-focus': focusMode() }}
      style={{ '--reader-sidebar-width': `${sidebarWidth()}px` }}
    >
      <div class="reader-toolbar">
        <div class="reader-toolbar-group">
          <A
            class="reader-close"
            aria-label="← Close reader"
            title="Back to book"
            href={`/book/${activeBookId() || params.id}`}
          >
            <Icon name="arrow-left" size={18} />
            <span class="reader-close-label">Back to book</span>
          </A>
          <button
            type="button"
            class="reader-icon-button"
            id="reader-sidebar-toggle"
            aria-controls={visibleSidebar() ? 'reader-sidebar' : undefined}
            aria-label="Toggle sidebar"
            title="Explore this book (S)"
            aria-expanded={visibleSidebar()}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            <Icon name="sidebar" size={19} />
          </button>
        </div>
        <h1 class="reader-title" title={title()}>
          {title()}
        </h1>
        <div class="reader-toolbar-group">
          <button
            type="button"
            class="reader-icon-button"
            aria-label="Focus mode"
            title="Focus mode (F)"
            aria-pressed={focusMode()}
            onClick={() => setFocusMode(true)}
          >
            <Icon name="focus" size={19} />
          </button>
          <Show when={document.fullscreenEnabled}>
            <button
              type="button"
              class="reader-icon-button"
              aria-label={fullscreen() ? 'Exit full screen' : 'Full screen'}
              title={fullscreen() ? 'Exit full screen' : 'Full screen'}
              onClick={() => void toggleFullscreen()}
            >
              <Icon name="maximize" size={19} />
            </button>
          </Show>
          <ReaderSettingsMenu
            settings={settings()}
            onChange={updateSettings}
            pdf={supportsThumbnails()}
            fixed={fixedLayout()}
            ready={ready()}
          />
        </div>
      </div>
      <Show when={focusMode()}>
        <button
          type="button"
          class="reader-focus-exit"
          onClick={() => {
            setFocusMode(false);
            requestAnimationFrame(() =>
              shell.querySelector<HTMLButtonElement>('[aria-label="Focus mode"]')?.focus(),
            );
          }}
        >
          <Icon name="focus" size={17} /> Exit focus <kbd>Esc</kbd>
        </button>
      </Show>
      <div class="reader-body">
        <ReaderSidebar
          open={visibleSidebar()}
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
          <Show when={saveState() === 'failed'}>
            <p class="note note-error" role="alert">
              Your latest reading position has not been saved. Keep this page open and retry.
              <button type="button" class="button" onClick={() => void session?.flush()}>
                Retry saving position
              </button>
            </p>
          </Show>
          <Show when={activityError()}>
            {(error) => (
              <p class="note note-error" role="alert">
                {error()}{' '}
                <button type="button" class="button" onClick={() => void activity?.retry()}>
                  Retry saving reading time
                </button>
              </p>
            )}
          </Show>
          <Show when={conflict()}>
            {(pending) => (
              <div class="reader-conflict" role="alertdialog" aria-label="Reading position differs">
                <p class="reader-conflict-text">
                  Another device reached{' '}
                  <strong>{Math.round(pending().remote.fraction * 100)}%</strong> of this book
                  {formatHlcTime(pending().remote.updatedHlc)}. You're at{' '}
                  <strong>{Math.round(pending().localFraction * 100)}%</strong> here. Choose a
                  position to resume automatic saving.
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
      <footer class="reader-footer">
        <span class="reader-footer-hint" aria-hidden="true">
          Use ← → to turn pages
        </span>
        <div class="reader-nav" role="group" aria-label="Pages">
          <button
            type="button"
            class="reader-icon-button"
            aria-label="Previous"
            title="Previous page (←)"
            disabled={!ready()}
            onClick={() => session?.renderer.prev()}
          >
            <Icon name="arrow-left" size={19} />
          </button>
          <span class="reader-progress" aria-label="Reading progress">
            {Math.round(fraction() * 100)}%
          </span>
          <button
            type="button"
            class="reader-icon-button"
            aria-label="Next"
            title="Next page (→)"
            disabled={!ready()}
            onClick={() => session?.renderer.next()}
          >
            <Icon name="arrow-right" size={19} />
          </button>
        </div>
        <form class="reader-page-jump" onSubmit={jumpToPage}>
          <label for="reader-page-number">{supportsThumbnails() ? 'Page' : 'Section'}</label>
          <input
            id="reader-page-number"
            type="number"
            inputmode="numeric"
            min="1"
            max={pages().length || 1}
            aria-label={supportsThumbnails() ? 'Go to page' : 'Go to section'}
            value={jump()}
            disabled={!ready()}
            onInput={(event) => setJump(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setJump(String(currentPageIndex() + 1));
                event.currentTarget.blur();
                event.stopPropagation();
              }
            }}
          />
          <span>of {pages().length || '—'}</span>
          <button
            class="reader-icon-button"
            type="submit"
            aria-label="Go to location"
            disabled={!ready()}
          >
            <Icon name="arrow-right" size={15} />
          </button>
        </form>
      </footer>
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
