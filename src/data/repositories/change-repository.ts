import type { ChangeRow, LibraryDatabase } from '../db';

/**
 * Local outbox.
 *
 * A change stays here until the server confirms it. Entries are never dropped
 * on a failed push, and acknowledgements are per change id, so a partially
 * successful batch only retires the changes the server accepted.
 */
export class ChangeRepository {
  constructor(private readonly db: LibraryDatabase) {}

  async pendingCount(): Promise<number> {
    return this.db.changes.where('pushedAt').equals(0).count();
  }

  async listPending(limit = 100): Promise<ChangeRow[]> {
    return this.db.changes.where('pushedAt').equals(0).limit(limit).toArray();
  }

  async oldestPendingCreatedAt(): Promise<number | null> {
    const oldest = await this.db.changes.where('pushedAt').equals(0).sortBy('createdAt');
    return oldest.length > 0 ? (oldest[0]?.createdAt ?? null) : null;
  }

  /** Marks acknowledged change ids as pushed. Returns how many rows changed. */
  async markPushed(ids: readonly string[], pushedAt = Date.now()): Promise<number> {
    if (ids.length === 0) return 0;
    return this.db.changes
      .where('id')
      .anyOf([...ids])
      .modify({ pushedAt });
  }

  async totalCount(): Promise<number> {
    return this.db.changes.count();
  }

  /**
   * Retention housekeeping for acknowledged changes. Only safe once the pull
   * cursor has advanced past them, which is why it is opt-in rather than
   * automatic.
   */
  async clearPushedBefore(timestamp: number): Promise<number> {
    return this.db.changes.where('pushedAt').between(1, timestamp, true, true).delete();
  }
}
