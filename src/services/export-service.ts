import { saveFile } from '~/storage/save-file';
import { DB_SCHEMA_VERSION, LOCAL_MIGRATIONS, type LibraryDatabase } from '~/data/db';
import { bookFileKey, type BookFileStore } from '~/storage/file-store';
import { bookFileLeases } from '~/storage/book-file-leases';
import { sha256Blob, sha256Hex } from '~/storage/sha256';
import {
  BACKUP_LIMITS,
  EXPORT_FORMAT,
  SNAPSHOT_TABLES,
  parseMetadataExport,
  type LibrarySnapshot,
} from './backup-validation';
import { buildBackupArchive } from './backup-archive';

export { EXPORT_FORMAT } from './backup-validation';
export const PORTABLE_BACKUP_FORMAT = 'book-reader-backup';
export const PORTABLE_BACKUP_VERSION = 1;

export interface ExportSummary {
  readonly bookCount: number;
  readonly progressCount: number;
  readonly filename: string;
}

export interface BackupFileEntry {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}
export interface PortableBackupManifest {
  readonly format: typeof PORTABLE_BACKUP_FORMAT;
  readonly version: typeof PORTABLE_BACKUP_VERSION;
  readonly metadata: BackupFileEntry;
  readonly originals: BackupFileEntry[];
  readonly covers: BackupFileEntry[];
}

/** All replicated rows come from one IndexedDB snapshot, including memberships. */
export async function captureSnapshot(db: LibraryDatabase): Promise<LibrarySnapshot> {
  return db.transaction(
    'r',
    SNAPSHOT_TABLES.map((table) => db[table]),
    async () => ({
      books: await db.books.toArray(),
      progress: await db.progress.toArray(),
      annotations: await db.annotations.toArray(),
      shelves: await db.shelves.toArray(),
      shelfBooks: await db.shelfBooks.toArray(),
      tags: await db.tags.toArray(),
      bookTags: await db.bookTags.toArray(),
      sessions: await db.sessions.toArray(),
    }),
  );
}

function serialize(snapshot: LibrarySnapshot, generatedAt: number): string {
  const json = JSON.stringify(
    {
      format: EXPORT_FORMAT,
      schemaVersion: DB_SCHEMA_VERSION,
      generatedAt: new Date(generatedAt).toISOString(),
      localMigrations: LOCAL_MIGRATIONS,
      ...snapshot,
    },
    null,
    2,
  );
  // Refuse to emit a backup that the recovery path cannot safely read.
  parseMetadataExport(json);
  return json;
}

export async function downloadBackupBlob(blob: Blob, filename: string): Promise<void> {
  await saveFile(blob, filename);
}

/** Metadata exports omit originals; portable backups include every original. */
export class ExportService {
  constructor(
    private readonly db: LibraryDatabase,
    private readonly files?: BookFileStore,
  ) {}

  async buildMetadataExport(generatedAt = Date.now()): Promise<string> {
    return serialize(await captureSnapshot(this.db), generatedAt);
  }

  async buildPortableBackup(generatedAt = Date.now()): Promise<Blob> {
    if (!this.files)
      throw new Error('Original-file storage is unavailable. Export metadata instead.');
    const snapshot = await captureSnapshot(this.db);
    serialize(snapshot, generatedAt);
    const entries: Record<string, Uint8Array> = {};
    const originals: BackupFileEntry[] = [];
    const covers: BackupFileEntry[] = [];
    let totalBytes = 0;
    const add = async (
      path: string,
      blob: Blob,
      limit: number,
      expected?: string,
    ): Promise<BackupFileEntry> => {
      if (blob.size > limit)
        throw new Error(
          `The file ${path} exceeds the ${limit / 1024 / 1024} MiB per-file backup limit. Export metadata and keep your originals separately.`,
        );
      totalBytes += blob.size + path.length * 2 + 100;
      if (totalBytes + BACKUP_LIMITS.metadataBytes > BACKUP_LIMITS.archiveBytes)
        throw new Error(
          'This portable backup exceeds the 128 MiB limit. Export metadata and keep your originals separately.',
        );
      const hash = await sha256Blob(blob);
      if (expected !== undefined && hash !== expected)
        throw new Error(
          `Original file ${path} failed SHA-256 verification. Backup cancelled; the existing file was kept.`,
        );
      entries[path] = new Uint8Array(await blob.arrayBuffer());
      return { path, sizeBytes: blob.size, sha256: hash };
    };
    for (const book of snapshot.books) {
      const release = await bookFileLeases.acquire(book.sha256);
      try {
        const path = bookFileKey(book.sha256);
        if (!(await this.files.has(path)))
          throw new Error(
            `“${book.title}” has no original on this device. Download or reimport it before making a portable backup, or export metadata only.`,
          );
        const blob = await this.files.get(path);
        if (blob.size !== book.sizeBytes)
          throw new Error(
            `Original size does not match the library record for “${book.title}”. Backup cancelled.`,
          );
        originals.push(await add(path, blob, BACKUP_LIMITS.originalBytes, book.sha256));
        if (book.coverKey) {
          if (await this.files.has(book.coverKey)) {
            if (!entries[book.coverKey])
              covers.push(
                await add(
                  book.coverKey,
                  await this.files.get(book.coverKey),
                  BACKUP_LIMITS.coverBytes,
                ),
              );
          } else delete book.coverKey;
        }
      } finally {
        release();
      }
    }
    const metadata = new TextEncoder().encode(serialize(snapshot, generatedAt));
    entries['metadata.json'] = metadata;
    const manifest: PortableBackupManifest = {
      format: PORTABLE_BACKUP_FORMAT,
      version: PORTABLE_BACKUP_VERSION,
      metadata: { path: 'metadata.json', sizeBytes: metadata.length, sha256: sha256Hex(metadata) },
      originals,
      covers,
    };
    entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
    return buildBackupArchive(entries);
  }

  async download(generatedAt = Date.now()): Promise<ExportSummary> {
    const json = await this.buildMetadataExport(generatedAt);
    const filename = `book-reader-export-${new Date(generatedAt).toISOString().slice(0, 10)}.json`;
    await downloadBackupBlob(new Blob([json], { type: 'application/json' }), filename);
    const parsed = parseMetadataExport(json);
    return { bookCount: parsed.books.length, progressCount: parsed.progress.length, filename };
  }

  async downloadPortable(generatedAt = Date.now()): Promise<string> {
    const blob = await this.buildPortableBackup(generatedAt);
    const filename = `book-reader-backup-${new Date(generatedAt).toISOString().slice(0, 10)}.zip`;
    await downloadBackupBlob(blob, filename);
    return filename;
  }
}
