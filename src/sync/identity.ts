import type { LibraryDatabase, ProgressRow } from '~/data/db';
import { compareHlc, parseHlc } from '~/domain/hlc';

export const BOOK_ALIAS_PREFIX = 'book_alias:';
export async function resolveBookId(db: LibraryDatabase, id: string): Promise<string> {
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const alias = await db.syncMeta.get(`${BOOK_ALIAS_PREFIX}${id}`);
    if (!alias) return id;
    id = alias.value;
  }
  throw new Error('Cyclic book identity aliases.');
}
function newer(a: string, b: string): boolean {
  const left = parseHlc(a),
    right = parseHlc(b);
  return left !== null && (right === null || compareHlc(left, right) > 0);
}
/** Preserve both divergent progress candidates when two imported IDs collapse. */
export async function mergeDuplicateProgress(
  db: LibraryDatabase,
  id: string,
  incoming: ProgressRow,
): Promise<void> {
  const candidate = { ...incoming, bookId: id };
  const current = await db.progress.get(id);
  if (!current) {
    await db.progress.put(candidate);
    return;
  }
  const winner = newer(candidate.updatedHlc, current.updatedHlc) ? candidate : current;
  const other = winner === candidate ? current : candidate;
  if (Math.abs(winner.fraction - other.fraction) >= 0.1 && winner.deviceId !== other.deviceId) {
    await db.progress.put(other);
    await db.progressConflicts.put({
      bookId: id,
      remote: winner,
      localFraction: other.fraction,
      localUpdatedHlc: other.updatedHlc,
    });
  } else await db.progress.put(winner);
}
/** Moves local references atomically; original outbox bytes and change IDs stay immutable. */
export async function moveBookReferences(
  db: LibraryDatabase,
  from: string,
  to: string,
): Promise<void> {
  if (from === to) return;
  await db.syncMeta.put({ key: `${BOOK_ALIAS_PREFIX}${from}`, value: to });
  const progress = await db.progress.get(from);
  if (progress) {
    await mergeDuplicateProgress(db, to, progress);
    await db.progress.delete(from);
  }
  const conflict = await db.progressConflicts.get(from);
  if (conflict) {
    const existing = await db.progressConflicts.get(to);
    if (!existing || newer(conflict.remote.updatedHlc, existing.remote.updatedHlc))
      await db.progressConflicts.put({
        ...conflict,
        bookId: to,
        remote: { ...conflict.remote, bookId: to },
      });
    await db.progressConflicts.delete(from);
  }
  await db.annotations.where('bookId').equals(from).modify({ bookId: to });
  await db.sessions.where('bookId').equals(from).modify({ bookId: to });
  for (const row of await db.shelfBooks.where('bookId').equals(from).toArray()) {
    const local = await db.shelfBooks.get([row.shelfId, to]);
    await db.shelfBooks.put({
      ...row,
      bookId: to,
      addedHlc: local && newer(local.addedHlc, row.addedHlc) ? local.addedHlc : row.addedHlc,
      removedHlc: later(local?.removedHlc, row.removedHlc),
    });
    await db.shelfBooks.delete([row.shelfId, from]);
  }
  for (const row of await db.bookTags.where('bookId').equals(from).toArray()) {
    const local = await db.bookTags.get([row.tagId, to]);
    await db.bookTags.put({
      ...row,
      bookId: to,
      addedHlc: local && newer(local.addedHlc, row.addedHlc) ? local.addedHlc : row.addedHlc,
      removedHlc: later(local?.removedHlc, row.removedHlc),
    });
    await db.bookTags.delete([row.tagId, from]);
  }
  const state = await db.deviceState.get(from);
  if (state) {
    const existing = await db.deviceState.get(to);
    await db.deviceState.put({
      ...state,
      bookId: to,
      filePresent: state.filePresent || (existing?.filePresent ?? false),
      pinnedOffline: state.pinnedOffline || (existing?.pinnedOffline ?? false),
      lastOpenedAt: Math.max(state.lastOpenedAt ?? 0, existing?.lastOpenedAt ?? 0) || undefined,
    });
    await db.deviceState.delete(from);
  }
}
function later(a: string | undefined, b: string | undefined): string | undefined {
  return a === undefined ? b : b === undefined || newer(a, b) ? a : b;
}
