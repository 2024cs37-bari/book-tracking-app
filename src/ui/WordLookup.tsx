import {
  createEffect,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX,
} from 'solid-js';
import { lookupWord as defaultLookup, type DictionaryEntry } from '~/services/dictionary';

/** Resolution states the popup renders, one at a time. */
type LookupState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'result'; readonly entry: DictionaryEntry }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error' };

export interface WordLookupProps {
  /** The selected word to define; a lookup runs whenever this changes. */
  readonly word: string;
  /** Pointer x/y in viewport (CSS) pixels; the panel is clamped on screen. */
  readonly x: number;
  readonly y: number;
  /** Called when the popup should disappear (Escape, outside click, button). */
  readonly onClose: () => void;
  /**
   * Injectable resolver for tests; defaults to the shared dictionary service.
   * A rejected promise shows the error state, `null` shows the empty state.
   */
  readonly lookup?: (word: string, signal?: AbortSignal) => Promise<DictionaryEntry | null>;
}

const EDGE_MARGIN = 8;

/**
 * A transient, positioned dictionary popup shown over a selected word. The
 * parent owns the open/closed state and placement; this component runs the
 * lookup (aborting the previous one when the word changes or it unmounts),
 * renders loading / result / empty / error, clamps itself to the viewport, and
 * dismisses on Escape or an outside click.
 */
export default function WordLookup(props: WordLookupProps): JSX.Element {
  let panelRef: HTMLDivElement | undefined;
  const [state, setState] = createSignal<LookupState>({ kind: 'loading' });

  // Run a fresh lookup whenever the word changes; the cleanup aborts the
  // in-flight request so a stale response can never overwrite a newer one.
  createEffect(() => {
    const word = props.word;
    const lookup = props.lookup ?? defaultLookup;
    const controller = new AbortController();
    setState({ kind: 'loading' });
    lookup(word, controller.signal)
      .then((entry) => {
        if (controller.signal.aborted) return;
        setState(entry === null ? { kind: 'empty' } : { kind: 'result', entry });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: 'error' });
      });
    onCleanup(() => controller.abort());
  });

  function clampToViewport(): void {
    const element = panelRef;
    if (element === undefined) return;
    const rect = element.getBoundingClientRect();
    const maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - rect.width - EDGE_MARGIN);
    const maxTop = Math.max(EDGE_MARGIN, window.innerHeight - rect.height - EDGE_MARGIN);
    element.style.left = `${Math.max(EDGE_MARGIN, Math.min(props.x, maxLeft))}px`;
    element.style.top = `${Math.max(EDGE_MARGIN, Math.min(props.y, maxTop))}px`;
  }

  // Re-clamp after each state change (and position prop change), since the
  // panel's height differs between loading, a short miss, and a long entry.
  createEffect(() => {
    state();
    void props.x;
    void props.y;
    clampToViewport();
  });

  onMount(() => {
    clampToViewport();
    const onPointerDown = (event: Event): void => {
      const target = event.target;
      if (panelRef !== undefined && target instanceof Node && !panelRef.contains(target)) {
        props.onClose();
      }
    };
    const onDocKey = (event: KeyboardEvent): void => {
      // Capture-phase so Escape closes the popup without also reaching the
      // reader shell's own key handling.
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }
    };
    const onResize = (): void => clampToViewport();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onDocKey, true);
    window.addEventListener('resize', onResize);
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onDocKey, true);
      window.removeEventListener('resize', onResize);
    });
  });

  return (
    <div
      ref={(element) => {
        panelRef = element;
      }}
      class="word-lookup"
      role="dialog"
      aria-label={`Definition of ${props.word}`}
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
    >
      <div class="word-lookup-head">
        <div class="word-lookup-titles">
          <span class="word-lookup-word">{props.word}</span>
          <Show when={state().kind === 'result'}>
            <Show when={(state() as { entry: DictionaryEntry }).entry.phonetic}>
              {(phonetic) => <span class="word-lookup-phonetic">{phonetic()}</span>}
            </Show>
          </Show>
        </div>
        <button
          type="button"
          class="word-lookup-close"
          aria-label="Close definition"
          onClick={() => props.onClose()}
        >
          ×
        </button>
      </div>
      <div class="word-lookup-body">
        <Switch>
          <Match when={state().kind === 'loading'}>
            <p class="word-lookup-status" aria-live="polite">
              Looking up “{props.word}”…
            </p>
          </Match>
          <Match when={state().kind === 'empty'}>
            <p class="word-lookup-status">No definition found for “{props.word}”.</p>
          </Match>
          <Match when={state().kind === 'error'}>
            <p class="word-lookup-status" role="alert">
              Could not reach the dictionary. Check your connection and try again.
            </p>
          </Match>
          <Match when={state().kind === 'result'}>
            <For each={(state() as { entry: DictionaryEntry }).entry.meanings}>
              {(meaning) => (
                <section class="word-lookup-meaning">
                  <h3 class="word-lookup-pos">{meaning.partOfSpeech}</h3>
                  <ol class="word-lookup-defs">
                    <For each={meaning.definitions}>
                      {(definition) => (
                        <li class="word-lookup-def">
                          <span class="word-lookup-def-text">{definition.definition}</span>
                          <Show when={definition.example}>
                            {(example) => <span class="word-lookup-example">“{example()}”</span>}
                          </Show>
                        </li>
                      )}
                    </For>
                  </ol>
                </section>
              )}
            </For>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
