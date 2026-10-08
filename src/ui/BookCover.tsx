import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { Book } from '~/domain/book';
import { useApp } from '~/app/context';
import { BookFormatBadge } from './badges';

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

  createEffect(() => {
    const key = props.book.coverKey;
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
        setUrl(null);
      });

    onCleanup(() => {
      disposed = true;
      if (created !== null) URL.revokeObjectURL(created);
    });
  });

  return (
    <div class={`cover cover-${props.variant ?? 'card'}`} aria-hidden="true">
      {url() === null ? (
        <span class="cover-placeholder">
          <BookFormatBadge format={props.book.format} />
        </span>
      ) : (
        <img src={url()!} alt="" loading="lazy" decoding="async" />
      )}
    </div>
  );
}
