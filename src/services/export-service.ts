import { DB_SCHEMA_VERSION, LOCAL_MIGRATIONS, type LibraryDatabase } from '~/data/db';
import { toBook } from '~/data/book-mapping';

/** Identifies the export document so a future importer can reject unknown shapes. */
export const EXPORT_FORMAT = 'book-reader-export';

export interface ExportSummary {
  readonly bookCount: number;
  readonly progressCount: number;
  readonly filename: string;
}

/**
 * Library export (requirement F-07).
 *
 * Export is generated entirely on the client and never needs the server, which
 * is what makes it a usable recovery path before sync exists. Annotation and
 * Markdown export arrive with the annotation feature; claiming them now would
 * produce a file that silently omits data.
 */
export class ExportService {
  constructor(private readonly db: LibraryDatabase) {}

  async buildMetadataExport(generatedAt = Date.now()): Promise<string> {
    const [bookRows, progressRows] = await Promise.all([
      this.db.books.toArray(),
      this.db.progress.toArray(),
    ]);

    const payload = {
      format: EXPORT_FORMAT,
      schemaVersion: DB_SCHEMA_VERSION,
      generatedAt: new Date(generatedAt).toISOString(),
      localMigrations: LOCAL_MIGRATIONS,
      books: bookRows.map((row) => toBook(row)),
      progress: progressRows,
      // Present but empty until annotations are implemented, so consumers can
      // rely on the shape without receiving misleading data.
      annotations: [],
      shelves: [],
      tags: [],
      sessions: [],
    };

    return JSON.stringify(payload, null, 2);
  }

  async download(generatedAt = Date.now()): Promise<ExportSummary> {
    const json = await this.buildMetadataExport(generatedAt);
    const filename = `book-reader-export-${new Date(generatedAt).toISOString().slice(0, 10)}.json`;
    const blob = new Blob([json], { type: 'application/json' });

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.click();

    // The blob must stay alive until the browser has actually started reading
    // it: revoking in the same task can cancel a download that has not begun
    // yet. A generous delay costs only a little memory and cannot truncate the
    // file the user asked for.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);

    const parsed = JSON.parse(json) as { books: unknown[]; progress: unknown[] };
    return {
      bookCount: parsed.books.length,
      progressCount: parsed.progress.length,
      filename,
    };
  }
}
