import { A } from '@solidjs/router';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { displayAuthor, type Book } from '~/domain/book';
import { describeLocator } from '~/domain/locator';
import { progressFraction, type Progress } from '~/domain/progress';
import type { BookSort } from '~/data/book-mapping';
import { useApp } from '~/app/context';
import type { ImportOutcome } from '~/services/import-service';
import BookCover from './BookCover';
import { StatusBadge } from './badges';

interface LibraryData {
  readonly books: readonly Book[];
  readonly progress: ReadonlyMap<string, Progress>;
}

export default function LibraryView() {
  const app = useApp();
  const [search, setSearch] = createSignal('');
  const [sort, setSort] = createSignal<BookSort>('title');
  const [refreshToken, setRefreshToken] = createSignal(0);
  const [importing, setImporting] = createSignal(false);
  const [outcomes, setOutcomes] = createSignal<readonly ImportOutcome[] | null>(null);

  const [library] = createResource<LibraryData, { search: string; sort: BookSort; token: number }>(
    () => ({ search: search(), sort: sort(), token: refreshToken() }),
    async ({ search: query, sort: order }) => {
      const [books, progressRows] = await Promise.all([
        app.books.list({ search: query, sort: order }),
        app.progress.listAll(),
      ]);
      return {
        books,
        progress: new Map(progressRows.map((entry) => [entry.bookId, entry])),
      };
    },
  );

  async function handleSelection(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = input.files;
    if (files === null || files.length === 0) return;

    const requests = Array.from(files).map((file) => ({ blob: file, filename: file.name }));
    setImporting(true);
    try {
      const results = await app.imports.importFiles(requests);
      setOutcomes(results);
      setRefreshToken((token) => token + 1);
      void app.persistClockState();
    } finally {
      setImporting(false);
      // Reset so selecting the same file again still fires a change event.
      input.value = '';
    }
  }

  const summary = createMemo(() => {
    const results = outcomes();
    if (results === null) return null;
    const imported = results.filter((outcome) => outcome.status === 'imported').length;
    const duplicates = results.filter((outcome) => outcome.status === 'duplicate').length;
    const rejected = results.filter(
      (outcome) => outcome.status === 'unsupported' || outcome.status === 'failed',
    ).length;
    const warnings = results.flatMap((outcome) =>
      outcome.status === 'imported' ? outcome.warnings : [],
    );
    return { imported, duplicates, rejected, warnings };
  });

  return (
    <section class="library">
      <div class="library-toolbar">
        <div class="field">
          <label for="library-search">Search</label>
          <input
            id="library-search"
            type="search"
            placeholder="Title, author, publisher or ISBN"
            value={search()}
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
        </div>

        <div class="field">
          <label for="library-sort">Sort</label>
          <select
            id="library-sort"
            value={sort()}
            onChange={(event) => setSort(event.currentTarget.value as BookSort)}
          >
            <option value="title">Title</option>
            <option value="author">Author</option>
            <option value="added_desc">Recently added</option>
            <option value="added_asc">Oldest first</option>
          </select>
        </div>

        <div class="field field-actions">
          <label for="library-import">Import books</label>
          <input
            id="library-import"
            type="file"
            multiple
            accept=".epub,.pdf,.mobi,.azw3,.fb2,.cbz,application/epub+zip,application/pdf"
            disabled={importing()}
            onChange={(event) => void handleSelection(event)}
          />
        </div>
      </div>

      <Show when={importing()}>
        <p class="note" role="status">
          Importing… large files are hashed and verified before they are added.
        </p>
      </Show>

      <Show when={summary()}>
        {(result) => (
          <div class="note note-result" role="status">
            <p>
              Imported {result().imported}
              {result().duplicates > 0 ? `, ${result().duplicates} already in the library` : ''}
              {result().rejected > 0 ? `, ${result().rejected} rejected` : ''}.
            </p>
            <Show when={result().warnings.length > 0}>
              <ul>
                <For each={result().warnings}>{(warning) => <li>{warning}</li>}</For>
              </ul>
            </Show>
          </div>
        )}
      </Show>

      <Show when={library.error}>
        <p class="note note-error" role="alert">
          The library could not be read: {String(library.error)}
        </p>
      </Show>

      <Show when={library()} fallback={<p class="note">Loading library…</p>}>
        {(data) => (
          <Show
            when={data().books.length > 0}
            fallback={
              <div class="empty-state">
                <h2>No books yet</h2>
                <p>
                  Import an EPUB or PDF to get started. Files stay in this browser; nothing is
                  uploaded.
                </p>
              </div>
            }
          >
            <ul class="book-grid">
              <For each={data().books}>
                {(book) => (
                  <li class="book-card">
                    <A href={`/book/${book.id}`}>
                      <BookCover book={book} />
                      <span class="book-card-text">
                        <span class="book-title">{book.title}</span>
                        <span class="book-author">{displayAuthor(book)}</span>
                        <span class="book-meta">
                          <StatusBadge status={data().progress.get(book.id)?.status ?? 'to_read'} />
                          <span class="book-position">
                            {describeLocator(data().progress.get(book.id)?.locator ?? null)}
                          </span>
                        </span>
                        <Show when={progressFraction(data().progress.get(book.id)) > 0}>
                          <progress
                            class="book-progress"
                            max="1"
                            value={progressFraction(data().progress.get(book.id))}
                            aria-label="Reading progress"
                          />
                        </Show>
                        <Show when={book.metadataIncomplete}>
                          <span class="badge badge-warning">Metadata incomplete</span>
                        </Show>
                      </span>
                    </A>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </Show>

      <Show when={!library.loading && library()?.books.length === 0 && search().trim().length > 0}>
        <p class="note">No books match “{search()}”.</p>
      </Show>
    </section>
  );
}
