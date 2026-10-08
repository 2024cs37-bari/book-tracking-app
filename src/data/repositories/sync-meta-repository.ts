import { formatHlc, parseHlc, type Hlc } from '~/domain/hlc';
import { newId } from '~/domain/ids';
import type { LibraryDatabase } from '../db';

export const SYNC_META_KEYS = {
  deviceId: 'device_id',
  pullCursor: 'pull_cursor',
  clockState: 'hlc_state',
  schemaVersion: 'schema_version',
} as const;

/**
 * Key/value store for device identity, the pull cursor and persisted clock
 * state. Nothing here is replicated to the server: these values describe this
 * installation.
 */
export class SyncMetaRepository {
  constructor(private readonly db: LibraryDatabase) {}

  async get(key: string): Promise<string | undefined> {
    const row = await this.db.syncMeta.get(key);
    return row?.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.syncMeta.put({ key, value });
  }

  async remove(key: string): Promise<void> {
    await this.db.syncMeta.delete(key);
  }

  /**
   * Returns this installation's stable device id, creating one on first run.
   *
   * A reinstall legitimately produces a new id: device id is a tie-breaker and
   * a diagnostic, never a credential.
   */
  async getOrCreateDeviceId(): Promise<string> {
    const existing = await this.get(SYNC_META_KEYS.deviceId);
    if (existing !== undefined && existing.length > 0) return existing;
    const created = newId();
    await this.set(SYNC_META_KEYS.deviceId, created);
    return created;
  }

  async getPullCursor(): Promise<number> {
    const raw = await this.get(SYNC_META_KEYS.pullCursor);
    if (raw === undefined) return 0;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  async setPullCursor(sequence: number): Promise<void> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error('Pull cursor must be a non-negative integer.');
    }
    await this.set(SYNC_META_KEYS.pullCursor, String(sequence));
  }

  async getClockState(): Promise<Hlc | null> {
    const raw = await this.get(SYNC_META_KEYS.clockState);
    return raw === undefined ? null : parseHlc(raw);
  }

  async setClockState(hlc: Hlc): Promise<void> {
    await this.set(SYNC_META_KEYS.clockState, formatHlc(hlc));
  }
}
