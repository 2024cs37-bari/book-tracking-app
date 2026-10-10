import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import type { Annotation } from '~/domain/annotation';
import { formatPercent, type Locator } from '~/domain/locator';
import {
  type ColourFilter,
  filterAnnotations,
  HIGHLIGHT_PALETTE,
  type HighlightColour,
  highlightCss,
  KIND_FILTERS,
  type KindFilter,
  kindLabel,
  sortByFraction,
} from './reader-annotations-model';

// Re-export the model helpers so callers can reach them through this module.
export {
  filterAnnotations,
  HIGHLIGHT_PALETTE,
  highlightCss,
  KIND_FILTERS,
  kindLabel,
  sortByFraction,
};
export type { ColourFilter, HighlightColour, KindFilter };

export interface ReaderAnnotationsProps {
  readonly annotations: readonly Annotation[];
  readonly onSelect: (locator: Locator) => void;
  readonly onDelete: (id: string) => void;
  readonly onEditNote: (id: string, note: string) => void;
  readonly onRecolor: (id: string, color: string) => void;
}

/**
 * A self-contained annotations manager panel for the reader sidebar. It lists a
 * book's highlights, notes and bookmarks ordered by position, with kind and
 * colour filters, per-highlight recolouring, inline note editing, jump-to and
 * delete. The parent owns the data and the persistence callbacks; this
 * component owns only the local view state (active filters, open palette).
 */
export default function ReaderAnnotations(props: ReaderAnnotationsProps): JSX.Element {
  const [kind, setKind] = createSignal<KindFilter>('all');
  const [colour, setColour] = createSignal<ColourFilter>('all');
  const [openPalette, setOpenPalette] = createSignal<string | null>(null);

  const ordered = createMemo(() => sortByFraction(props.annotations));
  const visible = createMemo(() => filterAnnotations(ordered(), kind(), colour()));
  const isFiltered = createMemo(() => kind() !== 'all' || colour() !== 'all');

  // Per-kind counts over the full (non-deleted) set, shown on the filter chips.
  const kindCounts = createMemo(() => {
    const counts: Record<KindFilter, number> = { all: 0, highlight: 0, note: 0, bookmark: 0 };
    for (const annotation of ordered()) {
      counts.all += 1;
      counts[annotation.kind] += 1;
    }
    return counts;
  });

  // Only offer colour filters for colours actually present, in palette order.
  const presentColours = createMemo<readonly HighlightColour[]>(() => {
    const present = new Set<string>();
    for (const annotation of ordered()) {
      if (annotation.color !== undefined && annotation.color !== '') present.add(annotation.color);
    }
    const known = HIGHLIGHT_PALETTE.filter((entry) => present.has(entry.token));
    const extra = [...present]
      .filter((token) => !HIGHLIGHT_PALETTE.some((entry) => entry.token === token))
      .map((token) => ({ token, label: token, css: token }));
    return [...known, ...extra];
  });

  function clearFilters(): void {
    setKind('all');
    setColour('all');
  }

  function recolor(id: string, token: string): void {
    props.onRecolor(id, token);
    setOpenPalette(null);
  }

  // Dismiss an open recolour palette on an outside pointer press. The listener
  // only exists while a palette is open, so it costs nothing the rest of the
  // time and cleans itself up.
  createEffect(() => {
    if (openPalette() === null) return;
    const onPointerDown = (event: Event): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('.reader-annotation-swatch-wrap') !== null) {
        return;
      }
      setOpenPalette(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    onCleanup(() => document.removeEventListener('pointerdown', onPointerDown, true));
  });

  return (
    <section class="reader-annotations" aria-label="Annotations">
      <header class="reader-annotations-header">
        <h3 class="reader-annotations-title">
          Annotations
          <span class="reader-annotations-count" aria-live="polite">
            {isFiltered() ? `${visible().length} of ${ordered().length}` : String(ordered().length)}
          </span>
        </h3>
      </header>

      <Show
        when={ordered().length > 0}
        fallback={
          <p class="note reader-annotations-empty">
            No annotations yet. Highlight text or bookmark a position while reading and it will
            appear here.
          </p>
        }
      >
        <div class="reader-annotations-filters">
          <div class="reader-annotations-kinds" role="group" aria-label="Filter by kind">
            <For each={KIND_FILTERS}>
              {(filter) => (
                <button
                  type="button"
                  class="reader-filter-chip"
                  classList={{ active: kind() === filter.id }}
                  aria-pressed={kind() === filter.id}
                  onClick={() => setKind(filter.id)}
                >
                  {filter.label}
                  <span class="reader-filter-count">{kindCounts()[filter.id]}</span>
                </button>
              )}
            </For>
          </div>
          <Show when={presentColours().length > 0}>
            <div class="reader-annotations-colours" role="group" aria-label="Filter by colour">
              <button
                type="button"
                class="reader-filter-chip"
                classList={{ active: colour() === 'all' }}
                aria-pressed={colour() === 'all'}
                onClick={() => setColour('all')}
              >
                All colours
              </button>
              <For each={presentColours()}>
                {(entry) => (
                  <button
                    type="button"
                    class="reader-colour-chip"
                    classList={{ active: colour() === entry.token }}
                    style={{ background: entry.css }}
                    aria-pressed={colour() === entry.token}
                    aria-label={`Only ${entry.label} highlights`}
                    title={`Only ${entry.label} highlights`}
                    onClick={() => setColour(colour() === entry.token ? 'all' : entry.token)}
                  />
                )}
              </For>
            </div>
          </Show>
        </div>
        <Show
          when={visible().length > 0}
          fallback={
            <p class="note reader-annotations-empty">
              No annotations match these filters.{' '}
              <button type="button" class="reader-link-button" onClick={clearFilters}>
                Clear filters
              </button>
            </p>
          }
        >
          <ul class="reader-annotation-list">
            <For each={visible()}>
              {(annotation) => (
                <li class="reader-annotation">
                  <div class="reader-annotation-top">
                    <button
                      type="button"
                      class="reader-annotation-jump"
                      title="Jump to this position"
                      onClick={() => props.onSelect(annotation.locator)}
                    >
                      <span class="reader-annotation-kind">{kindLabel(annotation.kind)}</span>
                      <span class="reader-annotation-pos">
                        {formatPercent(annotation.locator.fraction)}
                      </span>
                    </button>
                    <Show when={annotation.kind === 'highlight'}>
                      <div class="reader-annotation-swatch-wrap">
                        <button
                          type="button"
                          class="reader-annotation-swatch"
                          style={{ background: highlightCss(annotation.color) }}
                          aria-haspopup="true"
                          aria-expanded={openPalette() === annotation.id}
                          aria-label="Change highlight colour"
                          title="Change highlight colour"
                          onClick={() =>
                            setOpenPalette(openPalette() === annotation.id ? null : annotation.id)
                          }
                        />
                        <Show when={openPalette() === annotation.id}>
                          <div
                            class="reader-annotation-palette"
                            role="group"
                            aria-label="Highlight colours"
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') {
                                event.stopPropagation();
                                setOpenPalette(null);
                              }
                            }}
                            ref={(element) =>
                              queueMicrotask(() => {
                                const first = element.querySelector('button');
                                if (first instanceof HTMLElement) first.focus();
                              })
                            }
                          >
                            <For each={HIGHLIGHT_PALETTE}>
                              {(entry) => (
                                <button
                                  type="button"
                                  class="reader-colour-chip"
                                  classList={{
                                    active: (annotation.color ?? 'yellow') === entry.token,
                                  }}
                                  style={{ background: entry.css }}
                                  aria-label={entry.label}
                                  title={entry.label}
                                  onClick={() => recolor(annotation.id, entry.token)}
                                />
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    </Show>
                    <button
                      type="button"
                      class="button button-danger reader-annotation-delete"
                      aria-label={`Delete ${annotation.kind}`}
                      onClick={() => props.onDelete(annotation.id)}
                    >
                      Delete
                    </button>
                  </div>
                  <Show when={annotation.textExcerpt}>
                    {(excerpt) => (
                      <blockquote class="reader-annotation-excerpt">{excerpt()}</blockquote>
                    )}
                  </Show>
                  <textarea
                    class="reader-annotation-note"
                    rows={2}
                    aria-label="Note"
                    placeholder="Add a note…"
                    value={annotation.note ?? ''}
                    onChange={(event) => props.onEditNote(annotation.id, event.currentTarget.value)}
                  />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}
