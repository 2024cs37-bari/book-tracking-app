import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { Locator } from '~/domain/locator';
import type { ReaderPage } from '~/reader/renderer';

/** Longest edge of a sidebar thumbnail, in CSS pixels. */
const THUMB_MAX_EDGE = 180;

/**
 * One lazily-rendered thumbnail: it renders its page image only once scrolled
 * into view (IntersectionObserver), and revokes its URL when it leaves the
 * viewport. Scrolling a long book never retains every thumbnail ever visited.
 */
function ThumbnailCell(props: {
  page: ReaderPage;
  active: boolean;
  render: (index: number, maxEdge: number) => Promise<string | null>;
  onSelect: (locator: Locator) => void;
}) {
  const [url, setUrl] = createSignal<string | null>(null);
  let disposed = false;

  let generation = 0;
  let visible = false;
  let rendering = false;
  const render = () => {
    if (!visible || rendering || url() !== null || disposed) return;
    rendering = true;
    const token = generation;
    void props
      .render(props.page.index, THUMB_MAX_EDGE)
      .then((result) => {
        if (result === null) return;
        if (disposed || !visible || token !== generation) URL.revokeObjectURL(result);
        else setUrl(result);
      })
      .catch(() => {
        /* An unavailable thumbnail leaves a navigable page label. */
      })
      .finally(() => {
        rendering = false;
        if (!disposed && visible && token !== generation) render();
      });
  };
  const observer = new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      generation++;
      if (visible) render();
      else {
        const current = url();
        if (current !== null) URL.revokeObjectURL(current);
        setUrl(null);
      }
    },
    { rootMargin: '150px' },
  );

  onCleanup(() => {
    disposed = true;
    observer.disconnect();
    const current = url();
    if (current !== null) URL.revokeObjectURL(current);
  });

  return (
    <button
      type="button"
      class="reader-thumb"
      classList={{ active: props.active }}
      aria-current={props.active ? 'true' : undefined}
      ref={(element) => observer.observe(element)}
      onClick={() => props.onSelect(props.page.locator)}
    >
      <span class="reader-thumb-image">
        <Show when={url()} fallback={<span class="reader-thumb-placeholder" />}>
          {(src) => <img src={src()} alt="" loading="lazy" />}
        </Show>
      </span>
      <span class="reader-thumb-label">{props.page.label}</span>
    </button>
  );
}

/**
 * The Pages sidebar panel. For PDF it is a lazy thumbnail grid; for EPUB (no
 * fixed pages) it is a section list with reading-position percentages. The
 * current page/section is highlighted.
 */
export default function ReaderPages(props: {
  supportsThumbnails: boolean;
  pages: readonly ReaderPage[];
  currentIndex: number;
  renderThumbnail: (index: number, maxEdge: number) => Promise<string | null>;
  onSelect: (locator: Locator) => void;
}) {
  return (
    <Show when={props.pages.length > 0} fallback={<p class="note">No pages available.</p>}>
      <Show
        when={props.supportsThumbnails}
        fallback={
          <ul class="reader-pages-list">
            <For each={props.pages}>
              {(page) => (
                <li>
                  <button
                    type="button"
                    class="reader-page-row"
                    classList={{ active: page.index === props.currentIndex }}
                    aria-current={page.index === props.currentIndex ? 'true' : undefined}
                    onClick={() => props.onSelect(page.locator)}
                  >
                    <span>{page.label}</span>
                    <span class="reader-page-pct">{Math.round(page.locator.fraction * 100)}%</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        }
      >
        <div class="reader-thumb-grid">
          <For each={props.pages}>
            {(page) => (
              <ThumbnailCell
                page={page}
                active={page.index === props.currentIndex}
                render={props.renderThumbnail}
                onSelect={props.onSelect}
              />
            )}
          </For>
        </div>
      </Show>
    </Show>
  );
}
