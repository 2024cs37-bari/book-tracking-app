import type { Book } from '~/domain/book';
import { AppError, isAppError } from '~/domain/errors';
import { newId } from '~/domain/ids';
import { detectFormat, DETECTION_SAMPLE_BYTES } from '~/reader/format-detect';
import { bookFileKey, coverFileKey, type BookFileStore } from '~/storage/file-store';
import { sha256Blob } from '~/storage/sha256';
import type { LibraryDatabase } from '~/data/db';
import type { BookRepository } from '~/data/repositories/book-repository';
import type { ProgressRepository } from '~/data/repositories/progress-repository';
import { extractBookMetadata, type MetadataExtractor } from './metadata';
import type { ExtractedCover } from './metadata/types';
import type { BookFormat } from '~/domain/enums';

export interface ImportRequest {
  readonly blob: Blob;
  readonly filename: string;
}

export type ImportOutcome =
  | { readonly status: 'imported'; readonly book: Book; readonly warnings: readonly string[] }
  | { readonly status: 'duplicate'; readonly book: Book }
  | { readonly status: 'unsupported'; readonly filename: string; readonly reason: string }
  | { readonly status: 'failed'; readonly filename: string; readonly error: AppError };

export interface ImportDependencies {
  readonly db: LibraryDatabase;
  readonly books: BookRepository;
  readonly progress: ProgressRepository;
  readonly files: BookFileStore;
  readonly extractors?: readonly MetadataExtractor[];
}

/**
 * Client-side import pipeline (docs/IMPORT-AND-READER.md §2).
 *
 * Ordering matters. Bytes are written to the content-addressed store before
 * metadata commits, because the store key is the content hash: writing is
 * idempotent, so a crash between the two steps leaves an unreferenced file
 * rather than a book row pointing at nothing. Unreferenced files are reported
 * and collected by the storage reconciliation helper.
 */
export class ImportService {
  constructor(private readonly deps: ImportDependencies) {}

  async importFile(request: ImportRequest): Promise<ImportOutcome> {
    const { filename } = request;
    let contentHash: string | undefined;

    try {
      const sha256 = await sha256Blob(request.blob);
      contentHash = sha256;

      const existing = await this.deps.books.findBySha256(sha256);
      if (existing !== undefined) {
        return { status: 'duplicate', book: existing };
      }

      const sample = new Uint8Array(
        await request.blob.slice(0, DETECTION_SAMPLE_BYTES).arrayBuffer(),
      );
      const detection = detectFormat(sample, filename);
      const format = detection.format;
      if (format === null) {
        return { status: 'unsupported', filename, reason: detection.reason };
      }

      const extraction = await extractBookMetadata(
        { blob: request.blob, filename, format },
        this.deps.extractors,
      );

      // The cover key derives from the book id, so the id is allocated before
      // the metadata row exists.
      const bookId = newId();
      await this.deps.files.put(bookFileKey(sha256), request.blob);

      const extraWarnings: string[] = [];
      let coverKey: string | undefined;
      const cover = extraction.metadata.cover ?? (await this.generateCover(format, request.blob));
      if (cover !== undefined) {
        const candidateKey = coverFileKey(bookId, cover.extension);
        try {
          await this.deps.files.put(
            candidateKey,
            new Blob([cover.bytes], { type: cover.contentType }),
          );
          coverKey = candidateKey;
        } catch (error) {
          // A missing cover is cosmetic; the book itself imported correctly.
          extraWarnings.push(
            `The cover image could not be stored: ${error instanceof Error ? error.message : 'unknown error'}.`,
          );
        }
      }

      const warnings = [
        ...extraction.metadata.warnings,
        ...extraWarnings,
        `Format detected with ${detection.confidence} confidence: ${detection.reason}`,
      ];

      const book = await this.deps.db.transaction(
        'rw',
        this.deps.db.books,
        this.deps.db.progress,
        this.deps.db.changes,
        async () => {
          const created = await this.deps.books.insert({
            id: bookId,
            sha256,
            title: extraction.metadata.title,
            author: extraction.metadata.author,
            language: extraction.metadata.language,
            format,
            sizeBytes: request.blob.size,
            coverKey,
            isbn: extraction.metadata.isbn,
            publisher: extraction.metadata.publisher,
            pageCount: extraction.metadata.pageCount,
            metadataIncomplete: extraction.incomplete,
          });
          await this.deps.progress.ensureDefault(created.id);
          return created;
        },
      );

      return { status: 'imported', book, warnings };
    } catch (error) {
      // Two identical files selected in one batch can both pass the lookup
      // above; the unique index on sha256 is the real guard, so translate the
      // resulting constraint violation into the duplicate outcome.
      if (contentHash !== undefined && isUniqueConstraintError(error)) {
        const existing = await this.deps.books.findBySha256(contentHash);
        if (existing !== undefined) {
          return { status: 'duplicate', book: existing };
        }
      }
      return {
        status: 'failed',
        filename,
        error: isAppError(error)
          ? error
          : new AppError(
              'invalid_state',
              error instanceof Error ? error.message : 'Import failed.',
              { cause: error },
            ),
      };
    }
  }

  /**
   * Imports sequentially. Files are the largest objects this app handles, so
   * bounded concurrency keeps peak memory predictable.
   */
  async importFiles(
    requests: readonly ImportRequest[],
    onOutcome?: (outcome: ImportOutcome, index: number) => void,
  ): Promise<ImportOutcome[]> {
    const outcomes: ImportOutcome[] = [];
    for (const [index, request] of requests.entries()) {
      const outcome = await this.importFile(request);
      outcomes.push(outcome);
      onOutcome?.(outcome, index);
    }
    return outcomes;
  }

  /**
   * Produces a cover for formats whose metadata carries none, currently by
   * rasterizing a PDF's first page. Lazy-imported and DOM-gated so a headless
   * import never loads pdf.js; any failure yields `undefined` because a cover
   * is cosmetic.
   */
  private async generateCover(format: BookFormat, blob: Blob): Promise<ExtractedCover | undefined> {
    if (format !== 'pdf' || typeof document === 'undefined') return undefined;
    try {
      const { renderPdfCover } = await import('~/reader/pdf-cover');
      return (await renderPdfCover(blob)) ?? undefined;
    } catch {
      return undefined;
    }
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConstraintError';
}
