import { compareHlc, parseHlc, type Clock } from '~/domain/hlc';
import type {
  AnnotationRow,
  BookRow,
  BookTagRow,
  LibraryDatabase,
  ProgressRow,
  SessionRow,
  ShelfBookRow,
  ShelfRow,
  TagRow,
} from '~/data/db';
import type { SyncMetaRepository } from '~/data/repositories/sync-meta-repository';
import type { PullChange } from './protocol';

/** True when `candidate` is strictly newer than `existing` (or there is none). */
function isNewer(candidate: string | undefined, existing: string | undefined): boolean {
  if (candidate === undefined) return false;
  if (existing === undefined) return true;
  const a = parseHlc(candidate);
  const b = parseHlc(existing);
  if (a === null) return false;
  if (b === null) return true;
  return compareHlc(a, b) > 0;
}

function laterHlc(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return isNewer(a, b) ? a : b;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Picks a book-metadata string field: a non-empty value is always preferred
 * over an empty/absent one (so a newer edit that happens to lack an extracted
 * value never erases it); when both are non-empty and differ, the newer edit
 * wins. Returns undefined only when neither side has a value.
 */
function pickString(
  local: string | undefined,
  remote: string | undefined,
  remoteNewer: boolean,
): string | undefined {
  const l = nonEmptyString(local);
  const r = nonEmptyString(remote);
  if (l && r) return remoteNewer ? remote : local;
  if (r) return remote;
  if (l) return local;
  return undefined;
}

function pickNumber(
  local: number | undefined,
  remote: number | undefined,
  remoteNewer: boolean,
): number | undefined {
  const l = typeof local === 'number' && local > 0;
  const r = typeof remote === 'number' && remote > 0;
  if (l && r) return remoteNewer ? remote : local;
  if (r) return remote;
  if (l) return local;
  return undefined;
}

/**
 * Merges a remote book row into the local one per the §6 book-metadata policy:
 * non-empty extracted/user-edited metadata is preserved field by field (a newer
 * row never erases a value it simply lacks), while lifecycle fields (lifecycle,
 * archive/tombstone timestamps) move together with the HLC winner. The merge is
 * deterministic and order-independent, so every device that receives the same
 * set of change events converges on the same union without echoing a write.
 */
export function mergeBook(local: BookRow, remote: BookRow): BookRow {
  const remoteNewer = isNewer(remote.updatedHlc, local.updatedHlc);
  const lifecycleSource = remoteNewer ? remote : local;
  const author = pickString(local.author, remote.author, remoteNewer);
  const language = pickString(local.language, remote.language, remoteNewer);
  const coverKey = pickString(local.coverKey, remote.coverKey, remoteNewer);
  const isbn = pickString(local.isbn, remote.isbn, remoteNewer);
  const publisher = pickString(local.publisher, remote.publisher, remoteNewer);
  const pageCount = pickNumber(local.pageCount, remote.pageCount, remoteNewer);
  return {
    id: local.id,
    sha256: remoteNewer && nonEmptyString(remote.sha256) ? remote.sha256 : local.sha256,
    title: pickString(local.title, remote.title, remoteNewer) ?? local.title,
    format: local.format,
    sizeBytes: local.sizeBytes || remote.sizeBytes,
    // Incompleteness is monotonic: once any device marks metadata complete, the
    // merged row stays complete.
    metadataIncomplete: local.metadataIncomplete && remote.metadataIncomplete,
    lifecycle: lifecycleSource.lifecycle,
    addedAt: Math.min(local.addedAt, remote.addedAt),
    updatedHlc: laterHlc(local.updatedHlc, remote.updatedHlc) ?? local.updatedHlc,
    ...(author !== undefined ? { author } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(coverKey !== undefined ? { coverKey } : {}),
    ...(isbn !== undefined ? { isbn } : {}),
    ...(publisher !== undefined ? { publisher } : {}),
    ...(pageCount !== undefined ? { pageCount } : {}),
    ...(lifecycleSource.archivedAt !== undefined ? { archivedAt: lifecycleSource.archivedAt } : {}),
    ...(lifecycleSource.deletedAt !== undefined ? { deletedAt: lifecycleSource.deletedAt } : {}),
  };
}

/** Field-by-field equality for a merged book, to skip no-op writes. */
function sameBook(a: BookRow, b: BookRow): boolean {
  return (
    a.id === b.id &&
    a.sha256 === b.sha256 &&
    a.title === b.title &&
    a.author === b.author &&
    a.language === b.language &&
    a.format === b.format &&
    a.sizeBytes === b.sizeBytes &&
    a.coverKey === b.coverKey &&
    a.isbn === b.isbn &&
    a.publisher === b.publisher &&
    a.pageCount === b.pageCount &&
    a.metadataIncomplete === b.metadataIncomplete &&
    a.lifecycle === b.lifecycle &&
    a.addedAt === b.addedAt &&
    a.updatedHlc === b.updatedHlc &&
    a.archivedAt === b.archivedAt &&
    a.deletedAt === b.deletedAt
  );
}

/**
 * Applies one remote change to the local tables using the entity's conflict
 * rule (docs/SYNC.md §6). It writes only entity tables, never the outbox, so a
 * remote change never echoes back as a local mutation (invariant 5). Equal or
 * older writes are no-ops, which makes replay safe. A structurally invalid
 * payload is skipped rather than throwing, so one bad row cannot wedge sync.
 *
 * Must run inside a transaction that covers every replicated table.
 */
export async function applyChange(db: LibraryDatabase, change: PullChange): Promise<void> {
  const payload = change.payload;
  if (!isObject(payload)) return;

  switch (change.entity) {
    case 'book': {
      const row = payload as unknown as BookRow;
      if (typeof row.id !== 'string') return;
      const local = await db.books.get(row.id);
      // Per-field merge rather than whole-row LWW: a newer edit must not erase a
      // non-empty value it simply lacks (§6). First insert takes the row as-is.
      if (local === undefined) {
        await db.books.put(row);
        return;
      }
      const merged = mergeBook(local, row);
      if (!sameBook(local, merged)) await db.books.put(merged);
      return;
    }
    case 'progress': {
      const row = payload as unknown as ProgressRow;
      if (typeof row.bookId !== 'string') return;
      const local = await db.progress.get(row.bookId);
      if (isNewer(row.updatedHlc, local?.updatedHlc)) await db.progress.put(row);
      return;
    }
    case 'annotation': {
      const row = payload as unknown as AnnotationRow;
      if (typeof row.id !== 'string') return;
      const local = await db.annotations.get(row.id);
      if (isNewer(row.updatedHlc, local?.updatedHlc)) await db.annotations.put(row);
      return;
    }
    case 'shelf': {
      const row = payload as unknown as ShelfRow;
      if (typeof row.id !== 'string') return;
      const local = await db.shelves.get(row.id);
      if (isNewer(row.updatedHlc, local?.updatedHlc)) await db.shelves.put(row);
      return;
    }
    case 'tag': {
      const row = payload as unknown as TagRow;
      if (typeof row.id !== 'string') return;
      const local = await db.tags.get(row.id);
      if (isNewer(row.updatedHlc, local?.updatedHlc)) await db.tags.put(row);
      return;
    }
    case 'shelf_book': {
      const row = payload as unknown as ShelfBookRow;
      if (typeof row.shelfId !== 'string' || typeof row.bookId !== 'string') return;
      const local = await db.shelfBooks.get([row.shelfId, row.bookId]);
      await db.shelfBooks.put(mergeMembership(local, row));
      return;
    }
    case 'book_tag': {
      const row = payload as unknown as BookTagRow;
      if (typeof row.tagId !== 'string' || typeof row.bookId !== 'string') return;
      const local = await db.bookTags.get([row.tagId, row.bookId]);
      await db.bookTags.put({
        tagId: row.tagId,
        bookId: row.bookId,
        ...membershipHlcs(local, row),
      });
      return;
    }
    case 'session': {
      const row = payload as unknown as SessionRow;
      if (typeof row.id !== 'string') return;
      // Append-only and immutable: dedupe by id, newest-write-wins is moot.
      const local = await db.sessions.get(row.id);
      if (local === undefined) await db.sessions.put(row);
      return;
    }
  }
}

/** Latest add/remove across the two copies — a newer re-add beats an older remove. */
function membershipHlcs(
  local: { addedHlc: string; removedHlc?: string } | undefined,
  remote: { addedHlc: string; removedHlc?: string },
): { addedHlc: string; removedHlc?: string } {
  const addedHlc = laterHlc(local?.addedHlc, remote.addedHlc) ?? remote.addedHlc;
  const removedHlc = laterHlc(local?.removedHlc, remote.removedHlc);
  return removedHlc === undefined ? { addedHlc } : { addedHlc, removedHlc };
}

function mergeMembership(local: ShelfBookRow | undefined, remote: ShelfBookRow): ShelfBookRow {
  return { shelfId: remote.shelfId, bookId: remote.bookId, ...membershipHlcs(local, remote) };
}

/**
 * Applies a whole pull page and advances the cursor in one transaction
 * (invariant 4): if application fails nothing commits and the same page is
 * retried, so the cursor never runs ahead of applied data. The clock is
 * observed only after the commit, so a rollback cannot leave it advanced past
 * data the device did not actually store.
 */
export async function applyPullPage(
  db: LibraryDatabase,
  syncMeta: SyncMetaRepository,
  clock: Clock,
  changes: readonly PullChange[],
  nextCursor: number,
): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.books,
      db.progress,
      db.annotations,
      db.shelves,
      db.shelfBooks,
      db.tags,
      db.bookTags,
      db.sessions,
      db.syncMeta,
    ],
    async () => {
      for (const change of changes) await applyChange(db, change);
      await syncMeta.setPullCursor(nextCursor);
    },
  );
  for (const change of changes) {
    const hlc = parseHlc(change.hlc);
    if (hlc) clock.observe(hlc);
  }
}
