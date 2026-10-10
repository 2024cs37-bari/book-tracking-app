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
import type { BookMetadataPatch } from '~/data/book-mapping';
import type { Shelf, Tag } from '~/domain/collections';
import type { Annotation } from '~/domain/annotation';
import { buildNotesMarkdown, notesFilename } from '~/services/notes-markdown';
import { bookFileKey } from '~/storage/file-store';
import { useApp } from '~/app/context';
import BookCover from './BookCover';
import { SupportNote, StatusBadge } from './badges';

interface DetailsData {
  readonly book: Book | undefined;
  readonly progress: Progress | undefined;
}

interface CollectionsData {
  readonly shelves: readonly Shelf[];
  readonly tags: readonly Tag[];
  readonly shelfIds: ReadonlySet<string>;
  readonly tagIds: ReadonlySet<string>;
}

export default function BookDetailsView() {
  const app = useApp();
  const params = useParams();
  const navigate = useNavigate();
  const [refreshToken, setRefreshToken] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal(false);
  const [editError, setEditError] = createSignal<string | null>(null);
  const [form, setForm] = createSignal<MetadataForm>(EMPTY_FORM);
  const [newShelf, setNewShelf] = createSignal('');
  const [newTag, setNewTag] = createSignal('');

  const bookId = createMemo(() => params.id ?? '');

  const [details, { refetch }] = createResource<DetailsData, string>(
    () => `${bookId()}:${refreshToken()}`,
    async () => {
      const id = bookId();
      const [book, progress] = await Promise.all([app.books.getById(id), app.progress.get(id)]);
      return { book, progress };
    },
  );

  const [collectionsToken, setCollectionsToken] = createSignal(0);
  const [collections] = createResource<CollectionsData, string>(
    () => `${bookId()}:${collectionsToken()}`,
    async () => {
      const id = bookId();
      const [shelves, tags, shelfIds, tagIds] = await Promise.all([
        app.shelves.list(),
        app.tags.list(),
        app.shelves.listShelfIdsForBook(id),
        app.tags.listTagIdsForBook(id),
      ]);
      return {
        shelves,
        tags,
        shelfIds: new Set(shelfIds),
        tagIds: new Set(tagIds),
      };
    },
  );

  const [annotations] = createResource<readonly Annotation[], string>(
    () => `${bookId()}:${refreshToken()}`,
    () => app.annotations.listByBook(bookId()),
  );

  function exportNotes(): void {
    const title = details()?.book?.title ?? 'Untitled book';
    const markdown = buildNotesMarkdown(title, annotations() ?? [], Date.now());
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = notesFilename(title);
    anchor.rel = 'noopener';
    anchor.click();
    // Keep the blob alive until the download starts; see ExportService.download.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function withCollections(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      void app.persistClockState();
      setCollectionsToken((token) => token + 1);
    } catch (error) {
      setMessage(`Could not update collections: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleShelf(shelfId: string, member: boolean): Promise<void> {
    const id = bookId();
    await withCollections(() =>
      member ? app.shelves.addBook(shelfId, id) : app.shelves.removeBook(shelfId, id),
    );
  }

  async function toggleTag(tagId: string, member: boolean): Promise<void> {
    const id = bookId();
    await withCollections(() =>
      member ? app.tags.tagBook(tagId, id) : app.tags.untagBook(tagId, id),
    );
  }

  async function createShelfForBook(name: string): Promise<void> {
    if (name.trim() === '') return;
    const id = bookId();
    await withCollections(async () => {
      const shelf = await app.shelves.create(name);
      await app.shelves.addBook(shelf.id, id);
    });
  }

  async function addTagForBook(name: string): Promise<void> {
    if (name.trim() === '') return;
    const id = bookId();
    await withCollections(async () => {
      const tag = await app.tags.ensure(name);
      await app.tags.tagBook(tag.id, id);
    });
  }

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

  function startEditing(book: Book): void {
    setForm({
      title: book.title,
      author: book.author ?? '',
      publisher: book.publisher ?? '',
      language: book.language ?? '',
      isbn: book.isbn ?? '',
      pageCount: book.pageCount === undefined ? '' : String(book.pageCount),
    });
    setEditError(null);
    setMessage(null);
    setEditing(true);
  }

  function updateField<K extends keyof MetadataForm>(field: K, value: string): void {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function saveEditing(): Promise<void> {
    const book = details()?.book;
    if (book === undefined) return;

    let patch: BookMetadataPatch;
    try {
      patch = formToPatch(form());
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
      return;
    }

    setBusy(true);
    setEditError(null);
    try {
      await app.books.updateMetadata(book.id, patch);
      void app.persistClockState();
      setEditing(false);
      setMessage('Book details updated.');
      setRefreshToken((token) => token + 1);
      await refetch();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
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
                      come from the filename. Use “Edit details” to correct it.
                    </p>
                  </Show>

                  <section class="annotations-review">
                    <h3>Notes &amp; highlights</h3>
                    <Show
                      when={(annotations() ?? []).length > 0}
                      fallback={
                        <p class="note">
                          No bookmarks, highlights or notes yet. Add them while reading.
                        </p>
                      }
                    >
                      <div class="panel-actions">
                        <button type="button" class="button" onClick={() => exportNotes()}>
                          Export notes as Markdown
                        </button>
                      </div>
                      <ul class="annotation-review-list">
                        <For each={annotations() ?? []}>
                          {(annotation) => (
                            <li class="annotation-review-row">
                              <span class="annotation-review-head">
                                <span class="reader-annotation-kind">
                                  {annotation.kind === 'highlight'
                                    ? 'Highlight'
                                    : annotation.kind === 'note'
                                      ? 'Note'
                                      : 'Bookmark'}
                                </span>{' '}
                                {Math.round(annotation.locator.fraction * 100)}%
                              </span>
                              <Show when={annotation.textExcerpt}>
                                {(excerpt) => (
                                  <blockquote class="annotation-review-excerpt">
                                    {excerpt()}
                                  </blockquote>
                                )}
                              </Show>
                              <Show when={annotation.note}>
                                {(note) => <p class="annotation-review-note">{note()}</p>}
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </section>

                  <section class="collections">
                    <h3>Collections</h3>
                    <Show when={collections()} fallback={<p class="note">Loading collections…</p>}>
                      {(data) => (
                        <>
                          <div class="collections-group">
                            <h4>Shelves</h4>
                            <Show
                              when={data().shelves.length > 0}
                              fallback={<p class="note">No shelves yet. Create one below.</p>}
                            >
                              <ul class="chip-list">
                                <For each={data().shelves}>
                                  {(shelf) => (
                                    <li>
                                      <label class="chip">
                                        <input
                                          type="checkbox"
                                          checked={data().shelfIds.has(shelf.id)}
                                          disabled={busy()}
                                          onChange={(event) =>
                                            void toggleShelf(shelf.id, event.currentTarget.checked)
                                          }
                                        />
                                        {shelf.name}
                                      </label>
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </Show>
                            <form
                              class="inline-form"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void createShelfForBook(newShelf());
                                setNewShelf('');
                              }}
                            >
                              <input
                                type="text"
                                aria-label="New shelf name"
                                placeholder="New shelf…"
                                value={newShelf()}
                                disabled={busy()}
                                onInput={(event) => setNewShelf(event.currentTarget.value)}
                              />
                              <button
                                type="submit"
                                class="button"
                                disabled={busy() || newShelf().trim() === ''}
                              >
                                Add shelf
                              </button>
                            </form>
                          </div>

                          <div class="collections-group">
                            <h4>Tags</h4>
                            <Show
                              when={
                                data().tags.filter((tag) => data().tagIds.has(tag.id)).length > 0
                              }
                              fallback={<p class="note">No tags on this book yet.</p>}
                            >
                              <ul class="chip-list">
                                <For each={data().tags.filter((tag) => data().tagIds.has(tag.id))}>
                                  {(tag) => (
                                    <li>
                                      <span class="chip chip-active">
                                        {tag.name}
                                        <button
                                          type="button"
                                          class="chip-remove"
                                          aria-label={`Remove tag ${tag.name}`}
                                          disabled={busy()}
                                          onClick={() => void toggleTag(tag.id, false)}
                                        >
                                          ×
                                        </button>
                                      </span>
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </Show>
                            <Show when={data().tags.some((tag) => !data().tagIds.has(tag.id))}>
                              <ul class="chip-list">
                                <For each={data().tags.filter((tag) => !data().tagIds.has(tag.id))}>
                                  {(tag) => (
                                    <li>
                                      <button
                                        type="button"
                                        class="chip chip-add"
                                        disabled={busy()}
                                        onClick={() => void toggleTag(tag.id, true)}
                                      >
                                        + {tag.name}
                                      </button>
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </Show>
                            <form
                              class="inline-form"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void addTagForBook(newTag());
                                setNewTag('');
                              }}
                            >
                              <input
                                type="text"
                                aria-label="New tag"
                                placeholder="New tag…"
                                value={newTag()}
                                disabled={busy()}
                                onInput={(event) => setNewTag(event.currentTarget.value)}
                              />
                              <button
                                type="submit"
                                class="button"
                                disabled={busy() || newTag().trim() === ''}
                              >
                                Add tag
                              </button>
                            </form>
                          </div>
                        </>
                      )}
                    </Show>
                  </section>

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

                    <Show when={!editing() && book().lifecycle !== 'deleted'}>
                      <button
                        type="button"
                        class="button"
                        disabled={busy()}
                        onClick={() => startEditing(book())}
                      >
                        Edit details
                      </button>
                    </Show>
                  </div>

                  <Show when={editing()}>
                    <form
                      class="metadata-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveEditing();
                      }}
                    >
                      <h3>Edit details</h3>
                      <div class="field">
                        <label for="edit-title">Title</label>
                        <input
                          id="edit-title"
                          type="text"
                          required
                          value={form().title}
                          disabled={busy()}
                          onInput={(event) => updateField('title', event.currentTarget.value)}
                        />
                      </div>
                      <div class="field">
                        <label for="edit-author">Author</label>
                        <input
                          id="edit-author"
                          type="text"
                          value={form().author}
                          disabled={busy()}
                          onInput={(event) => updateField('author', event.currentTarget.value)}
                        />
                      </div>
                      <div class="field">
                        <label for="edit-publisher">Publisher</label>
                        <input
                          id="edit-publisher"
                          type="text"
                          value={form().publisher}
                          disabled={busy()}
                          onInput={(event) => updateField('publisher', event.currentTarget.value)}
                        />
                      </div>
                      <div class="field">
                        <label for="edit-language">Language</label>
                        <input
                          id="edit-language"
                          type="text"
                          value={form().language}
                          disabled={busy()}
                          onInput={(event) => updateField('language', event.currentTarget.value)}
                        />
                      </div>
                      <div class="field">
                        <label for="edit-isbn">ISBN</label>
                        <input
                          id="edit-isbn"
                          type="text"
                          value={form().isbn}
                          disabled={busy()}
                          onInput={(event) => updateField('isbn', event.currentTarget.value)}
                        />
                      </div>
                      <div class="field">
                        <label for="edit-pages">Pages</label>
                        <input
                          id="edit-pages"
                          type="number"
                          min="0"
                          step="1"
                          inputmode="numeric"
                          value={form().pageCount}
                          disabled={busy()}
                          onInput={(event) => updateField('pageCount', event.currentTarget.value)}
                        />
                      </div>

                      <Show when={editError()}>
                        {(text) => (
                          <p class="note note-error" role="alert">
                            {text()}
                          </p>
                        )}
                      </Show>

                      <div class="details-actions">
                        <button type="submit" class="button button-primary" disabled={busy()}>
                          Save details
                        </button>
                        <button
                          type="button"
                          class="button"
                          disabled={busy()}
                          onClick={() => {
                            setEditing(false);
                            setEditError(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  </Show>

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

interface MetadataForm {
  readonly title: string;
  readonly author: string;
  readonly publisher: string;
  readonly language: string;
  readonly isbn: string;
  readonly pageCount: string;
}

const EMPTY_FORM: MetadataForm = {
  title: '',
  author: '',
  publisher: '',
  language: '',
  isbn: '',
  pageCount: '',
};

/**
 * Turns the edit form into a metadata patch. A blank text field clears the
 * stored value; the title is required. Saving a hand-curated record also
 * clears the `metadataIncomplete` flag, since the user has now vouched for it.
 */
function formToPatch(form: MetadataForm): BookMetadataPatch {
  const text = (value: string): string | undefined => {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const title = form.title.trim();
  if (title.length === 0) {
    throw new Error('Book title must not be empty.');
  }

  let pageCount: number | undefined;
  const rawPageCount = form.pageCount.trim();
  if (rawPageCount.length > 0) {
    const parsed = Number(rawPageCount);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error('Page count must be a whole number of pages or empty.');
    }
    pageCount = parsed;
  }

  return {
    title,
    author: text(form.author),
    publisher: text(form.publisher),
    language: text(form.language),
    isbn: text(form.isbn),
    pageCount,
    metadataIncomplete: false,
  };
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
