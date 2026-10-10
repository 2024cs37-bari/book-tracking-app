import {
  DB_SCHEMA_VERSION,
  type AnnotationRow,
  type BookRow,
  type BookTagRow,
  type LibraryDatabase,
  type ProgressRow,
  type SessionRow,
  type ShelfBookRow,
  type ShelfRow,
  type TagRow,
} from '~/data/db';
import { EXPORT_FORMAT } from './export-service';

export interface RestoreSummary {
  readonly books: number;
  readonly progress: number;
  readonly annotations: number;
  readonly shelves: number;
  readonly tags: number;
  readonly sessions: number;
}

interface ExportPayload {
  format?: unknown;
  schemaVersion?: unknown;
  books?: unknown;
  progress?: unknown;
  annotations?: unknown;
  shelves?: unknown;
  shelfBooks?: unknown;
  tags?: unknown;
  bookTags?: unknown;
  sessions?: unknown;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Restores a library from a JSON export produced by {@link ExportService}.
 *
 * This is the recovery counterpart that makes an export verifiable: a backup
 * can be read back into a library. Rows are written by primary key, so a
 * restore replaces matching rows with the backed-up copy and adds any that are
 * missing — a snapshot restore, not a sync merge, so it writes no outbox rows.
 * An export from a newer schema version is refused rather than loaded
 * partially (DATA-MODEL.md §8).
 */
export class RestoreService {
  constructor(private readonly db: LibraryDatabase) {}

  async restore(json: string): Promise<RestoreSummary> {
    let payload: ExportPayload;
    try {
      payload = JSON.parse(json) as ExportPayload;
    } catch {
      throw new Error('The backup file is not valid JSON.');
    }

    if (payload.format !== EXPORT_FORMAT) {
      throw new Error('This file is not a book-reader export.');
    }
    if (typeof payload.schemaVersion !== 'number' || payload.schemaVersion > DB_SCHEMA_VERSION) {
      throw new Error(
        `The backup was made with a newer app version (schema ${String(payload.schemaVersion)}); update before restoring.`,
      );
    }

    const books = asArray<BookRow>(payload.books).map((book) => ({ ...book }) as BookRow);
    const progress = asArray<ProgressRow>(payload.progress);
    const annotations = asArray<AnnotationRow>(payload.annotations);
    const shelves = asArray<ShelfRow>(payload.shelves);
    const shelfBooks = asArray<ShelfBookRow>(payload.shelfBooks);
    const tags = asArray<TagRow>(payload.tags);
    const bookTags = asArray<BookTagRow>(payload.bookTags);
    const sessions = asArray<SessionRow>(payload.sessions);

    await this.db.transaction(
      'rw',
      [
        this.db.books,
        this.db.progress,
        this.db.annotations,
        this.db.shelves,
        this.db.shelfBooks,
        this.db.tags,
        this.db.bookTags,
        this.db.sessions,
      ],
      async () => {
        await this.db.books.bulkPut(books);
        await this.db.progress.bulkPut(progress);
        await this.db.annotations.bulkPut(annotations);
        await this.db.shelves.bulkPut(shelves);
        await this.db.shelfBooks.bulkPut(shelfBooks);
        await this.db.tags.bulkPut(tags);
        await this.db.bookTags.bulkPut(bookTags);
        await this.db.sessions.bulkPut(sessions);
      },
    );

    return {
      books: books.length,
      progress: progress.length,
      annotations: annotations.length,
      shelves: shelves.length,
      tags: tags.length,
      sessions: sessions.length,
    };
  }
}
