import { newId } from '~/domain/ids';
import {
  normalizeSession,
  summarizeSessions,
  type NewReadingSession,
  type ReadingSession,
  type ReadingStats,
} from '~/domain/session';
import type { LibraryDatabase, SessionRow } from '../db';
import { makeChangeRow, type MutationContext } from '../mutations';

/**
 * Append-only reading-activity log. Sessions are never mutated after they are
 * recorded; statistics are derived on read, not stored as synced aggregates
 * (DATA-MODEL.md §7). Each recorded session co-writes its outbox row.
 */
export class SessionRepository {
  constructor(
    private readonly db: LibraryDatabase,
    private readonly context: MutationContext,
  ) {}

  async record(input: NewReadingSession): Promise<ReadingSession> {
    const normalized = normalizeSession(input);
    const row: SessionRow = {
      id: newId(),
      bookId: normalized.bookId,
      startedAt: normalized.startedAt,
      durationS: normalized.durationS,
      startFraction: normalized.startFraction,
      endFraction: normalized.endFraction,
      deviceId: this.context.deviceId,
    };
    await this.db.transaction('rw', this.db.sessions, this.db.changes, async () => {
      await this.db.sessions.add(row);
      await this.db.changes.add(makeChangeRow(this.context, 'session', row.id, 'upsert', row));
    });
    return toSession(row);
  }

  async listByBook(bookId: string): Promise<ReadingSession[]> {
    const rows = await this.db.sessions.where('bookId').equals(bookId).toArray();
    return rows.sort((left, right) => left.startedAt - right.startedAt).map(toSession);
  }

  async listAll(): Promise<ReadingSession[]> {
    const rows = await this.db.sessions.toArray();
    return rows.sort((left, right) => left.startedAt - right.startedAt).map(toSession);
  }

  async stats(): Promise<ReadingStats> {
    return summarizeSessions(await this.listAll());
  }
}

function toSession(row: SessionRow): ReadingSession {
  return {
    id: row.id,
    bookId: row.bookId,
    startedAt: row.startedAt,
    durationS: row.durationS,
    startFraction: row.startFraction,
    endFraction: row.endFraction,
    deviceId: row.deviceId,
  };
}
