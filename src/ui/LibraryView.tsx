import { A } from '@solidjs/router';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { displayAuthor, type Book } from '~/domain/book';
import { describeLocator } from '~/domain/locator';
import { progressFraction, statusLabel, type Progress } from '~/domain/progress';
import { READING_STATUSES, type ReadingStatus } from '~/domain/enums';
import type { BookLifecycle } from '~/domain/book';
import type { BookSort } from '~/data/book-mapping';
import type { Shelf, Tag } from '~/domain/collections';
import { useApp } from '~/app/context';
import type { ImportOutcome } from '~/services/import-service';
import BookCover from './BookCover';
import { StatusBadge } from './badges';

type LifecycleFilter = Extract<BookLifecycle, 'active' | 'archived'> | 'all';
type StatusFilter = ReadingStatus | 'all';

interface LibraryData {
  readonly books: readonly Book[];
  readonly progress: ReadonlyMap<string, Progress>;
  readonly shelves: readonly Shelf[];
  readonly tags: readonly Tag[];
  /** True when the library holds any browseable (active or archived) book. */
  readonly hasAnyBooks: boolean;
}

export default function LibraryView() {
  const app = useApp();
  const [search, setSearch] = createSignal('');
  const [sort, setSort] = createSignal<BookSort>('title');
  const [lifecycle, setLifecycle] = createSignal<LifecycleFilter>('active');
  const [statusFilter, setStatusFilter] = createSignal<StatusFilter>('all');
  const [shelfFilter, setShelfFilter] = createSignal<string>('all');
  const [tagFilter, setTagFilter] = createSignal<string>('all');
  const [refreshToken, setRefreshToken] = createSignal(0);
  const [importing, setImporting] = createSignal(false);
  const [outcomes, setOutcomes] = createSignal<readonly ImportOutcome[] | null>(null);

  const [library] = createResource<
    LibraryData,
    {
      search: string;
      sort: BookSort;
      lifecycle: LifecycleFilter;
      status: StatusFilter;
      shelf: string;
      tag: string;
      token: number;
    }
  >(
    () => ({
      search: search(),
      sort: sort(),
      lifecycle: lifecycle(),
      status: statusFilter(),
      shelf: shelfFilter(),
      tag: tagFilter(),
      token: refreshToken(),
    }),
    async ({ search: query, sort: order, lifecycle: life, status, shelf, tag }) => {
      const [books, progressRows, counts, shelves, tags, shelfBookIds, tagBookIds] =
        await Promise.all([
          app.books.list({ search: query, sort: order, lifecycle: life }),
          app.progress.listAll(),
          app.books.countByLifecycle(),
          app.shelves.list(),
          app.tags.list(),
          shelf === 'all' ? Promise.resolve(null) : app.shelves.listBookIds(shelf),
          tag === 'all' ? Promise.resolve(null) : app.tags.listBookIds(tag),
        ]);
      const progress = new Map(progressRows.map((entry) => [entry.bookId, entry]));
      const shelfSet = shelfBookIds === null ? null : new Set(shelfBookIds);
      const tagSet = tagBookIds === null ? null : new Set(tagBookIds);
      const filtered = books.filter((book) => {
        if (status !== 'all' && (progress.get(book.id)?.status ?? 'to_read') !== status) {
          return false;
        }
        if (shelfSet !== null && !shelfSet.has(book.id)) return false;
        if (tagSet !== null && !tagSet.has(book.id)) return false;
        return true;
      });
      return {
        books: filtered,
        progress,
        shelves,
        tags,
        hasAnyBooks: counts.active + counts.archived > 0,
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

        <div class="field">
          <label for="library-lifecycle">Show</label>
          <select
            id="library-lifecycle"
            value={lifecycle()}
            onChange={(event) => setLifecycle(event.currentTarget.value as LifecycleFilter)}
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </select>
        </div>

        <div class="field">
          <label for="library-status">Reading status</label>
          <select
            id="library-status"
            value={statusFilter()}
            onChange={(event) => setStatusFilter(event.currentTarget.value as StatusFilter)}
          >
            <option value="all">Any status</option>
            <For each={READING_STATUSES}>
              {(status) => <option value={status}>{statusLabel(status)}</option>}
            </For>
          </select>
        </div>

        <Show when={(library()?.shelves.length ?? 0) > 0}>
          <div class="field">
            <label for="library-shelf">Shelf</label>
            <select
              id="library-shelf"
              value={shelfFilter()}
              onChange={(event) => setShelfFilter(event.currentTarget.value)}
            >
              <option value="all">Any shelf</option>
              <For each={library()?.shelves ?? []}>
                {(shelf) => <option value={shelf.id}>{shelf.name}</option>}
              </For>
            </select>
          </div>
        </Show>

        <Show when={(library()?.tags.length ?? 0) > 0}>
          <div class="field">
            <label for="library-tag">Tag</label>
            <select
              id="library-tag"
              value={tagFilter()}
              onChange={(event) => setTagFilter(event.currentTarget.value)}
            >
              <option value="all">Any tag</option>
              <For each={library()?.tags ?? []}>
                {(tag) => <option value={tag.id}>{tag.name}</option>}
              </For>
            </select>
          </div>
        </Show>

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
              <Show
                when={data().hasAnyBooks}
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
                <div class="empty-state">
                  <h2>No matching books</h2>
                  <p>No books match the current search and filters.</p>
                </div>
              </Show>
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
    </section>
  );
}
