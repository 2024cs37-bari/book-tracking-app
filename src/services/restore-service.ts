import {
  type BookRow,
  type ChangeRow,
  type LibraryDatabase,
  type ReplicatedEntity,
} from '~/data/db';
import { createMutationContext, makeChangeRow } from '~/data/mutations';
import { SYNC_META_KEYS } from '~/data/repositories/sync-meta-repository';
import { compareHlc, createClock, formatHlc, parseHlc, type Clock } from '~/domain/hlc';
import { newId, isSha256Hex } from '~/domain/ids';
import { bookFileKey, type BookFileStore } from '~/storage/file-store';
import { bookFileLeases } from '~/storage/book-file-leases';
import { sha256Blob, sha256Hex, sha256Text } from '~/storage/sha256';
import {
  captureSnapshot,
  PORTABLE_BACKUP_FORMAT,
  PORTABLE_BACKUP_VERSION,
  type BackupFileEntry,
} from './export-service';
import { readBackupArchive } from './backup-archive';
import {
  BACKUP_LIMITS,
  parseMetadataExport,
  SNAPSHOT_TABLES,
  snapshotKey,
  type LibrarySnapshot,
  type SnapshotTable,
} from './backup-validation';

export interface RestoreSummary {
  readonly books: number;
  readonly progress: number;
  readonly annotations: number;
  readonly shelves: number;
  readonly tags: number;
  readonly sessions: number;
  readonly filesRestored: number;
  readonly preservedRows: number;
}

export interface PreparedRestore {
  readonly kind: 'metadata' | 'portable';
  readonly booksToAdd: number;
  readonly existingBooks: number;
  readonly recordsToAdd: number;
  readonly recordsPreserved: number;
  readonly originalFiles: number;
  readonly missingOriginalFiles: number;
  readonly bytesToRestore: number;
  readonly warnings: readonly string[];
}

interface Plan {
  snapshot: LibrarySnapshot;
  targetFingerprint: string;
  files: Map<string, { bytes: Uint8Array; sha256: string }>;
  presentOriginals: Set<string>;
  preview: PreparedRestore;
}

export interface RestoreOptions {
  readonly files?: BookFileStore;
  readonly clock?: Clock;
}
const ENTITY: Record<SnapshotTable, ReplicatedEntity> = {
  books: 'book',
  progress: 'progress',
  annotations: 'annotation',
  shelves: 'shelf',
  shelfBooks: 'shelf_book',
  tags: 'tag',
  bookTags: 'book_tag',
  sessions: 'session',
};

function fingerprint(snapshot: LibrarySnapshot): string {
  return sha256Text(JSON.stringify(snapshot));
}

function parseEntry(value: unknown): BackupFileEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid backup manifest entry.');
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.path !== 'string' ||
    !isSha256Hex(entry.sha256) ||
    typeof entry.sizeBytes !== 'number' ||
    !Number.isSafeInteger(entry.sizeBytes) ||
    entry.sizeBytes < 0
  )
    throw new Error('Invalid backup manifest file identity.');
  return { path: entry.path, sha256: entry.sha256, sizeBytes: entry.sizeBytes };
}

async function readPortable(
  blob: Blob,
): Promise<{ snapshot: LibrarySnapshot; files: Plan['files'] }> {
  const entries = await readBackupArchive(blob);
  const manifestBytes = entries.get('manifest.json');
  if (!manifestBytes) throw new Error('Backup manifest is missing.');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    throw new Error('Invalid backup manifest JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid backup manifest.');
  const manifest = value as Record<string, unknown>;
  if (manifest.format !== PORTABLE_BACKUP_FORMAT || manifest.version !== PORTABLE_BACKUP_VERSION)
    throw new Error('Unsupported portable backup format or version.');
  if (!Array.isArray(manifest.originals) || !Array.isArray(manifest.covers))
    throw new Error('Backup manifest file lists are missing.');
  const metadata = parseEntry(manifest.metadata);
  if (metadata.path !== 'metadata.json') throw new Error('Invalid backup metadata path.');
  const originals = manifest.originals.map(parseEntry);
  const covers = manifest.covers.map(parseEntry);
  const all = [metadata, ...originals, ...covers];
  if (
    entries.size !== all.length + 1 ||
    new Set(all.map((entry) => entry.path)).size !== all.length
  )
    throw new Error('Backup contains missing, duplicate or unexpected files.');
  for (const entry of all) {
    const bytes = entries.get(entry.path);
    if (!bytes || bytes.length !== entry.sizeBytes || sha256Hex(bytes) !== entry.sha256)
      throw new Error(
        `Backup SHA-256 verification failed for ${entry.path}. Nothing was restored.`,
      );
  }
  const snapshot = parseMetadataExport(
    new TextDecoder('utf-8', { fatal: true }).decode(entries.get('metadata.json')!),
  );
  const byPath = new Map(originals.map((entry) => [entry.path, entry]));
  if (originals.length !== snapshot.books.length)
    throw new Error('Portable backup must contain every original exactly once.');
  for (const book of snapshot.books) {
    const entry = byPath.get(bookFileKey(book.sha256));
    if (!entry || entry.sha256 !== book.sha256 || entry.sizeBytes !== book.sizeBytes)
      throw new Error(`Backup original does not match book “${book.title}”.`);
  }
  const expectedCovers = new Set(
    snapshot.books.flatMap((book) => (book.coverKey ? [book.coverKey] : [])),
  );
  if (
    covers.length !== expectedCovers.size ||
    covers.some((entry) => !expectedCovers.has(entry.path))
  )
    throw new Error('Backup covers do not match the metadata.');
  return {
    snapshot,
    files: new Map(
      [...originals, ...covers].map((entry) => [
        entry.path,
        { bytes: entries.get(entry.path)!, sha256: entry.sha256 },
      ]),
    ),
  };
}

function planAdditions(incoming: LibrarySnapshot, existing: LibrarySnapshot): LibrarySnapshot {
  const result = structuredClone(incoming);
  const existingBooks = new Map(existing.books.map((book) => [book.id, book]));
  const existingHashes = new Map(existing.books.map((book) => [book.sha256, book]));
  const aliases = new Map<string, string>();
  for (const book of result.books) {
    const sameId = existingBooks.get(book.id);
    if (
      sameId &&
      (sameId.sha256 !== book.sha256 ||
        sameId.sizeBytes !== book.sizeBytes ||
        sameId.format !== book.format)
    )
      throw new Error(
        `Book identity conflict for “${book.title}”. Current data was kept; this backup cannot be safely merged.`,
      );
    const sameHash = existingHashes.get(book.sha256);
    if (sameHash) {
      if (sameHash.sizeBytes !== book.sizeBytes || sameHash.format !== book.format)
        throw new Error(`Book content identity conflict for “${book.title}”.`);
      aliases.set(book.id, sameHash.id);
    }
  }
  result.books = result.books.filter((book) => !aliases.has(book.id));
  for (const row of [
    ...result.progress,
    ...result.annotations,
    ...result.shelfBooks,
    ...result.bookTags,
    ...result.sessions,
  ])
    row.bookId = aliases.get(row.bookId) ?? row.bookId;
  // Active tags are unique by normalized name at creation time. Recovering a
  // backup from another installation must preserve that same invariant.
  const tagIds = new Set(existing.tags.map((tag) => tag.id));
  const tagNames = new Map(
    existing.tags.filter((tag) => !tag.deleted).map((tag) => [tag.normalizedName, tag.id]),
  );
  const tagAliases = new Map<string, string>();
  result.tags = result.tags.filter((tag) => {
    if (tagIds.has(tag.id) || tag.deleted) return true;
    const canonical = tagNames.get(tag.normalizedName);
    if (canonical) {
      tagAliases.set(tag.id, canonical);
      return false;
    }
    tagNames.set(tag.normalizedName, tag.id);
    return true;
  });
  for (const row of result.bookTags) row.tagId = tagAliases.get(row.tagId) ?? row.tagId;
  // Existing identities, including removals/tombstones, always win. This is
  // additive recovery and cannot roll back edits or resurrect local deletion.
  for (const table of SNAPSHOT_TABLES) {
    const keys = new Set(existing[table].map((row) => snapshotKey(table, row)));
    const rows = result[table].filter((row) => {
      const key = snapshotKey(table, row);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    });
    Object.assign(result, { [table]: rows });
  }
  return result;
}

/**
 * Validated, additive recovery. Preparing performs no mutations. Applying
 * requires the exact service-issued preview and an unchanged library snapshot.
 * Original bytes are verified and staged before one atomic metadata/outbox
 * transaction; failures can leave safe unreferenced bytes for reconciliation.
 */
export class RestoreService {
  private readonly plans = new WeakMap<PreparedRestore, Plan>();
  private applying = false;
  constructor(
    private readonly db: LibraryDatabase,
    private readonly options: RestoreOptions = {},
  ) {}

  async prepare(input: string | Blob): Promise<PreparedRestore> {
    let snapshot: LibrarySnapshot;
    let files: Plan['files'] = new Map();
    let kind: PreparedRestore['kind'] = 'metadata';
    if (typeof input === 'string') snapshot = parseMetadataExport(input);
    else {
      if (input.size > BACKUP_LIMITS.archiveBytes)
        throw new Error('Backup exceeds the 128 MiB limit.');
      const signature = new Uint8Array(await input.slice(0, 4).arrayBuffer());
      if (signature[0] === 0x50 && signature[1] === 0x4b) {
        ({ snapshot, files } = await readPortable(input));
        kind = 'portable';
        if (!this.options.files)
          throw new Error('Original-file storage is unavailable for portable recovery.');
      } else {
        if (input.size > BACKUP_LIMITS.metadataBytes)
          throw new Error('Metadata backup exceeds the 8 MiB limit.');
        snapshot = parseMetadataExport(await input.text());
      }
    }
    const existing = await captureSnapshot(this.db);
    const additions = planAdditions(snapshot, existing);
    const neededCovers = new Set(
      additions.books.flatMap((book) => (book.coverKey ? [book.coverKey] : [])),
    );
    for (const path of files.keys())
      if (path.startsWith('covers/') && !neededCovers.has(path)) files.delete(path);
    const presentOriginals = new Set<string>();
    let bytesToRestore = 0;
    const store = this.options.files;
    // Check stored originals too: content-derived names are never sufficient
    // evidence that bytes are intact, including on idempotent repeated recovery.
    for (const book of snapshot.books) {
      const key = bookFileKey(book.sha256);
      if (store && (await store.has(key))) {
        const blob = await store.get(key);
        if (blob.size !== book.sizeBytes || (await sha256Blob(blob)) !== book.sha256)
          throw new Error(
            `The existing original for “${book.title}” failed integrity verification. It was not overwritten.`,
          );
        presentOriginals.add(book.sha256);
      } else if (files.has(key)) bytesToRestore += book.sizeBytes;
    }
    for (const [path, entry] of files) {
      if (!path.startsWith('covers/')) continue;
      if (store && (await store.has(path))) {
        if ((await sha256Blob(await store.get(path))) !== entry.sha256)
          throw new Error(`An existing cover conflicts with ${path}; it was not overwritten.`);
      } else bytesToRestore += entry.bytes.length;
    }
    if (kind === 'metadata')
      for (const book of additions.books) {
        if (book.coverKey && (!store || !(await store.has(book.coverKey)))) delete book.coverKey;
      }
    const total = SNAPSHOT_TABLES.reduce((sum, table) => sum + snapshot[table].length, 0);
    const recordsToAdd = SNAPSHOT_TABLES.reduce((sum, table) => sum + additions[table].length, 0);
    const missingOriginalFiles = snapshot.books.filter(
      (book) => !presentOriginals.has(book.sha256) && !files.has(bookFileKey(book.sha256)),
    ).length;
    const preview: PreparedRestore = Object.freeze({
      kind,
      booksToAdd: additions.books.length,
      existingBooks: snapshot.books.length - additions.books.length,
      recordsToAdd,
      recordsPreserved: total - recordsToAdd,
      originalFiles: kind === 'portable' ? snapshot.books.length : 0,
      missingOriginalFiles,
      bytesToRestore,
      warnings: Object.freeze([
        'Existing books, progress, annotations and collections are preserved. Only missing records are added.',
        'Recovered records become new local changes and can synchronize to your other devices.',
        ...(kind === 'metadata'
          ? [
              'JSON contains no original book files. Missing originals must be reimported or downloaded before reading.',
            ]
          : []),
        ...(!store?.durable && files.size > 0
          ? ['File storage on this device is temporary. Keep the backup outside the browser.']
          : []),
      ]),
    });
    this.plans.set(preview, {
      snapshot: additions,
      targetFingerprint: fingerprint(existing),
      files,
      presentOriginals,
      preview,
    });
    return preview;
  }

  async apply(preview: PreparedRestore): Promise<RestoreSummary> {
    const plan = this.plans.get(preview);
    if (!plan)
      throw new Error('This recovery preview is no longer valid. Select the backup again.');
    if (this.applying) throw new Error('Another recovery is already running.');
    this.applying = true;
    const releases: (() => void)[] = [];
    try {
      const hashes = new Set([
        ...plan.snapshot.books.map((book) => book.sha256),
        ...[...plan.files.keys()]
          .filter((path) => path.startsWith('books/'))
          .map((path) => path.slice(6, -4)),
      ]);
      for (const hash of [...hashes].sort()) releases.push(await bookFileLeases.acquire(hash));
      if (fingerprint(await captureSnapshot(this.db)) !== plan.targetFingerprint)
        throw new Error(
          'The library changed since this preview. Select the backup again to review an updated recovery.',
        );
      const store = this.options.files;
      // File availability may change between preview and confirmation. Leases
      // keep the final check, staging and metadata commit safe from eviction.
      plan.presentOriginals.clear();
      for (const book of plan.snapshot.books) {
        const key = bookFileKey(book.sha256);
        if (store && (await store.has(key))) {
          const original = await store.get(key);
          if (original.size !== book.sizeBytes || (await sha256Blob(original)) !== book.sha256)
            throw new Error(
              `Existing original for “${book.title}” is damaged; it was not overwritten.`,
            );
          plan.presentOriginals.add(book.sha256);
        }
      }
      let filesRestored = 0;
      for (const [path, entry] of plan.files) {
        if (!store) throw new Error('Original-file storage is unavailable.');
        if (await store.has(path)) {
          if ((await sha256Blob(await store.get(path))) !== entry.sha256)
            throw new Error(`Existing file ${path} changed or is damaged; it was not overwritten.`);
        } else {
          await store.put(path, new Blob([new Uint8Array(entry.bytes)]));
          if ((await sha256Blob(await store.get(path))) !== entry.sha256)
            throw new Error(
              `Stored file verification failed for ${path}. Metadata was not restored.`,
            );
          if (path.startsWith('books/')) filesRestored++;
        }
      }
      const summary = await this.db.transaction(
        'rw',
        [
          ...SNAPSHOT_TABLES.map((table) => this.db[table]),
          this.db.changes,
          this.db.syncMeta,
          this.db.deviceState,
        ],
        async () => {
          if (fingerprint(await captureSnapshot(this.db)) !== plan.targetFingerprint)
            throw new Error(
              'The library changed during recovery. Metadata was kept unchanged. Select the backup again.',
            );
          const persistedId = (await this.db.syncMeta.get(SYNC_META_KEYS.deviceId))?.value;
          const clock = this.options.clock ?? createClock({ deviceId: persistedId ?? newId() });
          const persistedClock = (await this.db.syncMeta.get(SYNC_META_KEYS.clockState))?.value;
          if (persistedClock) {
            const parsed = parseHlc(persistedClock);
            if (parsed) clock.restore(parsed);
          }
          const context = createMutationContext(clock);
          const changes: ChangeRow[] = [];
          const snapshot = structuredClone(plan.snapshot);
          for (const table of SNAPSHOT_TABLES) {
            for (const row of snapshot[table]) {
              const stamp = formatHlc(clock.next());
              if ('updatedHlc' in row) row.updatedHlc = stamp;
              if (
                'createdHlc' in row &&
                compareHlc(parseHlc(row.createdHlc)!, parseHlc(stamp)!) > 0
              )
                row.createdHlc = stamp;
              if ('addedHlc' in row) {
                const removed =
                  row.removedHlc !== undefined &&
                  compareHlc(parseHlc(row.removedHlc)!, parseHlc(row.addedHlc)!) >= 0;
                row.addedHlc = stamp;
                row.removedHlc = removed ? stamp : undefined;
              }
              if (table === 'books') restampBook(row as BookRow, stamp);
              if (table === 'progress' && 'deviceId' in row) row.deviceId = clock.deviceId;
              changes.push(
                makeChangeRow(context, ENTITY[table], snapshotKey(table, row), 'upsert', row),
              );
            }
          }
          await this.db.books.bulkAdd(snapshot.books);
          await this.db.progress.bulkAdd(snapshot.progress);
          await this.db.annotations.bulkAdd(snapshot.annotations);
          await this.db.shelves.bulkAdd(snapshot.shelves);
          await this.db.shelfBooks.bulkAdd(snapshot.shelfBooks);
          await this.db.tags.bulkAdd(snapshot.tags);
          await this.db.bookTags.bulkAdd(snapshot.bookTags);
          await this.db.sessions.bulkAdd(snapshot.sessions);
          await this.db.changes.bulkAdd(changes);
          for (const book of snapshot.books)
            await this.db.deviceState.put({
              bookId: book.id,
              filePresent:
                plan.presentOriginals.has(book.sha256) || plan.files.has(bookFileKey(book.sha256)),
              pinnedOffline: false,
            });
          // Existing remote-only books can also regain their bytes in recovery.
          for (const book of await this.db.books.toArray())
            if (plan.files.has(bookFileKey(book.sha256))) {
              const state = await this.db.deviceState.get(book.id);
              await this.db.deviceState.put({
                bookId: book.id,
                pinnedOffline: false,
                ...state,
                filePresent: true,
              });
            }
          if (persistedId === undefined)
            await this.db.syncMeta.put({ key: SYNC_META_KEYS.deviceId, value: clock.deviceId });
          if (clock.last())
            await this.db.syncMeta.put({
              key: SYNC_META_KEYS.clockState,
              value: formatHlc(clock.last()!),
            });
          return {
            books: snapshot.books.length,
            progress: snapshot.progress.length,
            annotations: snapshot.annotations.length,
            shelves: snapshot.shelves.length,
            tags: snapshot.tags.length,
            sessions: snapshot.sessions.length,
            filesRestored,
            preservedRows: preview.recordsPreserved,
          };
        },
      );
      this.plans.delete(preview);
      return summary;
    } finally {
      for (const release of releases.reverse()) release();
      this.applying = false;
    }
  }

  /** Compatibility convenience; interactive callers should show prepare() first. */
  async restore(json: string): Promise<RestoreSummary> {
    return this.apply(await this.prepare(json));
  }
}

function restampBook(book: BookRow, stamp: string): void {
  // Optional per-field provenance is supported by the metadata merge protocol.
  if ('metadataHlcs' in book && book.metadataHlcs && typeof book.metadataHlcs === 'object') {
    for (const key of Object.keys(book.metadataHlcs))
      Object.assign(book.metadataHlcs, { [key]: stamp });
  }
}
