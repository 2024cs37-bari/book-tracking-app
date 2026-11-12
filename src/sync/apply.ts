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
import { mergeBook } from './book-merge';
import { moveBookReferences, resolveBookId } from './identity';
import { validatePullPayload } from './validate';
import { SyncHttpError } from './http-transport';
export { mergeBook } from './book-merge';

/**
 * How far two devices' reading positions must differ (as a fraction of the
 * book) before a remote update is held for the user to resolve rather than
 * applied LWW (docs/SYNC.md §6). This is a baseline to be tuned against real
 * usage, not a permanent constant (§11).
 */
export const PROGRESS_DIVERGENCE_THRESHOLD = 0.1;

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

/**
 * Applies one remote change to the local tables using the entity's conflict
 * rule (docs/SYNC.md §6). It writes only entity tables, never the outbox, so a
 * remote change never echoes back as a local mutation (invariant 5). Equal or
 * older writes are no-ops, which makes replay safe. A structurally invalid
 * payload aborts its page; the cursor never silently skips unprocessed data.
 *
 * Must run inside a transaction that covers every replicated table.
 */
export async function applyChange(db: LibraryDatabase, change: PullChange): Promise<void> {
  const payload = { ...validatePullPayload(change) } as Record<string, unknown>;
  if (typeof payload.bookId === 'string') payload.bookId = await resolveBookId(db, payload.bookId);

  switch (change.entity) {
    case 'book': {
      const row = payload as unknown as BookRow;
      const remoteId = row.id;
      row.id = await resolveBookId(db, remoteId);
      let local = await db.books.get(row.id);
      if (local !== undefined && local.sha256 !== row.sha256)
        throw new SyncHttpError('A remote book changed its content identity.', {
          retryable: false,
          code: 'identity_conflict',
        });
      if (local === undefined) {
        const sameContent = await db.books.where('sha256').equals(row.sha256).first();
        if (sameContent !== undefined) {
          assertSameOriginal(sameContent, row);
          const canonical = [sameContent.id, row.id].sort()[0]!;
          await moveBookReferences(db, sameContent.id, canonical);
          await moveBookReferences(db, row.id, canonical);
          await db.books.delete(sameContent.id);
          local = { ...sameContent, id: canonical };
          row.id = canonical;
        }
      }
      if (local === undefined) {
        await db.books.put(row);
        return;
      }
      assertSameOriginal(local, row);
      const merged = mergeBook(local, row);
      await db.books.put(merged);
      return;
    }
    case 'progress': {
      const row = payload as unknown as ProgressRow;
      if (typeof row.bookId !== 'string') return;
      const local = await db.progress.get(row.bookId);
      const pending = await db.progressConflicts.get(row.bookId);
      if (pending && !isNewer(row.updatedHlc, pending.remote.updatedHlc)) return;
      // Only a strictly newer remote position is a candidate at all.
      if (!isNewer(row.updatedHlc, local?.updatedHlc)) return;
      // Divergence between two different devices beyond the threshold is held
      // for the user: record both candidates and do NOT overwrite the local
      // position (§6). Replaying the same change re-records the same pending
      // conflict, so both candidates are preserved until the user chooses.
      if (
        local !== undefined &&
        row.deviceId !== local.deviceId &&
        Math.abs(row.fraction - local.fraction) >= PROGRESS_DIVERGENCE_THRESHOLD
      ) {
        await db.progressConflicts.put({
          bookId: row.bookId,
          remote: row,
          localFraction: local.fraction,
          localUpdatedHlc: local.updatedHlc,
        });
        return;
      }
      // Ordinary update: last-writer-wins, and any now-moot pending prompt for
      // this book is cleared.
      await db.progress.put(row);
      await db.progressConflicts.delete(row.bookId);
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

function assertSameOriginal(local: BookRow, remote: BookRow): void {
  if (local.sizeBytes !== remote.sizeBytes || local.format !== remote.format)
    throw new SyncHttpError('A remote book conflicts with the known original size or format.', {
      retryable: false,
      code: 'identity_conflict',
    });
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
 * checkpointed in that same transaction. A rollback may advance the in-memory
 * clock harmlessly; it never makes the durable clock or cursor run ahead.
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
      db.progressConflicts,
      db.deviceState,
      db.syncMeta,
    ],
    async () => {
      for (const change of changes) await applyChange(db, change);
      await syncMeta.setPullCursor(nextCursor);
      for (const change of changes) {
        const hlc = parseHlc(change.hlc);
        if (hlc) clock.observe(hlc);
      }
      const last = clock.last();
      if (last) await syncMeta.setClockState(last);
    },
  );
}
