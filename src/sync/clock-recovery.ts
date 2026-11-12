import type { LibraryDatabase } from '~/data/db';
import { parseHlc, type Clock } from '~/domain/hlc';

/** Local mutations already write their HLC and outbox atomically. Recover from
 * those durable records even if a crash prevented the pagehide clock save. */
export async function recoverClock(db: LibraryDatabase, clock: Clock): Promise<void> {
  for (const table of [
    db.books,
    db.progress,
    db.annotations,
    db.shelves,
    db.shelfBooks,
    db.tags,
    db.bookTags,
    db.changes,
    db.progressConflicts,
  ]) {
    await table.each((value) => {
      const row = value as unknown as Record<string, unknown>;
      const visit = (candidate: unknown) => {
        if (typeof candidate === 'string') {
          const hlc = parseHlc(candidate);
          if (hlc) clock.restore(hlc);
        }
      };
      for (const key of ['hlc', 'updatedHlc', 'createdHlc', 'addedHlc', 'removedHlc'])
        visit(row[key]);
      if (row.remote !== null && typeof row.remote === 'object')
        visit((row.remote as Record<string, unknown>).updatedHlc);
      if (row.metadataHlcs !== null && typeof row.metadataHlcs === 'object')
        Object.values(row.metadataHlcs).forEach(visit);
    });
  }
}
