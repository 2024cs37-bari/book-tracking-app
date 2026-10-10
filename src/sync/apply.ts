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
      if (isNewer(row.updatedHlc, local?.updatedHlc)) await db.books.put(row);
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
