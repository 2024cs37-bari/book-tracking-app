import packageInfo from '../../package.json';
import {
  DB_LOCAL_VERSION,
  DB_SCHEMA_VERSION,
  type LibraryDatabase,
  type TransferState,
} from '~/data/db';
import type { BookFileStore, FileStoreKind } from '~/storage/file-store';
import type { BackgroundState, BackgroundStatus } from '~/sync/background';
import { downloadBackupBlob } from './export-service';

export const DIAGNOSTICS_FORMAT = 'book-reader-diagnostics';
const MIB = 1024 * 1024;
const STATES: readonly BackgroundState[] = [
  'idle',
  'running',
  'offline',
  'waiting',
  'paused',
  'auth-required',
  'error',
];
const TRANSFERS: readonly TransferState[] = [
  'queued',
  'running',
  'failed',
  'complete',
  'cancelled',
];
const coarseBytes = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.ceil(value / MIB) : null;
const safeTime = (value: unknown): string | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15
    ? new Date(value).toISOString()
    : null;

export interface DiagnosticReport {
  readonly format: typeof DIAGNOSTICS_FORMAT;
  readonly version: 1;
  readonly generatedAt: string;
  readonly app: {
    readonly version: string;
    readonly buildMode: 'development' | 'production' | 'test' | 'other';
    readonly localSchema: number;
    readonly wireSchema: number;
  };
  readonly storage: {
    readonly backend: FileStoreKind | 'unknown';
    readonly durable: boolean;
    readonly persistenceGranted: boolean | null;
    readonly usageMiB: number | null;
    readonly quotaMiB: number | null;
    readonly estimateAvailable: boolean;
  };
  readonly library: {
    readonly books: {
      readonly active: number;
      readonly archived: number;
      readonly deleted: number;
      readonly total: number;
    };
    readonly outbox: { readonly pending: number; readonly total: number };
    readonly transfers: Record<TransferState, number>;
  };
  readonly sync: {
    readonly configured: boolean;
    readonly state: BackgroundState | 'disabled';
    readonly lastMetadataSuccessAt: string | null;
  };
}

export interface DiagnosticsOptions {
  readonly db: LibraryDatabase;
  readonly files: BookFileStore;
  readonly persistentStorage: boolean | null;
  readonly syncConfigured: boolean;
  readonly syncStatus?: () => BackgroundStatus;
  readonly now?: () => number;
}

/** A strict allowlist: never serialize rows, settings, runtime error objects,
 * endpoint configuration, file keys, or account/device identifiers. */
export class DiagnosticsService {
  constructor(private readonly options: DiagnosticsOptions) {}

  async capture(): Promise<DiagnosticReport> {
    const { db, files } = this.options;
    const library = await db.transaction(
      'r',
      [db.books, db.changes, db.fileTransfers],
      async () => ({
        books: {
          active: await db.books.where('lifecycle').equals('active').count(),
          archived: await db.books.where('lifecycle').equals('archived').count(),
          deleted: await db.books.where('lifecycle').equals('deleted').count(),
          total: await db.books.count(),
        },
        outbox: {
          pending: await db.changes.where('pushedAt').equals(0).count(),
          total: await db.changes.count(),
        },
        transfers: Object.fromEntries(
          await Promise.all(
            TRANSFERS.map(async (state) => [
              state,
              await db.fileTransfers.where('state').equals(state).count(),
            ]),
          ),
        ) as Record<TransferState, number>,
      }),
    );
    const estimate = await files.estimate().catch(() => null);
    const saved = await db.syncMeta.get('background_last_success');
    const status = this.options.syncStatus?.();
    const mode = import.meta.env.MODE;
    return {
      format: DIAGNOSTICS_FORMAT,
      version: 1,
      generatedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
      app: {
        version: packageInfo.version,
        buildMode: ['development', 'production', 'test'].includes(mode)
          ? (mode as 'development' | 'production' | 'test')
          : 'other',
        localSchema: DB_LOCAL_VERSION,
        wireSchema: DB_SCHEMA_VERSION,
      },
      storage: {
        backend: ['opfs', 'indexeddb', 'memory', 'native'].includes(files.kind)
          ? files.kind
          : 'unknown',
        durable: files.durable === true,
        persistenceGranted:
          typeof estimate?.persisted === 'boolean'
            ? estimate.persisted
            : this.options.persistentStorage,
        usageMiB: coarseBytes(estimate?.usageBytes),
        quotaMiB: coarseBytes(estimate?.quotaBytes),
        estimateAvailable: estimate !== null,
      },
      library,
      sync: {
        configured: this.options.syncConfigured,
        state: !this.options.syncConfigured
          ? 'disabled'
          : status && STATES.includes(status.state)
            ? status.state
            : 'idle',
        lastMetadataSuccessAt: safeTime(
          status?.lastSuccessAt ?? (saved ? Number(saved.value) : undefined),
        ),
      },
    };
  }
  async blob(): Promise<Blob> {
    return new Blob([JSON.stringify(await this.capture(), null, 2)], { type: 'application/json' });
  }
  async download(): Promise<void> {
    await downloadBackupBlob(await this.blob(), 'book-reader-diagnostics.json');
  }
}
