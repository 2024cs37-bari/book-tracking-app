import type { DeviceStateRow, LibraryDatabase } from '../db';

/**
 * Per-device book availability.
 *
 * Deliberately local-only: whether a book is pinned or downloaded on this
 * device must never overwrite another device's decision.
 */
export class DeviceStateRepository {
  constructor(private readonly db: LibraryDatabase) {}

  async get(bookId: string): Promise<DeviceStateRow | undefined> {
    return this.db.deviceState.get(bookId);
  }

  private async ensure(bookId: string): Promise<DeviceStateRow> {
    const existing = await this.db.deviceState.get(bookId);
    if (existing !== undefined) return existing;
    return { bookId, filePresent: false, pinnedOffline: false };
  }

  async setPinned(bookId: string, pinnedOffline: boolean): Promise<DeviceStateRow> {
    const row = { ...(await this.ensure(bookId)), pinnedOffline };
    await this.db.deviceState.put(row);
    return row;
  }

  async setFilePresent(bookId: string, filePresent: boolean): Promise<DeviceStateRow> {
    const row = { ...(await this.ensure(bookId)), filePresent };
    await this.db.deviceState.put(row);
    return row;
  }

  async markOpened(bookId: string, at = Date.now()): Promise<DeviceStateRow> {
    const row = { ...(await this.ensure(bookId)), lastOpenedAt: at };
    await this.db.deviceState.put(row);
    return row;
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
    await this.db.deviceState.delete(bookId);
  }
}
