import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { Book } from '~/domain/book';
import { useApp } from '~/app/context';
import { BOOK_FORMAT_LABELS } from '~/domain/enums';

/**
 * Renders a stored cover image.
 *
 * Covers live in the file store rather than the metadata database, so the blob
 * is fetched and converted to an object URL. The URL is revoked when the book
 * changes or the component is disposed, otherwise every navigation would leak
 * a blob reference.
 */
export default function BookCover(props: { book: Book; variant?: 'card' | 'detail' }) {
  const app = useApp();
  const [url, setUrl] = createSignal<string | null>(null);
  const coverKey = createMemo(() => props.book.coverKey);

  createEffect(() => {
    const key = coverKey();
    setUrl(null);
    if (key === undefined) return;

    let disposed = false;
    let created: string | null = null;

    void app.files
      .get(key)
      .then((blob) => {
        if (disposed) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch(() => {
        // A missing or unreadable cover is presented as "no cover".
        if (!disposed) setUrl(null);
      });

    onCleanup(() => {
      disposed = true;
      if (created !== null) URL.revokeObjectURL(created);
    });
  });

  return (
    <div
      class={`cover cover-${props.variant ?? 'card'}`}
      data-cover-tone={
        Array.from(props.book.id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6
      }
      aria-hidden="true"
    >
      {url() === null ? (
        <span class="cover-placeholder">
          <span class="cover-edition">
            {BOOK_FORMAT_LABELS[props.book.format]} · PERSONAL LIBRARY
          </span>
          <span class="cover-rule" />
          <span class="cover-placeholder-title">{props.book.title}</span>
          <span class="cover-placeholder-author">{props.book.author ?? 'Unknown author'}</span>
          <span class="cover-ornament">✳</span>
        </span>
      ) : (
        <img src={url()!} alt="" loading="lazy" decoding="async" />
      )}
    </div>
  );
}
