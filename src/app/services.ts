import { createClock, type Clock } from '~/domain/hlc';
import { createDatabase, type LibraryDatabase } from '~/data/db';
import { createMutationContext } from '~/data/mutations';
import { BookRepository } from '~/data/repositories/book-repository';
import { ProgressRepository } from '~/data/repositories/progress-repository';
import { ChangeRepository } from '~/data/repositories/change-repository';
import { DeviceStateRepository } from '~/data/repositories/device-state-repository';
import { SyncMetaRepository } from '~/data/repositories/sync-meta-repository';
import { createRendererRegistry, type RendererRegistry } from '~/reader/renderer';
import { requestPersistentStorage, selectBookFileStore } from '~/storage/create-file-store';
import type { BookFileStore } from '~/storage/file-store';
import { ImportService } from '~/services/import-service';
import { ExportService } from '~/services/export-service';
import { ReaderService } from '~/services/reader-service';
import { EpubRenderer } from '~/reader/epub-renderer';
import { PdfRenderer } from '~/reader/pdf-renderer';

/**
 * Everything the UI needs, assembled once at startup.
 *
 * Components receive this through context rather than importing repositories
 * directly, which keeps UI code free of database and storage details.
 */
export interface AppServices {
  readonly db: LibraryDatabase;
  readonly books: BookRepository;
  readonly progress: ProgressRepository;
  readonly changes: ChangeRepository;
  readonly deviceState: DeviceStateRepository;
  readonly syncMeta: SyncMetaRepository;
  readonly files: BookFileStore;
  readonly imports: ImportService;
  readonly exports: ExportService;
  readonly renderers: RendererRegistry;
  readonly reader: ReaderService;
  readonly clock: Clock;
  readonly deviceId: string;
  /** Set when a non-durable or degraded storage adapter is in use. */
  readonly storageWarning: string | null;
  readonly persistentStorage: boolean | null;
  /** Persists the clock so a restart cannot reissue an earlier HLC. */
  persistClockState(): Promise<void>;
}

export interface CreateAppServicesOptions {
  readonly dbName?: string;
  /** Overrides storage selection, used by tests and future desktop builds. */
  readonly fileStore?: BookFileStore;
}

export async function createAppServices(
  options: CreateAppServicesOptions = {},
): Promise<AppServices> {
  const db = createDatabase(options.dbName);
  // Fails fast if IndexedDB is unavailable (for example in some private
  // browsing modes) so the UI can explain the problem instead of half-working.
  await db.open();

  const syncMeta = new SyncMetaRepository(db);
  const deviceId = await syncMeta.getOrCreateDeviceId();

  const clock = createClock({ deviceId });
  const storedClock = await syncMeta.getClockState();
  if (storedClock !== null) {
    clock.restore(storedClock);
  }

  const context = createMutationContext(clock);

  const selection =
    options.fileStore === undefined
      ? await selectBookFileStore()
      : { store: options.fileStore, fallbackReason: null };
  const persistentStorage =
    options.fileStore === undefined ? await requestPersistentStorage() : null;

  const books = new BookRepository(db, context);
  const progress = new ProgressRepository(db, context);
  const changes = new ChangeRepository(db);
  const deviceState = new DeviceStateRepository(db);
  const renderers = createRendererRegistry([
    {
      format: 'epub',
      support: 'experimental',
      engine: 'foliate-js 78914aef',
      create: () => new EpubRenderer(),
    },
    {
      format: 'pdf',
      support: 'experimental',
      engine: 'pdf.js 5.4.624',
      create: () => new PdfRenderer(),
    },
  ]);
  const persistClockState = async () => {
    const last = clock.last();
    if (last !== null) await syncMeta.setClockState(last);
  };

  return {
    db,
    books,
    progress,
    changes,
    deviceState,
    syncMeta,
    files: selection.store,
    imports: new ImportService({ db, books, progress, files: selection.store }),
    exports: new ExportService(db),
    renderers,
    reader: new ReaderService({
      books,
      progress,
      deviceState,
      files: selection.store,
      renderers,
      persistClock: persistClockState,
    }),
    clock,
    deviceId,
    storageWarning: selection.fallbackReason,
    persistentStorage,
    persistClockState,
  };
}
