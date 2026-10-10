import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { Locator } from '~/domain/locator';
import type { ReaderPage } from '~/reader/renderer';

/** Longest edge of a sidebar thumbnail, in CSS pixels. */
const THUMB_MAX_EDGE = 180;

/**
 * One lazily-rendered thumbnail: it renders its page image only once scrolled
 * into view (IntersectionObserver), then caches it and revokes the object URL
 * on cleanup so a long book never holds hundreds of rasters at once.
 */
function ThumbnailCell(props: {
  page: ReaderPage;
  active: boolean;
  render: (index: number, maxEdge: number) => Promise<string | null>;
  onSelect: (locator: Locator) => void;
}) {
  const [url, setUrl] = createSignal<string | null>(null);
  let disposed = false;

  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    void props.render(props.page.index, THUMB_MAX_EDGE).then((result) => {
      if (result === null) return;
      if (disposed) URL.revokeObjectURL(result);
      else setUrl(result);
    });
  });

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
