import { AppError } from '~/domain/errors';
import { formatHlc } from '~/domain/hlc';
import { newId } from '~/domain/ids';
import {
  assertCollectionName,
  isMembershipActive,
  normalizeTagName,
  type Tag,
} from '~/domain/collections';
import type { BookTagRow, LibraryDatabase, TagRow } from '../db';
import { makeChangeRow, type MutationContext } from '../mutations';

/**
 * Reusable labels and their book memberships.
 *
 * Tags de-duplicate by case-folded name: creating a tag whose normalized name
 * already belongs to an active tag returns that tag instead of a duplicate.
 * Memberships use add/remove HLCs; every mutation co-writes its outbox row.
 */
export class TagRepository {
  constructor(
    private readonly db: LibraryDatabase,
    private readonly context: MutationContext,
  ) {}

  async list(): Promise<Tag[]> {
    const rows = await this.db.tags.toArray();
    return rows.filter((row) => !row.deleted).map(toTag);
  }

  /** Returns the existing active tag with this name, or creates one. */
  async ensure(name: string): Promise<Tag> {
    const clean = assertCollectionName(name, 'Tag');
    const normalized = normalizeTagName(clean);
    return this.db.transaction('rw', this.db.tags, this.db.changes, async () => {
      const matches = await this.db.tags.where('normalizedName').equals(normalized).toArray();
      const active = matches.find((row) => !row.deleted);
      if (active !== undefined) return toTag(active);
      const row: TagRow = {
        id: newId(),
        name: clean,
        normalizedName: normalized,
        updatedHlc: formatHlc(this.context.clock.next()),
        deleted: false,
      };
      await this.db.tags.add(row);
      await this.db.changes.add(makeChangeRow(this.context, 'tag', row.id, 'upsert', row));
      return toTag(row);
    });
  }

  async remove(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.tags, this.db.changes, async () => {
      const row = await this.db.tags.get(id);
      if (row === undefined || row.deleted) return;
      const next: TagRow = {
        ...row,
        deleted: true,
        updatedHlc: formatHlc(this.context.clock.next()),
      };
      await this.db.tags.put(next);
      await this.db.changes.add(makeChangeRow(this.context, 'tag', id, 'delete', next));
    });
  }

  async tagBook(tagId: string, bookId: string): Promise<void> {
    await this.writeMembership(tagId, bookId, true);
  }

  async untagBook(tagId: string, bookId: string): Promise<void> {
    await this.writeMembership(tagId, bookId, false);
  }

  async listBookIds(tagId: string): Promise<string[]> {
    const rows = await this.db.bookTags.where('tagId').equals(tagId).toArray();
    return rows.filter(isMembershipActive).map((row) => row.bookId);
  }

  async listTagIdsForBook(bookId: string): Promise<string[]> {
    const rows = await this.db.bookTags.where('bookId').equals(bookId).toArray();
    const activeIds = rows.filter(isMembershipActive).map((row) => row.tagId);
    if (activeIds.length === 0) return [];
    // Drop memberships whose tag was deleted, so a tombstoned tag never
    // surfaces through a reverse lookup.
    const tags = await this.db.tags.bulkGet(activeIds);
    return activeIds.filter((_, index) => {
      const tag = tags[index];
      return tag !== undefined && !tag.deleted;
    });
  }

  private async writeMembership(tagId: string, bookId: string, active: boolean): Promise<void> {
    await this.db.transaction('rw', this.db.tags, this.db.bookTags, this.db.changes, async () => {
      const tag = await this.db.tags.get(tagId);
      if (tag === undefined || tag.deleted) {
        throw new AppError('not_found', `Tag ${tagId} does not exist.`);
      }
      const hlc = formatHlc(this.context.clock.next());
      const existing = await this.db.bookTags.get([tagId, bookId]);
      const next: BookTagRow = active
        ? { tagId, bookId, addedHlc: hlc, removedHlc: undefined }
        : { tagId, bookId, addedHlc: existing?.addedHlc ?? hlc, removedHlc: hlc };
      await this.db.bookTags.put(next);
      await this.db.changes.add(
        makeChangeRow(this.context, 'book_tag', `${tagId}:${bookId}`, 'upsert', next),
      );
    });
  }
}

function toTag(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalizedName,
    updatedHlc: row.updatedHlc,
    deleted: row.deleted,
  };
}
