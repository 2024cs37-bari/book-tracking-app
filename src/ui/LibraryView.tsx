import { useLibraryRevision } from './use-library-revision';
import { A } from '@solidjs/router';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { displayAuthor, type Book } from '~/domain/book';
import { describeLocator } from '~/domain/locator';
import { progressFraction, statusLabel, type Progress } from '~/domain/progress';
import {
  BOOK_FORMATS,
  BOOK_FORMAT_LABELS,
  READING_STATUSES,
  type BookFormat,
  type ReadingStatus,
} from '~/domain/enums';
import type { BookLifecycle } from '~/domain/book';
import type { BookSort } from '~/data/book-mapping';
import type { Shelf, Tag } from '~/domain/collections';
import { useApp } from '~/app/context';
import type { ImportOutcome } from '~/services/import-service';
import BookCover from './BookCover';
import { StatusBadge } from './badges';
import Icon from './Icon';
import Select from './Select';
import '~/styles/library.css';

type LifecycleFilter = Extract<BookLifecycle, 'active' | 'archived'> | 'all';
type StatusFilter = ReadingStatus | 'all';
type FormatFilter = BookFormat | 'all';

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
  const revision = useLibraryRevision();
  let importInput: HTMLInputElement | undefined;
  let filterButton: HTMLButtonElement | undefined;
  const [filtersOpen, setFiltersOpen] = createSignal(false);
  const [search, setSearch] = createSignal('');
  const [sort, setSort] = createSignal<BookSort>('title');
  const [lifecycle, setLifecycle] = createSignal<LifecycleFilter>('active');
  const [statusFilter, setStatusFilter] = createSignal<StatusFilter>('all');
  const [formatFilter, setFormatFilter] = createSignal<FormatFilter>('all');
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
      format: FormatFilter;
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
      format: formatFilter(),
      shelf: shelfFilter(),
      tag: tagFilter(),
      token: refreshToken() + revision(),
    }),
    async ({ search: query, sort: order, lifecycle: life, status, format, shelf, tag }) => {
      const [books, progressRows, counts, shelves, tags, shelfBookIds, tagBookIds] =
        await Promise.all([
          app.books.list({
            search: query,
            sort: order,
            lifecycle: life,
            format: format === 'all' ? undefined : format,
          }),
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

  // Repository refreshes produce new row objects. Key cards by persistent IDs so an
  // incoming commit cannot replace a focused link between pointer down and click.
  const booksById = createMemo(
    () => new Map((library()?.books ?? []).map((book) => [book.id, book])),
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

  const extraFilterCount = () =>
    Number(lifecycle() !== 'active') +
    Number(formatFilter() !== 'all') +
    Number(shelfFilter() !== 'all') +
    Number(tagFilter() !== 'all') +
    Number(statusFilter() === 'abandoned');

  function clearFilters(): void {
    setSearch('');
    setLifecycle('active');
    setStatusFilter('all');
    setFormatFilter('all');
    setShelfFilter('all');
    setTagFilter('all');
  }

  return (
    <section class="library" aria-labelledby="library-heading">
      <header class="library-heading">
        <div>
          <p class="eyebrow">A little space for your books</p>
          <h1 id="library-heading">Your library</h1>
        </div>
        <div class="library-import-action">
          <button
            class="button button-primary"
            type="button"
            disabled={importing()}
            onClick={() => importInput?.click()}
          >
            <Icon name="plus" size={18} />
            {importing() ? 'Importing…' : 'Add books'}
          </button>
          <label class="sr-only" for="library-import">
            Import books
          </label>
          <input
            ref={(element) => {
              importInput = element;
            }}
            class="sr-only"
            id="library-import"
            type="file"
            multiple
            accept=".epub,.pdf,.mobi,.azw3,.fb2,.cbz,application/epub+zip,application/pdf"
            disabled={importing()}
            tabIndex={-1}
            onChange={(event) => void handleSelection(event)}
          />
        </div>
      </header>

      <div class="library-toolbar">
        <div class="library-status-tabs" role="group" aria-label="Reading status">
          <For each={['all', 'reading', 'to_read', 'finished'] as const}>
            {(status) => (
              <button
                type="button"
                class="library-status-tab"
                aria-pressed={statusFilter() === status}
                onClick={() => setStatusFilter(status)}
              >
                {status === 'all' ? 'All books' : statusLabel(status)}
              </button>
            )}
          </For>
        </div>
        <div class="library-tools">
          <div class="library-search">
            <Icon name="search" size={17} />
            <label class="sr-only" for="library-search">
              Search
            </label>
            <input
              id="library-search"
              type="search"
              placeholder="Search your books"
              value={search()}
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
          </div>
          <button
            class="button library-filter-toggle"
            ref={(element) => {
              filterButton = element;
            }}
            type="button"
            aria-expanded={filtersOpen()}
            aria-controls="library-filters"
            onClick={() => setFiltersOpen(!filtersOpen())}
          >
            <Icon name="sliders" size={17} />
            <span>Filters</span>
            <Show when={extraFilterCount() > 0}>
              <span class="filter-count">{extraFilterCount()}</span>
            </Show>
          </button>
        </div>
      </div>

      <div
        id="library-filters"
        class="library-filter-panel"
        data-open={filtersOpen()}
        aria-hidden={!filtersOpen()}
        inert={!filtersOpen()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setFiltersOpen(false);
            filterButton?.focus();
          }
        }}
      >
        <div class="library-filter-clip">
          <div class="library-filter-fields">
            <div class="field">
              <label for="library-lifecycle">Show</label>
              <Select<LifecycleFilter>
                id="library-lifecycle"
                value={lifecycle()}
                onChange={setLifecycle}
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'archived', label: 'Archived' },
                  { value: 'all', label: 'All' },
                ]}
              />
            </div>
            <div class="field">
              <label for="library-status">Reading status</label>
              <Select<StatusFilter>
                id="library-status"
                value={statusFilter()}
                onChange={setStatusFilter}
                options={[
                  { value: 'all', label: 'Any status' },
                  ...READING_STATUSES.map((status) => ({
                    value: status,
                    label: statusLabel(status),
                  })),
                ]}
              />
            </div>
            <div class="field">
              <label for="library-format">Format</label>
              <Select<FormatFilter>
                id="library-format"
                value={formatFilter()}
                onChange={setFormatFilter}
                options={[
                  { value: 'all', label: 'Any format' },
                  ...BOOK_FORMATS.map((format) => ({
                    value: format,
                    label: BOOK_FORMAT_LABELS[format],
                  })),
                ]}
              />
            </div>
            <Show when={(library()?.shelves.length ?? 0) > 0}>
              <div class="field">
                <label for="library-shelf">Shelf</label>
                <Select
                  id="library-shelf"
                  value={shelfFilter()}
                  onChange={setShelfFilter}
                  options={[
                    { value: 'all', label: 'Any shelf' },
                    ...(library()?.shelves ?? []).map((item) => ({
                      value: item.id,
                      label: item.name,
                    })),
                  ]}
                />
              </div>
            </Show>
            <Show when={(library()?.tags.length ?? 0) > 0}>
              <div class="field">
                <label for="library-tag">Tag</label>
                <Select
                  id="library-tag"
                  value={tagFilter()}
                  onChange={setTagFilter}
                  options={[
                    { value: 'all', label: 'Any tag' },
                    ...(library()?.tags ?? []).map((item) => ({
                      value: item.id,
                      label: item.name,
                    })),
                  ]}
                />
              </div>
            </Show>
            <button type="button" class="button" onClick={clearFilters}>
              Reset filters
            </button>
          </div>
        </div>
      </div>

      <div class="library-shelf-heading">
        <p aria-live="polite">
          {library()?.books.length ?? 0} {(library()?.books.length ?? 0) === 1 ? 'book' : 'books'}
          <Show when={search() || extraFilterCount() > 0 || statusFilter() !== 'all'}>
            {' '}
            in this view
          </Show>
        </p>
        <div class="library-sort">
          <label for="library-sort">Sort by</label>
          <Select<BookSort>
            id="library-sort"
            value={sort()}
            onChange={setSort}
            options={[
              { value: 'title', label: 'Title' },
              { value: 'author', label: 'Author' },
              { value: 'added_desc', label: 'Recently added' },
              { value: 'added_asc', label: 'Oldest first' },
            ]}
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
                    <div class="empty-library-art" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                    <p class="eyebrow">Make yourself at home</p>
                    <h2>Your next chapter starts here.</h2>
                    <p>
                      Import an EPUB or PDF to get started. Originals are kept on this device
                      {app.background ? ' and backed up to your configured sync server.' : '.'}
                    </p>
                    <button
                      type="button"
                      class="button empty-library-action"
                      disabled={importing()}
                      onClick={() => importInput?.click()}
                    >
                      Choose your first book <Icon name="arrow-right" size={18} />
                    </button>
                  </div>
                }
              >
                <div class="empty-state">
                  <h2>No matching books</h2>
                  <p>Try a different title, author, or filter.</p>
                  <button type="button" class="button" onClick={clearFilters}>
                    Clear search and filters <Icon name="arrow-right" size={18} />
                  </button>
                </div>
              </Show>
            }
          >
            <ul class="book-grid">
              <For each={[...booksById().keys()]}>
                {(id) => {
                  const initial = booksById().get(id)!;
                  const book = () => booksById().get(id) ?? initial;
                  return (
                    <li class="book-card">
                      <A href={`/book/${id}`}>
                        <span class="book-cover-stage">
                          <BookCover book={book()} />
                          <span class="book-open-hint" aria-hidden="true">
                            <Icon name="arrow-right" size={18} />
                          </span>
                        </span>
                        <span class="book-card-text">
                          <span class="book-title">{book().title}</span>
                          <span class="book-author">{displayAuthor(book())}</span>
                          <span class="book-meta">
                            <StatusBadge status={data().progress.get(id)?.status ?? 'to_read'} />
                            <Show when={data().progress.get(id)?.locator}>
                              <span
                                class="book-position"
                                title={describeLocator(data().progress.get(id)?.locator ?? null)}
                              >
                                {Math.round(progressFraction(data().progress.get(id)) * 100)}%
                              </span>
                            </Show>
                          </span>
                          <Show when={progressFraction(data().progress.get(id)) > 0}>
                            <progress
                              class="book-progress"
                              max="1"
                              value={progressFraction(data().progress.get(id))}
                              aria-label="Reading progress"
                            />
                          </Show>
                          <Show when={book().metadataIncomplete}>
                            <span class="badge badge-warning">Metadata incomplete</span>
                          </Show>
                        </span>
                      </A>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </section>
  );
}
