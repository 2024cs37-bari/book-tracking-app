import { newId } from '~/domain/ids';
import { createClock } from '~/domain/hlc';
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
import { MemoryBookFileStore } from '~/storage/memory-file-store';
import { ImportService } from '~/services/import-service';

let databaseCounter = 0;

export interface TestHarness {
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
  readonly files: MemoryBookFileStore;
  readonly imports: ImportService;
  readonly deviceId: string;
  /** Moves the injected clock forward, e.g. to make timestamps distinguishable. */
  advanceTime(milliseconds: number): void;
  close(): Promise<void>;
}

/**
 * Builds a fully wired stack against a throwaway database.
 *
 * Each harness gets a unique database name so tests never observe one another's
 * writes, and the clock uses a controllable time source.
 */
export async function createHarness(options: { startTime?: number } = {}): Promise<TestHarness> {
  databaseCounter += 1;
  const db = createDatabase(`test-${databaseCounter}-${newId()}`);
  const deviceId = newId();
  let currentTime = options.startTime ?? 1_700_000_000_000;
  const clock = createClock({ deviceId, now: () => currentTime });
  const context = createMutationContext(clock);

  const files = new MemoryBookFileStore();
  const books = new BookRepository(db, context);
  const progress = new ProgressRepository(db, context);
  const changes = new ChangeRepository(db);
  const deviceState = new DeviceStateRepository(db);
  const syncMeta = new SyncMetaRepository(db);
  const annotations = new AnnotationRepository(db, context);
  const shelves = new ShelfRepository(db, context);
  const tags = new TagRepository(db, context);
  const sessions = new SessionRepository(db, context);
  const imports = new ImportService({ db, books, progress, files });

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
    files,
    imports,
    deviceId,
    advanceTime: (milliseconds: number) => {
      currentTime += milliseconds;
    },
    close: async () => {
      db.close();
      await db.delete();
    },
  };
}
