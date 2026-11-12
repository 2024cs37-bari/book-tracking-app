import type { DeviceStateRow, LibraryDatabase } from '../db';
import { resolveBookId } from '~/sync/identity';

/**
 * Per-device book availability.
 *
 * Deliberately local-only: whether a book is pinned or downloaded on this
 * device must never overwrite another device's decision.
 */
export class DeviceStateRepository {
  constructor(private readonly db: LibraryDatabase) {}

  async get(bookId: string): Promise<DeviceStateRow | undefined> {
    return this.db.transaction('r', [this.db.syncMeta, this.db.deviceState], async () =>
      this.db.deviceState.get(await resolveBookId(this.db, bookId)),
    );
  }

  private async ensure(bookId: string): Promise<DeviceStateRow> {
    const existing = await this.db.deviceState.get(bookId);
    if (existing !== undefined) return existing;
    return { bookId, filePresent: false, pinnedOffline: false };
  }

  async setPinned(bookId: string, pinnedOffline: boolean): Promise<DeviceStateRow> {
    return this.patch(bookId, { pinnedOffline });
  }

  async setFilePresent(bookId: string, filePresent: boolean): Promise<DeviceStateRow> {
    return this.patch(bookId, { filePresent });
  }

  async markOpened(bookId: string, at = Date.now()): Promise<DeviceStateRow> {
    return this.patch(bookId, { lastOpenedAt: at });
  }

  private async patch(bookId: string, fields: Partial<DeviceStateRow>): Promise<DeviceStateRow> {
    return this.db.transaction('rw', [this.db.syncMeta, this.db.deviceState], async () => {
      // A reader/download may finish after sync canonicalized the book it opened.
      // Resolve under the same transaction as the write so no stale device row is recreated.
      const canonicalId = await resolveBookId(this.db, bookId);
      const previous = await this.ensure(canonicalId);
      const row = { ...previous, ...fields, bookId: canonicalId };
      if (fields.lastOpenedAt !== undefined) {
        row.lastOpenedAt = Math.max(previous.lastOpenedAt ?? 0, fields.lastOpenedAt);
      }
      await this.db.deviceState.put(row);
      return row;
    });
  }

  async listPinned(): Promise<DeviceStateRow[]> {
    const rows = await this.db.deviceState.toArray();
    return rows.filter((row) => row.pinnedOffline);
  }

  async listWithLocalFile(): Promise<DeviceStateRow[]> {
    const rows = await this.db.deviceState.toArray();
    return rows.filter((row) => row.filePresent);
  }

  async remove(bookId: string): Promise<void> {
    await this.db.transaction('rw', [this.db.syncMeta, this.db.deviceState], async () => {
      await this.db.deviceState.delete(await resolveBookId(this.db, bookId));
    });
  }
}
