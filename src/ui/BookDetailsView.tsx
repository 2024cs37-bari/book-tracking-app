import { A, useNavigate, useParams } from '@solidjs/router';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import {
  displayAuthor,
  displayPublisher,
  formatLabel,
  supportLabel,
  type Book,
} from '~/domain/book';
import { describeLocator } from '~/domain/locator';
import { progressFraction, statusLabel, type Progress } from '~/domain/progress';
import { READING_STATUSES } from '~/domain/enums';
import { bookFileKey } from '~/storage/file-store';
import { useApp } from '~/app/context';
import BookCover from './BookCover';
import { SupportNote, StatusBadge } from './badges';

interface DetailsData {
  readonly book: Book | undefined;
  readonly progress: Progress | undefined;
}

export default function BookDetailsView() {
  const app = useApp();
  const params = useParams();
  const navigate = useNavigate();
  const [refreshToken, setRefreshToken] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal<string | null>(null);

  const bookId = createMemo(() => params.id ?? '');

  const [details, { refetch }] = createResource<DetailsData, string>(
    () => `${bookId()}:${refreshToken()}`,
    async () => {
      const id = bookId();
      const [book, progress] = await Promise.all([app.books.getById(id), app.progress.get(id)]);
      return { book, progress };
    },
  );

  async function changeLifecycle(action: 'archive' | 'restore' | 'delete'): Promise<void> {
    const book = details()?.book;
    if (book === undefined) return;

    if (
      action === 'delete' &&
      !window.confirm(
        'Mark this book as deleted? Its file stays in the library until you remove it explicitly.',
      )
    ) {
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      await app.books.setLifecycle(
        book.id,
        action === 'archive' ? 'archived' : action === 'restore' ? 'active' : 'deleted',
      );
      void app.persistClockState();
      if (action === 'delete') {
        navigate('/');
        return;
      }
      setRefreshToken((token) => token + 1);
      await refetch();
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(status: (typeof READING_STATUSES)[number]): Promise<void> {
    const book = details()?.book;
    if (book === undefined) return;
    setBusy(true);
    setMessage(null);
    try {
      await app.progress.setStatus(book.id, status);
      setRefreshToken((token) => token + 1);
      await refetch();
    } finally {
      setBusy(false);
    }
  }

  async function checkFilePresence(): Promise<void> {
    const book = details()?.book;
    if (book === undefined) return;
    const present = await app.files.has(bookFileKey(book.sha256));
    await app.deviceState.setFilePresent(book.id, present);
    setRefreshToken((token) => token + 1);
    await refetch();
    setMessage(
      present
        ? 'The original file is present in local storage.'
        : 'The original file is missing from local storage in this browser.',
    );
  }

  return (
    <section class="details">
      <p class="back-link">
        <A href="/">← Library</A>
      </p>

      <Show when={details.error}>
        <p class="note note-error" role="alert">
          This book could not be loaded: {String(details.error)}
        </p>
      </Show>

      <Show when={details()} fallback={<p class="note">Loading book…</p>}>
        {(data) => (
          <Show
            when={data().book}
            fallback={
              <div class="empty-state">
                <h2>Book not found</h2>
                <p>This book is no longer in the library.</p>
              </div>
            }
          >
            {(book) => (
              <article class="details-card">
                <BookCover book={book()} variant="detail" />

                <div class="details-body">
                  <h2>{book().title}</h2>
                  <dl class="details-list">
                    <dt>Author</dt>
                    <dd>{displayAuthor(book())}</dd>
                    <dt>Format</dt>
                    <dd>
                      {formatLabel(book().format)} · {supportLabel(book().format)}
                    </dd>
                    <dt>Publisher</dt>
                    <dd>{displayPublisher(book())}</dd>
                    <Show when={book().language}>
                      {(language) => (
                        <>
                          <dt>Language</dt>
                          <dd>{language()}</dd>
                        </>
                      )}
                    </Show>
                    <Show when={book().isbn}>
                      {(isbn) => (
                        <>
                          <dt>ISBN</dt>
                          <dd>{isbn()}</dd>
                        </>
                      )}
                    </Show>
                    <Show when={book().pageCount}>
                      {(pages) => (
                        <>
                          <dt>Pages</dt>
                          <dd>{pages()}</dd>
                        </>
                      )}
                    </Show>
                    <dt>Added</dt>
                    <dd>{new Date(book().addedAt).toLocaleString()}</dd>
                    <dt>Size</dt>
                    <dd>{formatBytes(book().sizeBytes)}</dd>
                    <dt>Content hash</dt>
                    <dd class="mono">{book().sha256}</dd>
                    <dt>Lifecycle</dt>
                    <dd>{book().lifecycle}</dd>
                    <dt>Reading state</dt>
                    <dd>
                      <Show when={data().progress} fallback={<span>Not started</span>}>
                        {(progress) => (
                          <span class="inline-group">
                            <StatusBadge status={progress().status} />
                            <span>{describeLocator(progress().locator)}</span>
                            <Show when={progressFraction(progress()) > 0}>
                              <span>
                                {Math.round(progressFraction(progress()) * 100)}% complete
                              </span>
                            </Show>
                          </span>
                        )}
                      </Show>
                    </dd>
                  </dl>

                  <SupportNote format={book().format} />

                  <Show when={book().metadataIncomplete}>
                    <p class="note note-warning">
                      Some metadata could not be read from this file, so the title or author may
                      come from the filename. Editing metadata arrives with the annotation
                      milestone.
                    </p>
                  </Show>

                  <div class="details-actions">
                    <button
                      type="button"
                      class="button button-primary"
                      disabled={!app.renderers.has(book().format) || book().lifecycle === 'deleted'}
                      onClick={() => navigate(`/read/${book().id}`)}
                    >
                      {app.renderers.has(book().format) ? 'Read' : 'Reading not implemented'}
                    </button>

                    <Show when={book().lifecycle === 'active'}>
                      <button
                        type="button"
                        class="button"
                        disabled={busy()}
                        onClick={() => void changeLifecycle('archive')}
                      >
                        Archive
                      </button>
                    </Show>

                    <Show when={book().lifecycle !== 'active'}>
                      <button
                        type="button"
                        class="button"
                        disabled={busy()}
                        onClick={() => void changeLifecycle('restore')}
                      >
                        Restore to library
                      </button>
                    </Show>

                    <button
                      type="button"
                      class="button button-danger"
                      disabled={busy() || book().lifecycle === 'deleted'}
                      onClick={() => void changeLifecycle('delete')}
                    >
                      Mark as deleted
                    </button>
                  </div>

                  <Show when={book().lifecycle === 'active'}>
                    <div class="field">
                      <label for="reading-status">Reading status</label>
                      <select
                        id="reading-status"
                        value={data().progress?.status ?? 'to_read'}
                        disabled={busy()}
                        onChange={(event) =>
                          void changeStatus(
                            event.currentTarget.value as (typeof READING_STATUSES)[number],
                          )
                        }
                      >
                        <For each={READING_STATUSES}>
                          {(status) => <option value={status}>{statusLabel(status)}</option>}
                        </For>
                      </select>
                    </div>
                  </Show>

                  <details class="diagnostics">
                    <summary>Local file</summary>
                    <p>
                      Availability is tracked per device. Nothing here deletes the original; see the
                      data-lifecycle decision record.
                    </p>
                    <button type="button" class="button" onClick={() => void checkFilePresence()}>
                      Check local file
                    </button>
                  </details>

                  <Show when={message()}>
                    {(text) => (
                      <p class="note" role="status">
                        {text()}
                      </p>
                    )}
                  </Show>
                </div>
              </article>
            )}
          </Show>
        )}
      </Show>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
