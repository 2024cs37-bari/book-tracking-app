import { AppError } from '~/domain/errors';
import { formatHlc } from '~/domain/hlc';
import { newId } from '~/domain/ids';
import { assertCollectionName, isMembershipActive, type Shelf } from '~/domain/collections';
import type { LibraryDatabase, ShelfBookRow, ShelfRow } from '../db';
import { makeChangeRow, type MutationContext } from '../mutations';

/**
 * Named collections and their book memberships.
 *
 * Shelves tombstone on delete; memberships are add/remove-HLC pairs rather than
 * row deletes, so a membership is active when it has no removal newer than its
 * add. Every mutation co-writes its outbox row in one transaction.
 */
export class ShelfRepository {
  constructor(
    private readonly db: LibraryDatabase,
    private readonly context: MutationContext,
  ) {}

  async list(): Promise<Shelf[]> {
    const rows = await this.db.shelves.toArray();
    return rows.filter((row) => !row.deleted).map(toShelf);
  }

  async create(name: string): Promise<Shelf> {
    const clean = assertCollectionName(name, 'Shelf');
    const row: ShelfRow = {
      id: newId(),
      name: clean,
      updatedHlc: formatHlc(this.context.clock.next()),
      deleted: false,
    };
    await this.db.transaction('rw', this.db.shelves, this.db.changes, async () => {
      await this.db.shelves.add(row);
      await this.db.changes.add(makeChangeRow(this.context, 'shelf', row.id, 'upsert', row));
    });
    return toShelf(row);
  }

  async rename(id: string, name: string): Promise<Shelf> {
    const clean = assertCollectionName(name, 'Shelf');
    return this.db.transaction('rw', this.db.shelves, this.db.changes, async () => {
      const row = await this.requireShelf(id);
      const next: ShelfRow = {
        ...row,
        name: clean,
        updatedHlc: formatHlc(this.context.clock.next()),
      };
      await this.db.shelves.put(next);
      await this.db.changes.add(makeChangeRow(this.context, 'shelf', id, 'upsert', next));
      return toShelf(next);
    });
  }

  async remove(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.shelves, this.db.changes, async () => {
      const row = await this.db.shelves.get(id);
      if (row === undefined || row.deleted) return;
      const next: ShelfRow = {
        ...row,
        deleted: true,
        updatedHlc: formatHlc(this.context.clock.next()),
      };
      await this.db.shelves.put(next);
      await this.db.changes.add(makeChangeRow(this.context, 'shelf', id, 'delete', next));
    });
  }

  async addBook(shelfId: string, bookId: string): Promise<void> {
    await this.writeMembership(shelfId, bookId, true);
  }

  async removeBook(shelfId: string, bookId: string): Promise<void> {
    await this.writeMembership(shelfId, bookId, false);
  }

  async listBookIds(shelfId: string): Promise<string[]> {
    const rows = await this.db.shelfBooks.where('shelfId').equals(shelfId).toArray();
    return rows.filter(isMembershipActive).map((row) => row.bookId);
  }

  async listShelfIdsForBook(bookId: string): Promise<string[]> {
    const rows = await this.db.shelfBooks.where('bookId').equals(bookId).toArray();
    const activeIds = rows.filter(isMembershipActive).map((row) => row.shelfId);
    if (activeIds.length === 0) return [];
    // Drop memberships whose shelf was deleted, so a tombstoned shelf never
    // surfaces through a reverse lookup.
    const shelves = await this.db.shelves.bulkGet(activeIds);
    return activeIds.filter((_, index) => {
      const shelf = shelves[index];
      return shelf !== undefined && !shelf.deleted;
    });
  }

  private async requireShelf(id: string): Promise<ShelfRow> {
    const row = await this.db.shelves.get(id);
    if (row === undefined || row.deleted) {
      throw new AppError('not_found', `Shelf ${id} does not exist.`);
    }
    return row;
  }

  private async writeMembership(shelfId: string, bookId: string, active: boolean): Promise<void> {
    await this.db.transaction(
      'rw',
      this.db.shelves,
      this.db.shelfBooks,
      this.db.changes,
      async () => {
        await this.requireShelf(shelfId);
        const hlc = formatHlc(this.context.clock.next());
        const existing = await this.db.shelfBooks.get([shelfId, bookId]);
        const next: ShelfBookRow = active
          ? { shelfId, bookId, addedHlc: hlc, removedHlc: undefined }
          : { shelfId, bookId, addedHlc: existing?.addedHlc ?? hlc, removedHlc: hlc };
        await this.db.shelfBooks.put(next);
        await this.db.changes.add(
          makeChangeRow(this.context, 'shelf_book', `${shelfId}:${bookId}`, 'upsert', next),
        );
      },
    );
  }
}

function toShelf(row: ShelfRow): Shelf {
  return { id: row.id, name: row.name, updatedHlc: row.updatedHlc, deleted: row.deleted };
}
