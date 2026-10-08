import { AppError } from '~/domain/errors';
import { formatHlc } from '~/domain/hlc';
import { assertLocator, type Locator } from '~/domain/locator';
import { DEFAULT_READING_STATUS, suggestStatus, type Progress } from '~/domain/progress';
import type { ReadingStatus } from '~/domain/enums';
import type { LibraryDatabase, ProgressRow } from '../db';
import { makeChangeRow, type MutationContext } from '../mutations';

export interface SaveProgressInput {
  readonly bookId: string;
  readonly locator: Locator;
  /** Explicit user choice; when omitted the status is derived from position. */
  readonly status?: ReadingStatus;
}

function toProgress(row: ProgressRow): Progress {
  const locator =
    row.locatorKind !== undefined && row.locatorValue !== undefined
      ? { kind: row.locatorKind, value: row.locatorValue, fraction: row.fraction }
      : null;
  return {
    bookId: row.bookId,
    status: row.status,
    locator,
    updatedHlc: row.updatedHlc,
    deviceId: row.deviceId,
  };
}

export class ProgressRepository {
  constructor(
    private readonly db: LibraryDatabase,
    private readonly context: MutationContext,
  ) {}

  async get(bookId: string): Promise<Progress | undefined> {
    const row = await this.db.progress.get(bookId);
    return row === undefined ? undefined : toProgress(row);
  }

  async listAll(): Promise<Progress[]> {
    const rows = await this.db.progress.toArray();
    return rows.map(toProgress);
  }

  /**
   * Creates the initial `to_read` row for a book that has just been imported.
   * Callers run this inside the import transaction so a book can never exist
   * without its reading state.
   */
  async ensureDefault(bookId: string): Promise<Progress> {
    return this.db.transaction('rw', this.db.progress, this.db.changes, async () => {
      const existing = await this.db.progress.get(bookId);
      if (existing !== undefined) return toProgress(existing);

      const row: ProgressRow = {
        bookId,
        status: DEFAULT_READING_STATUS,
        fraction: 0,
        updatedHlc: formatHlc(this.context.clock.next()),
        deviceId: this.context.deviceId,
      };
      await this.db.progress.put(row);
      await this.db.changes.add(makeChangeRow(this.context, 'progress', bookId, 'upsert', row));
      return toProgress(row);
    });
  }

  /** Records a new reading position, keeping the stored locator durable. */
  async save(input: SaveProgressInput): Promise<Progress> {
    const locator = assertLocator(input.locator);

    return this.db.transaction('rw', this.db.progress, this.db.changes, async () => {
      const existing = await this.db.progress.get(input.bookId);
      if (existing === undefined) {
        throw new AppError('not_found', `No reading state exists for book ${input.bookId}.`);
      }

      const status = input.status ?? suggestStatus(locator.fraction, existing.status);

      const row: ProgressRow = {
        bookId: input.bookId,
        status,
        locatorKind: locator.kind,
        locatorValue: locator.value,
        fraction: locator.fraction,
        updatedHlc: formatHlc(this.context.clock.next()),
        deviceId: this.context.deviceId,
      };
      await this.db.progress.put(row);
      await this.db.changes.add(
        makeChangeRow(this.context, 'progress', input.bookId, 'upsert', row),
      );
      return toProgress(row);
    });
  }

  /** Sets the reading status without moving the position. */
  async setStatus(bookId: string, status: ReadingStatus): Promise<Progress> {
    return this.db.transaction('rw', this.db.progress, this.db.changes, async () => {
      const existing = await this.db.progress.get(bookId);
      if (existing === undefined) {
        throw new AppError('not_found', `No reading state exists for book ${bookId}.`);
      }
      const row: ProgressRow = {
        ...existing,
        status,
        updatedHlc: formatHlc(this.context.clock.next()),
      };
      await this.db.progress.put(row);
      await this.db.changes.add(makeChangeRow(this.context, 'progress', bookId, 'upsert', row));
      return toProgress(row);
    });
  }
}
