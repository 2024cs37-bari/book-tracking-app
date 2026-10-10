import { createClock, type Clock } from '~/domain/hlc';
import { createDatabase, type LibraryDatabase } from '~/data/db';
import { createMutationContext } from '~/data/mutations';
import { BookRepository } from '~/data/repositories/book-repository';
import { ProgressRepository } from '~/data/repositories/progress-repository';
import { ChangeRepository } from '~/data/repositories/change-repository';
import { DeviceStateRepository } from '~/data/repositories/device-state-repository';
import { SyncMetaRepository } from '~/data/repositories/sync-meta-repository';
import { AnnotationRepository } from '~/data/repositories/annotation-repository';
import { ShelfRepository } from '~/data/repositories/shelf-repository';
import { TagRepository } from '~/data/repositories/tag-repository';
import { SessionRepository } from '~/data/repositories/session-repository';
import { createRendererRegistry, type RendererRegistry } from '~/reader/renderer';
import { requestPersistentStorage, selectBookFileStore } from '~/storage/create-file-store';
import type { BookFileStore } from '~/storage/file-store';
import { ImportService } from '~/services/import-service';
import { ExportService } from '~/services/export-service';
import { RestoreService } from '~/services/restore-service';
import { ReaderService } from '~/services/reader-service';
import { SyncEngine } from '~/sync/engine';
import { createHttpSyncTransport } from '~/sync/http-transport';
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
  readonly annotations: AnnotationRepository;
  readonly shelves: ShelfRepository;
  readonly tags: TagRepository;
  readonly sessions: SessionRepository;
  readonly files: BookFileStore;
  readonly imports: ImportService;
  readonly exports: ExportService;
  readonly restores: RestoreService;
  readonly renderers: RendererRegistry;
  readonly reader: ReaderService;
  readonly clock: Clock;
  readonly deviceId: string;
  /**
   * The sync engine, or null when no server URL is configured for this build
   * (the current default — Phase 3's server is not deployed yet). Gating here
   * keeps the UI honest and ensures no network work runs without a target.
   */
  readonly sync: SyncEngine | null;
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
  /** Sync server base URL; defaults to `VITE_SYNC_URL`. Empty disables sync. */
  readonly syncBaseUrl?: string;
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
  const annotations = new AnnotationRepository(db, context);
  const shelves = new ShelfRepository(db, context);
  const tags = new TagRepository(db, context);
  const sessions = new SessionRepository(db, context);
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

  const syncBaseUrl =
    options.syncBaseUrl ?? (import.meta.env.VITE_SYNC_URL as string | undefined) ?? '';
  const sync =
    syncBaseUrl.length > 0
      ? new SyncEngine({
          db,
          changes,
          syncMeta,
          clock,
          deviceId,
          transport: createHttpSyncTransport({ baseUrl: syncBaseUrl }),
          persistClock: persistClockState,
        })
      : null;

  return {
    db,
    books,
    progress,
    changes,
    deviceState,
    syncMeta,
    annotations,
    shelves,
    tags,
    sessions,
    files: selection.store,
    imports: new ImportService({ db, books, progress, files: selection.store }),
    exports: new ExportService(db),
    restores: new RestoreService(db),
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
    sync,
    storageWarning: selection.fallbackReason,
    persistentStorage,
    persistClockState,
  };
}
